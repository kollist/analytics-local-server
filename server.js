'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

// ── Database setup ────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'analytics.sqlite'));

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
    try { sub.res.write(data); } catch { subscribers.delete(sub); }
  }
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
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

  res.json({ received: inserted });
});

// ── Dashboard API ─────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const appSlug = req.query.app_slug || null;
  const where   = appSlug ? 'WHERE app_slug = ?' : '';
  const args    = appSlug ? [appSlug] : [];

  const total    = db.prepare(`SELECT COUNT(*) as n FROM events ${where}`).get(...args).n;
  const sessions = db.prepare(`SELECT COUNT(DISTINCT session_id) as n FROM events ${where}`).get(...args).n;
  const users    = db.prepare(`SELECT COUNT(DISTINCT anonymous_id) as n FROM events ${where}`).get(...args).n;

  const byType = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM events ${where}
    GROUP BY event_type ORDER BY count DESC LIMIT 20
  `).all(...args);

  const screenTime = db.prepare(`
    SELECT screen_name,
           ROUND(AVG(duration_ms)/1000.0, 1) as avg_sec,
           COUNT(*) as views
    FROM events
    WHERE event_type = 'screen_exit' AND screen_name IS NOT NULL AND duration_ms IS NOT NULL
    ${appSlug ? 'AND app_slug = ?' : ''}
    GROUP BY screen_name ORDER BY avg_sec DESC
  `).all(...args);

  const funnel = db.prepare(`
    SELECT screen_name, COUNT(DISTINCT session_id) as sessions
    FROM events
    WHERE event_type = 'screen_enter' AND screen_name IN (
      'Splash','Login','Signup','Home','Categories',
      'ProductList','ProductDetail','Cart','Checkout'
    )
    ${appSlug ? 'AND app_slug = ?' : ''}
    GROUP BY screen_name
  `).all(...args);

  const purchaseSessions = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as n FROM events
    WHERE event_type = 'purchase'
    ${appSlug ? 'AND app_slug = ?' : ''}
  `).get(...args).n;

  // "OrderPlaced" funnel step is driven by the purchase event, not a screen_enter
  // — the OrderPlaced screen doesn't always fire reliably.
  funnel.push({ screen_name: 'OrderPlaced', sessions: purchaseSessions });

  const conversionRate = sessions > 0 ? (purchaseSessions / sessions) * 100 : 0;

  const recent = db.prepare(`
    SELECT * FROM events ${where} ORDER BY id DESC LIMIT 100
  `).all(...args);

  const apps = db.prepare(`
    SELECT DISTINCT app_slug FROM events WHERE app_slug IS NOT NULL ORDER BY app_slug
  `).all().map(r => r.app_slug);

  res.json({ total, sessions, users, byType, screenTime, funnel, purchaseSessions, conversionRate, recent, apps });
});

// ── SSE stream ────────────────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.flushHeaders();
  const sub = { res, appSlug: req.query.app_slug || null };
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
