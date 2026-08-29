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
db.pragma('cache_size = -16000');       // ~16 MB page cache
db.pragma('mmap_size = 67108864');      // 64 MB — kept modest so mapped pages
                                        // don't inflate RSS against the host's
                                        // per-account memory limit
db.pragma('temp_store = MEMORY');
db.pragma('journal_size_limit = 67108864'); // cap the WAL at 64 MB after checkpoint

// Keep PRAGMA optimize's analysis bounded so it never turns into a minutes-long
// full ANALYZE of a mult-GB table at startup.
db.pragma('analysis_limit = 400');

// Passive WAL checkpoints get starved when the dashboard is polling constantly,
// so the WAL can grow into the hundreds of MB. Force a truncating checkpoint
// and refresh the query planner's stats on a slow timer.
setInterval(() => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('optimize');
  } catch { /* a checkpoint that can't get the lock this round is harmless */ }
}, 5 * 60 * 1000).unref();
db.pragma('optimize'); // also run once at startup

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
`);

// Bigger covering indexes that make the dashboard aggregates fast. On a large
// existing DB, building these can take a minute or two, so they're created
// AFTER the server is already listening (see startup) rather than blocking boot.
// Every query still works without them — just slower until they finish.
const DEFERRED_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_type_session ON events(event_type, session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_timestamp    ON events(timestamp)`,
  // COUNT(DISTINCT anonymous_id) for "Unique Users" — covering index scan.
  `CREATE INDEX IF NOT EXISTS idx_anon         ON events(anonymous_id)`,
  // Per-app leaderboard: GROUP BY app_slug with COUNT(*), COUNT(DISTINCT
  // session_id / anonymous_id) and purchase counts — all columns in one ordered
  // index makes it a covering scan. Also serves the per-app funnel steps.
  `CREATE INDEX IF NOT EXISTS idx_app_cover ON events(app_slug, event_type, session_id, anonymous_id)`,
  `DROP INDEX IF EXISTS idx_app_type_session`,
  // Avg-time-per-screen reads screen_name + duration_ms for screen_exited rows.
  `CREATE INDEX IF NOT EXISTS idx_screenexit ON events(event_type, screen_name, duration_ms)`,
  // DISTINCT platform for the filter dropdown was a full table scan.
  `CREATE INDEX IF NOT EXISTS idx_platform ON events(platform)`,
];

function buildDeferredIndexes(i = 0) {
  if (i >= DEFERRED_INDEXES.length) {
    try { db.pragma('optimize'); } catch {}
    indexesReady = true;
    console.log('   dashboard indexes ready');
    warmStats();
    return;
  }
  const stmt = DEFERRED_INDEXES[i];
  try {
    const t0 = Date.now();
    db.exec(stmt); // this one statement blocks the loop; the gap between ticks lets ingest through
    const ms = Date.now() - t0;
    if (ms > 200) console.log(`   index ${stmt.split(' ')[4] || ''} (${(ms / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.error('deferred index failed:', stmt, e.message);
  }
  setTimeout(() => buildDeferredIndexes(i + 1), 250);
}
let indexesReady = false;

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
// gzip everything — the /api/stats and /api/errors JSON compresses ~5–10x,
// which matters on a slow mobile connection to the host.
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
  if (inserted > 0) { statsEpoch++; totalEvents += inserted; }

  res.json({ received: inserted });
});

// ── Dashboard API ─────────────────────────────────────────────────────────────

// `SELECT COUNT(*)` over the whole (multi-GB) table was one of the full scans on
// every dashboard load. Count once at startup, then keep it current from ingest.
let totalEvents = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
let statsEpoch = 0; // bumped on every ingest

// Stale-while-revalidate cache for /api/stats. The aggregate queries are heavy
// on a large DB (and better-sqlite3 is synchronous, so every one blocks the
// event loop). Serving the last computed payload instantly and refreshing it in
// the background means a dashboard poll never waits on a full recompute — the
// only synchronous computes are the very first one for a filter combo and the
// background refreshes, which are debounced to once per FRESH_MS.
const statsCache = new Map(); // key -> { at, epoch, body, refreshing }
const FRESH_MS = 20000;

function statsKeyOf(appSlug, platform, days) {
  return `${appSlug || ''}|${platform || ''}|${days}`;
}

function getStats(appSlug, platform, days) {
  const key = statsKeyOf(appSlug, platform, days);
  const entry = statsCache.get(key);
  const stale = !entry || entry.epoch !== statsEpoch || Date.now() - entry.at > FRESH_MS;

  if (entry && !stale) return entry.body;
  if (entry && stale) {
    // Serve what we have now, recompute off the request path.
    if (!entry.refreshing) {
      entry.refreshing = true;
      setImmediate(() => {
        try {
          const body = computeStats(appSlug, platform, days);
          statsCache.set(key, { at: Date.now(), epoch: statsEpoch, body });
        } catch (e) {
          console.error('stats refresh failed', e);
          entry.refreshing = false;
        }
      });
    }
    return entry.body;
  }
  // No cached value at all — compute synchronously this once.
  const body = computeStats(appSlug, platform, days);
  statsCache.set(key, { at: Date.now(), epoch: statsEpoch, body });
  if (statsCache.size > 48) {
    // drop the oldest few so a spray of filter combos can't grow this forever
    const keys = [...statsCache.keys()].slice(0, 8);
    for (const k of keys) if (k !== key) statsCache.delete(k);
  }
  return body;
}

app.get('/api/stats', (req, res) => {
  const appSlug  = req.query.app_slug || null;
  const platform = req.query.platform || null;
  const days     = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
  res.json(getStats(appSlug, platform, days));
});

// Keep the common views (last 14d / 30d, all apps) warm so the first visitor
// after an idle period isn't the one to pay for a synchronous recompute. Held
// off until the dashboard indexes exist — before that a compute is a slow table
// scan and not worth blocking the loop for on a timer.
function warmStats() {
  if (!indexesReady) return;
  try {
    getStats(null, null, 14);
    getStats(null, null, 30);
  } catch (e) { console.error('warmStats failed', e); }
}

function computeStats(appSlug, platform, days) {
  // Both filters are optional and independent ("all apps" / "all platforms"),
  // so build the WHERE clause from whichever ones are actually set.
  const filters = [];
  const args    = [];
  if (appSlug)  { filters.push('app_slug = ?');  args.push(appSlug); }
  if (platform) { filters.push('platform = ?');  args.push(platform); }
  const where     = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const andClause = filters.length ? `AND ${filters.join(' AND ')}`   : '';

  const total = (!appSlug && !platform)
    ? totalEvents
    : db.prepare(`SELECT COUNT(*) as n FROM events ${where}`).get(...args).n;
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

  // Daily time series for the last `days` days (UTC-bucketed via substr on the
  // ISO timestamp). Aggregated in SQL: pulling every event row in the window
  // into JS to build Sets was millions of rows on the production DB and was the
  // single biggest driver of the dashboard's memory use and cold-load latency.
  const dayAggRows = db.prepare(`
    SELECT substr(timestamp,1,10) AS day,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(DISTINCT CASE WHEN event_type = 'purchase' THEN session_id END) AS purchaseSessions
    FROM events
    WHERE timestamp >= datetime('now', ?)
    ${andClause}
    GROUP BY day
  `).all(`-${days} days`, ...args);

  // Per-day revenue needs the `value` from each purchase's JSON blob, but only
  // for purchase rows in the window (a small slice), so it's its own small query.
  const dayRevenueRows = db.prepare(`
    SELECT substr(timestamp,1,10) AS day, properties
    FROM events
    WHERE event_type = 'purchase' AND timestamp >= datetime('now', ?)
    ${andClause}
  `).all(`-${days} days`, ...args);

  const byDay = {};
  const todayUTC = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayUTC);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    byDay[key] = { day: key, sessions: 0, purchaseSessions: 0, revenue: 0 };
  }
  for (const r of dayAggRows) {
    const b = byDay[r.day];
    if (!b) continue;
    b.sessions = r.sessions;
    b.purchaseSessions = r.purchaseSessions;
  }
  for (const r of dayRevenueRows) {
    const b = byDay[r.day];
    if (!b) continue;
    const v = Number(parseProps(r.properties).value);
    if (!Number.isNaN(v)) b.revenue += v;
  }
  const daily = Object.values(byDay).map(b => ({
    day: b.day,
    sessions: b.sessions,
    purchases: b.purchaseSessions,
    conversionRate: b.sessions > 0 ? (b.purchaseSessions / b.sessions) * 100 : 0,
    revenue: Math.round(b.revenue * 100) / 100,
  }));

  // Errors are no longer part of this payload — they have their own endpoint
  // (/api/errors) with proper grouping, filtering and pagination.

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

  return {
    total, sessions, users, byType, screenTime, funnel, purchaseSessions, conversionRate,
    revenue: Math.round(revenue * 100) / 100,
    aov: Math.round(aov * 100) / 100,
    days, daily, perApp,
    recent, apps, platforms,
  };
}

// ── Errors API ────────────────────────────────────────────────────────────────
// Its own endpoint so the (large) error volume never weighs down /api/stats.
// Returns: totals by type, a grouped breakdown by error signature (most
// frequent first, with a sample + first/last seen), and a paginated raw list.

app.get('/api/errors', (req, res) => {
  const appSlug  = req.query.app_slug || null;
  const platform = req.query.platform || null;
  const days     = req.query.days ? Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365) : null;
  const limit    = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset   = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const typeFilter = req.query.type && ERROR_EVENT_TYPES.includes(req.query.type) ? req.query.type : null;

  const filters = [`event_type IN (${ERROR_EVENT_TYPES.map(() => '?').join(',')})`];
  const args    = [...ERROR_EVENT_TYPES];
  if (appSlug)    { filters.push('app_slug = ?'); args.push(appSlug); }
  if (platform)   { filters.push('platform = ?'); args.push(platform); }
  if (typeFilter) { filters.push('event_type = ?'); args.push(typeFilter); }
  if (days)       { filters.push(`timestamp >= datetime('now', ?)`); args.push(`-${days} days`); }
  const where = `WHERE ${filters.join(' AND ')}`;

  const totalMatching = db.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).get(...args).n;

  const byType = db.prepare(`
    SELECT event_type, COUNT(*) AS count
    FROM events ${where}
    GROUP BY event_type ORDER BY count DESC
  `).all(...args);

  // Signature-grouped breakdown. The signature (a readable one-liner) is derived
  // in JS from the properties blob, so we pull a bounded recent-ish window of
  // rows to group rather than every error ever. `groupScan` caps that work.
  const groupScan = 5000;
  const scanRows = db.prepare(`
    SELECT id, timestamp, app_slug, platform, event_type, properties
    FROM events ${where}
    ORDER BY id DESC LIMIT ${groupScan}
  `).all(...args);

  const groups = new Map();
  for (const r of scanRows) {
    const props = parseProps(r.properties);
    const signature = summarizeError(r.event_type, props);
    let g = groups.get(signature);
    if (!g) {
      g = { signature, event_type: r.event_type, count: 0,
            firstSeen: r.timestamp, lastSeen: r.timestamp, apps: new Set(), sample: props };
      groups.set(signature, g);
    }
    g.count++;
    if (r.timestamp < g.firstSeen) g.firstSeen = r.timestamp;
    if (r.timestamp > g.lastSeen)  g.lastSeen = r.timestamp;
    if (r.app_slug) g.apps.add(r.app_slug);
  }
  const grouped = [...groups.values()]
    .map(g => ({ ...g, apps: [...g.apps].slice(0, 8), appCount: g.apps.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 100);

  const rows = db.prepare(`
    SELECT id, timestamp, app_slug, platform, event_type, app_version, os_version, properties
    FROM events ${where}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  const list = rows.map(r => {
    const props = parseProps(r.properties);
    return {
      id: r.id, timestamp: r.timestamp, app_slug: r.app_slug, platform: r.platform,
      event_type: r.event_type, app_version: r.app_version, os_version: r.os_version,
      summary: summarizeError(r.event_type, props), properties: props,
    };
  });

  const apps = db.prepare(`SELECT DISTINCT app_slug FROM events WHERE app_slug IS NOT NULL ORDER BY app_slug`).all().map(r => r.app_slug);
  const platforms = db.prepare(`SELECT DISTINCT platform FROM events WHERE platform IS NOT NULL ORDER BY platform`).all().map(r => r.platform);

  res.json({
    total: totalMatching,
    byType,
    grouped,
    groupedFrom: scanRows.length,
    groupScan,
    list,
    limit, offset,
    days: days || null,
    apps, platforms,
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
  console.log(`   Endpoint:  http://localhost:${PORT}/api/v1/events  (no auth required)`);
  console.log(`   DB: ${path.join(dbDir, 'analytics.sqlite')}  (${totalEvents.toLocaleString()} events, journal_mode=${db.pragma('journal_mode', { simple: true })})\n`);

  // Build the heavy covering indexes in the background (one per tick so ingest
  // keeps flowing), then warm the common dashboard views and keep them warm.
  setTimeout(() => buildDeferredIndexes(0), 1500);
  setInterval(warmStats, FRESH_MS).unref();
});
