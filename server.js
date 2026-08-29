'use strict';

const express = require('express');
const compression = require('compression');
const Database = require('better-sqlite3');
const { Worker } = require('worker_threads');
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
    warmCaches();
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
let statsEpoch = 0; // bumped on every ingest; marks the caches below stale

// ── Aggregation worker ───────────────────────────────────────────────────────
// The /api/stats and /api/errors queries take seconds on a DB this size, and
// better-sqlite3 is synchronous — running them here would freeze HTTP handling
// and event ingest for the duration. They run in a worker thread instead; this
// process only ever hands back the cached JSON, so a dashboard request never
// waits on SQLite regardless of how loaded the host is.

let worker = null;
const workerJobs = new Map(); // id -> { resolve, reject, timer }
let workerSeq = 0;

function startWorker() {
  worker = new Worker(path.join(__dirname, 'analytics-worker.js'), { workerData: { dbDir } });
  worker.on('message', ({ id, ok, result, error }) => {
    const job = workerJobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    workerJobs.delete(id);
    ok ? job.resolve(result) : job.reject(new Error(error || 'worker error'));
  });
  worker.on('error', (e) => console.error('worker error:', e.message));
  worker.on('exit', (code) => {
    for (const job of workerJobs.values()) { clearTimeout(job.timer); job.reject(new Error('worker exited')); }
    workerJobs.clear();
    if (code !== 0) { console.error(`worker exited (${code}); restarting in 1s`); setTimeout(startWorker, 1000); }
  });
}

function askWorker(kind, params) {
  return new Promise((resolve, reject) => {
    if (!worker) return reject(new Error('worker not started'));
    const id = ++workerSeq;
    const timer = setTimeout(() => {
      if (workerJobs.has(id)) { workerJobs.delete(id); reject(new Error('worker timeout')); }
    }, 60000);
    workerJobs.set(id, { resolve, reject, timer });
    worker.postMessage({ id, kind, params });
  });
}

// Stale-while-revalidate cache in front of the worker. A request is answered
// from cache immediately; if the entry is stale a single background refresh is
// kicked off. Only the very first request for a key waits on the worker, and
// concurrent first-requests are coalesced onto one job.
const respCache = new Map(); // key -> { at, epoch, body }
const pending   = new Map(); // key -> Promise
const FRESH_MS  = 15000;

function cacheKey(kind, o) {
  return [kind, o.appSlug || '', o.platform || '', o.days || '', o.type || '', o.limit || '', o.offset || ''].join('|');
}

function getCached(kind, params) {
  const key = cacheKey(kind, params);
  const entry = respCache.get(key);

  if (entry) {
    const stale = entry.epoch !== statsEpoch || Date.now() - entry.at > FRESH_MS;
    if (stale && !pending.has(key)) {
      const p = askWorker(kind, params)
        .then(body => { respCache.set(key, { at: Date.now(), epoch: statsEpoch, body }); return body; })
        .catch(e => console.error(`${kind} refresh:`, e.message))
        .finally(() => pending.delete(key));
      pending.set(key, p);
    }
    return Promise.resolve(entry.body);
  }

  if (pending.has(key)) return pending.get(key);
  const p = askWorker(kind, params)
    .then(body => {
      respCache.set(key, { at: Date.now(), epoch: statsEpoch, body });
      if (respCache.size > 60) {
        for (const k of [...respCache.keys()].slice(0, 10)) if (k !== key) respCache.delete(k);
      }
      return body;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

app.get('/api/stats', async (req, res) => {
  const params = {
    appSlug: req.query.app_slug || null,
    platform: req.query.platform || null,
    days: Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90),
    totalEvents,
  };
  try {
    res.json(await getCached('stats', params));
  } catch (e) {
    res.status(503).json({ error: 'stats are warming up, retry shortly', detail: e.message });
  }
});

app.get('/api/errors', async (req, res) => {
  const params = {
    appSlug: req.query.app_slug || null,
    platform: req.query.platform || null,
    days: req.query.days ? Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365) : null,
    limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200),
    offset: Math.max(parseInt(req.query.offset, 10) || 0, 0),
    type: req.query.type || null,
  };
  try {
    res.json(await getCached('errors', params));
  } catch (e) {
    res.status(503).json({ error: 'errors view is busy, retry shortly', detail: e.message });
  }
});

// Keep the common dashboard views warm so a visitor is always served from cache,
// never waiting on the worker. Held off until the covering indexes exist.
function warmCaches() {
  if (!indexesReady || !worker) return;
  Promise.allSettled([
    getCached('stats', { appSlug: null, platform: null, days: 14, totalEvents }),
    getCached('stats', { appSlug: null, platform: null, days: 30, totalEvents }),
    getCached('errors', { appSlug: null, platform: null, days: 30, limit: 50, offset: 0, type: null }),
  ]);
}

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

  startWorker();

  // Build the heavy covering indexes in the background (one per tick so ingest
  // keeps flowing), then warm the common dashboard views and keep them warm.
  setTimeout(() => buildDeferredIndexes(0), 1500);
  setInterval(warmCaches, FRESH_MS).unref();
});
