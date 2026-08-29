'use strict';

const express = require('express');
const compression = require('compression');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ── Database setup ────────────────────────────────────────────────────────────
// Auto-deploy on the host wipes this directory's untracked files on every
// push (it's a git working tree, not just a plain deploy target), which
// takes analytics.sqlite with it. If an `analytics-data/` directory exists
// somewhere above this repo (outside the git working tree, so deploys never
// touch it), the database lives there instead — see the deploy README for
// how that directory is set up on the host. Falls back to __dirname so local
// dev / a fresh clone still works with zero setup.
//
// Some hosts (e.g. Hostinger's Node.js auto-deploy) don't deploy straight
// into a fixed directory — every push builds a fresh versioned folder several
// levels deep (.../hbuilds/versions/<uuid>/nodejs) and symlinks the live app
// at it. A single ".." wouldn't find `analytics-data` there, so walk up a
// handful of ancestor levels instead of checking only the immediate parent.
function findPersistentDir(startDir) {
  let dir = path.dirname(startDir);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'analytics-data');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}
const dbDir = findPersistentDir(__dirname) || __dirname;
const db = new Database(path.join(dbDir, 'analytics.sqlite'));

// Performance pragmas. The dashboard fires ~20 aggregate scans per /api/stats
// call and the ingest endpoint writes concurrently; WAL lets readers and the
// writer run without blocking each other, and the larger cache / mmap keep the
// repeated full-table scans off the (often slow, shared) host disk.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -16000');   // ~16 MB page cache
db.pragma('mmap_size = 134217728'); // 128 MB
db.pragma('temp_store = MEMORY');

// Batch-payload schema (app_slug + platform, device_model now optional).
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     TEXT UNIQUE NOT NULL,
    app_slug     TEXT,
    platform     TEXT,
    user_id      TEXT,
    anonymous_id TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    screen_name  TEXT,
    duration_ms  INTEGER,
    properties   TEXT,
    timestamp    TEXT NOT NULL,
    app_version  TEXT,
    os_version   TEXT,
    received_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_app_slug ON events(app_slug);
  CREATE INDEX IF NOT EXISTS idx_type     ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_screen   ON events(screen_name);
  CREATE INDEX IF NOT EXISTS idx_session  ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_received ON events(received_at);
  -- The funnel and per-app leaderboard both do COUNT(DISTINCT session_id)
  -- filtered by event_type (and often app_slug); this covering index lets
  -- those run straight off the index instead of scanning the whole table.
  CREATE INDEX IF NOT EXISTS idx_app_type_session ON events(app_slug, event_type, session_id);
  CREATE INDEX IF NOT EXISTS idx_type_session     ON events(event_type, session_id);
  CREATE INDEX IF NOT EXISTS idx_timestamp        ON events(timestamp);
`);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events
    (event_id, app_slug, platform, user_id, anonymous_id, session_id, event_type, screen_name,
     duration_ms, properties, timestamp, app_version, os_version)
  VALUES
    (@event_id, @app_slug, @platform, @user_id, @anonymous_id, @session_id, @event_type, @screen_name,
     @duration_ms, @properties, @timestamp, @app_version, @os_version)
`);

// ── SSE subscribers ───────────────────────────────────────────────────────────

const subscribers = new Set();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const sub of subscribers) {
    if (sub.appSlug && sub.appSlug !== event.app_slug) continue;
    if (sub.platform && sub.platform !== event.platform) continue;
    try { sub.res.write(data); } catch { subscribers.delete(sub); }
  }
}

// ── Shared parsing helpers ────────────────────────────────────────────────────

function parseProps(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// One human-readable line per error event, built from the properties each call
// site actually sends (see AnalyticsTracker.swift / AppDelegate.swift / ATCNetworkingManager.swift).
const ERROR_EVENT_TYPES = ['app_error', 'order_place_failed', 'login_failed'];

function summarizeError(eventType, props) {
  if (eventType === 'app_error') {
    if (props.type === 'crash') {
      const reason = String(props.reason || '').slice(0, 160);
      return `Crash — ${props.name || 'Unknown'}${reason ? ': ' + reason : ''}`;
    }
    if (props.type === 'network') {
      const where = [props.method, props.endpoint].filter(Boolean).join(' ');
      const extra = props.message ? ` — ${props.message}` : (props.code ? ` — code ${props.code}` : '');
      return `Network — ${where}${extra}`;
    }
    return 'App error';
  }
  if (eventType === 'order_place_failed') {
    return `Order failed — [${props.code ?? '?'}] ${props.message || ''}`.trim();
  }
  if (eventType === 'login_failed') {
    return `Login failed — code ${props.code ?? '?'} (${props.from_backend ? 'server' : 'client'})`;
  }
  return eventType;
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
// gzip everything — the /api/stats JSON (recent + errors + per-app + daily
// series) compresses ~5–10x, which is the difference between instant and
// several seconds on a slow mobile connection to the host.
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Ingest endpoint ───────────────────────────────────────────────────────────
// Accepts the AnalyticsTracker batch payload:
// { app_slug, app_version, device_id, session_id, user_id, platform, os_version,
//   events: [{ name, timestamp, params }] }

app.post('/api/v1/events', (req, res) => {
  const { app_slug, app_version, device_id, session_id, user_id, platform, os_version, events } = req.body;

  if (typeof app_slug !== 'string' || !app_slug ||
      typeof device_id !== 'string' || !device_id ||
      typeof session_id !== 'string' || !session_id ||
      !Array.isArray(events)) {
    return res.status(400).json({ error: 'Invalid batch' });
  }

  let inserted = 0;
  const insertMany = db.transaction((evts) => {
    for (const e of evts) {
      if (typeof e.name !== 'string' || !e.name) continue;
      if (typeof e.timestamp !== 'number' && typeof e.timestamp !== 'string') continue;

      const params = { ...(e.params || {}) };
      const screen_name = params.screen_name ?? null;
      const duration_ms = params.duration_ms ?? null;
      delete params.screen_name;
      delete params.duration_ms;

      const row = {
        event_id:     `${device_id}-${session_id}-${e.timestamp}-${e.name}-${inserted}`,
        app_slug,
        platform:     platform ?? null,
        user_id:      user_id ?? null,
        anonymous_id: device_id,
        session_id,
        event_type:   e.name,
        screen_name,
        duration_ms,
        properties:   Object.keys(params).length ? JSON.stringify(params) : null,
        timestamp:    new Date(Number(e.timestamp)).toISOString(),
        app_version:  app_version ?? null,
        os_version:   os_version ?? null,
      };
      insertEvent.run(row);
      inserted++;
      broadcast(row);
    }
  });
  insertMany(events);
  if (inserted > 0) statsEpoch++; // invalidate the dashboard stats cache

  res.json({ received: inserted });
});

// ── Dashboard API ─────────────────────────────────────────────────────────────

// Short-lived response cache. Every dashboard tab re-requests /api/stats every
// 10s and they all get identical data for a given (app, platform, days) combo,
// so computing it more than once per few seconds is wasted work on the host.
// The cache is dropped whenever new events arrive, so numbers never lag real
// data by more than one ingest batch.
const statsCache = new Map(); // key -> { at, body }
const STATS_TTL_MS = 8000;
let statsEpoch = 0; // bumped on every ingest; part of the cache key

app.get('/api/stats', (req, res) => {
  const appSlug  = req.query.app_slug || null;
  const platform = req.query.platform || null;
  const daysRaw  = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);

  const cacheKey = `${statsEpoch}|${appSlug}|${platform}|${daysRaw}`;
  const hit = statsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) {
    return res.json(hit.body);
  }
  const sendJson = (body) => {
    statsCache.set(cacheKey, { at: Date.now(), body });
    if (statsCache.size > 64) statsCache.clear(); // bounded; keys churn on ingest anyway
    res.json(body);
  };

  // Both filters are optional and independent ("all apps" / "all platforms"),
  // so build the WHERE clause from whichever ones are actually set.
  const filters = [];
  const args    = [];
  if (appSlug)  { filters.push('app_slug = ?');  args.push(appSlug); }
  if (platform) { filters.push('platform = ?');  args.push(platform); }
  const where     = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const andClause = filters.length ? `AND ${filters.join(' AND ')}`   : '';
  const days    = daysRaw;

  const total    = db.prepare(`SELECT COUNT(*) as n FROM events ${where}`).get(...args).n;
  const sessions = db.prepare(`SELECT COUNT(DISTINCT session_id) as n FROM events ${where}`).get(...args).n;
  const users    = db.prepare(`SELECT COUNT(DISTINCT anonymous_id) as n FROM events ${where}`).get(...args).n;

  const byType = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM events ${where}
    GROUP BY event_type ORDER BY count DESC
  `).all(...args);

  const screenTime = db.prepare(`
    SELECT screen_name,
           ROUND(AVG(duration_ms)/1000.0, 1) as avg_sec,
           COUNT(*) as views
    FROM events
    WHERE event_type = 'screen_exited' AND screen_name IS NOT NULL AND duration_ms IS NOT NULL
    ${andClause}
    GROUP BY screen_name ORDER BY avg_sec DESC
  `).all(...args);

  // Event-based ordering funnel: distinct sessions that fired each step event.
  // Action events are more reliable than screen views (the new checkout doesn't
  // always emit screen_entered), so we measure conversion off the events themselves.
  const FUNNEL_STEPS = [
    'view_item_list', 'view_item', 'add_to_cart',
    'begin_checkout', 'place_order_tapped', 'purchase',
  ];
  const stepStmt = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as n FROM events
    WHERE event_type = ?
    ${andClause}
  `);
  const funnel = FUNNEL_STEPS.map((step, i) => {
    const stepSessions = stepStmt.get(step, ...args).n;
    return { step, sessions: stepSessions };
  }).map((row, i, arr) => {
    // % of the very first step (overall reach) and % of the previous step (the
    // actual conversion of that specific transition) — the funnel widget needs both.
    const first = arr[0].sessions;
    const prev  = i > 0 ? arr[i - 1].sessions : row.sessions;
    return {
      ...row,
      pctOfFirst:    first > 0 ? (row.sessions / first) * 100 : 0,
      pctOfPrevious: i > 0 ? (prev > 0 ? (row.sessions / prev) * 100 : 0) : 100,
    };
  });

  const purchaseSessions = funnel[funnel.length - 1].sessions;
  const conversionRate = sessions > 0 ? (purchaseSessions / sessions) * 100 : 0;

  // Revenue / AOV — `value` lives inside the purchase event's JSON properties
  // blob (see AnalyticsTracker "purchase" call sites), so it's summed in JS
  // rather than in SQL.
  const purchaseRows = db.prepare(`
    SELECT properties FROM events
    WHERE event_type = 'purchase' ${andClause}
  `).all(...args);
  let revenue = 0;
  for (const r of purchaseRows) {
    const v = Number(parseProps(r.properties).value);
    if (!Number.isNaN(v)) revenue += v;
  }
  const aov = purchaseRows.length > 0 ? revenue / purchaseRows.length : 0;

  // Daily time series for the last `days` days (UTC-bucketed, matching the
  // ISO timestamps written at ingest time). Missing days are filled with zeros
  // so the chart always spans the full requested window.
  const dayRows = db.prepare(`
    SELECT substr(timestamp,1,10) as day, session_id, event_type, properties
    FROM events
    WHERE timestamp >= datetime('now', ?)
    ${andClause}
  `).all(`-${days} days`, ...args);

  const byDay = {};
  const todayUTC = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUTC);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    byDay[key] = { day: key, sessions: new Set(), purchaseSessions: new Set(), revenue: 0 };
  }
  for (const r of dayRows) {
    const bucket = byDay[r.day];
    if (!bucket) continue;
    bucket.sessions.add(r.session_id);
    if (r.event_type === 'purchase') {
      bucket.purchaseSessions.add(r.session_id);
      const v = Number(parseProps(r.properties).value);
      if (!Number.isNaN(v)) bucket.revenue += v;
    }
  }
  const daily = Object.values(byDay).map(b => ({
    day: b.day,
    sessions: b.sessions.size,
    purchases: b.purchaseSessions.size,
    conversionRate: b.sessions.size > 0 ? (b.purchaseSessions.size / b.sessions.size) * 100 : 0,
    revenue: Math.round(b.revenue * 100) / 100,
  }));

  // Errors — individual rows with a readable summary (not just a bare count),
  // most recent first, so "app_error x12" becomes an actual, scannable list.
  const errorPlaceholders = ERROR_EVENT_TYPES.map(() => '?').join(',');
  const errorRows = db.prepare(`
    SELECT * FROM events
    WHERE event_type IN (${errorPlaceholders})
    ${andClause}
    ORDER BY id DESC LIMIT 100
  `).all(...ERROR_EVENT_TYPES, ...args);
  const errors = errorRows.map(r => {
    const props = parseProps(r.properties);
    return {
      id: r.id,
      timestamp: r.timestamp,
      app_slug: r.app_slug,
      event_type: r.event_type,
      summary: summarizeError(r.event_type, props),
      properties: props,
    };
  });

  const recent = db.prepare(`
    SELECT * FROM events ${where} ORDER BY id DESC LIMIT 50
  `).all(...args);

  const apps = db.prepare(`
    SELECT DISTINCT app_slug FROM events WHERE app_slug IS NOT NULL ORDER BY app_slug
  `).all().map(r => r.app_slug);

  // Per-app leaderboard — every app side by side so you can see which one leads
  // on sessions, orders, conversion, revenue. Respects the platform filter (so
  // it reconciles with the KPI cards) but never the app filter, and — like the
  // KPI cards — spans all time rather than the trend window.
  const platformOnly = platform ? 'AND platform = ?' : '';
  const platformArgs = platform ? [platform] : [];

  const perAppRows = db.prepare(`
    SELECT app_slug,
           COUNT(*)                                                              AS events,
           COUNT(DISTINCT session_id)                                            AS sessions,
           COUNT(DISTINCT anonymous_id)                                          AS users,
           COUNT(DISTINCT CASE WHEN event_type = 'purchase' THEN session_id END) AS purchaseSessions,
           SUM(CASE WHEN event_type = 'purchase' THEN 1 ELSE 0 END)              AS orders
    FROM events
    WHERE app_slug IS NOT NULL ${platformOnly}
    GROUP BY app_slug
  `).all(...platformArgs);

  const perAppRevenue = {};
  for (const r of db.prepare(`
    SELECT app_slug, properties FROM events
    WHERE event_type = 'purchase' AND app_slug IS NOT NULL ${platformOnly}
  `).all(...platformArgs)) {
    const v = Number(parseProps(r.properties).value);
    if (!Number.isNaN(v)) perAppRevenue[r.app_slug] = (perAppRevenue[r.app_slug] || 0) + v;
  }

  const perApp = perAppRows.map(r => {
    const rev = perAppRevenue[r.app_slug] || 0;
    return {
      app_slug: r.app_slug,
      events: r.events,
      sessions: r.sessions,
      users: r.users,
      orders: r.orders,
      conversionRate: r.sessions > 0 ? (r.purchaseSessions / r.sessions) * 100 : 0,
      revenue: Math.round(rev * 100) / 100,
      aov: r.orders > 0 ? Math.round((rev / r.orders) * 100) / 100 : 0,
    };
  }).sort((a, b) => b.sessions - a.sessions);

  // Unfiltered so the platform dropdown always lists every platform ever seen,
  // not just the ones left over after the current filters are applied.
  const platforms = db.prepare(`
    SELECT DISTINCT platform FROM events WHERE platform IS NOT NULL ORDER BY platform
  `).all().map(r => r.platform);

  sendJson({
    total, sessions, users, byType, screenTime, funnel, purchaseSessions, conversionRate,
    revenue: Math.round(revenue * 100) / 100,
    aov: Math.round(aov * 100) / 100,
    days, daily, errors, perApp,
    recent, apps, platforms,
  });
});

// ── SSE stream ────────────────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.flushHeaders();
  const sub = { res, appSlug: req.query.app_slug || null, platform: req.query.platform || null };
  subscribers.add(sub);
  req.on('close', () => subscribers.delete(sub));
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Analytics local server running`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Endpoint:  http://localhost:${PORT}/api/v1/events  (no auth required)\n`);
});
