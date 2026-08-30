'use strict';

// All the heavy read-only aggregation for the dashboard. Runs inside a worker
// thread (analytics-worker.js) — better-sqlite3 is synchronous and these take
// seconds on a large DB, so on the main thread they'd freeze HTTP + ingest.
// `db` is a better-sqlite3 handle (the worker opens a read-only one).

const fs = require('fs');
const path = require('path');

// ── Excluded apps ────────────────────────────────────────────────────────────
// Apps pulled from the App Store (plus internal / sandbox builds) shouldn't drag
// down the "all apps" order metrics — most have zero orders. `scripts/sync-
// excluded-apps.js` regenerates the list; on the host it lands in
// <analytics-data>/excluded-apps.json (survives deploys), and a checked-in seed
// at the repo root is the fallback. Re-read at most once a minute; a missing
// file just means no exclusions, so a fresh clone still works.
const REPO_ROOT = path.dirname(__dirname); // lib/ -> ..
function excludedFileCandidates() {
  const paths = [];
  let dir = REPO_ROOT;
  for (let i = 0; i < 6; i++) {
    paths.push(path.join(dir, 'analytics-data', 'excluded-apps.json'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  paths.push(path.join(REPO_ROOT, 'excluded-apps.json')); // checked-in seed
  return paths;
}
let _excludedCache = { at: 0, key: '', list: [] };
function excludedApps() {
  const now = Date.now();
  if (now - _excludedCache.at < 60000) return _excludedCache.list;
  _excludedCache.at = now;
  for (const p of excludedFileCandidates()) {
    try {
      const key = p + ':' + fs.statSync(p).mtimeMs;
      if (key !== _excludedCache.key) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        _excludedCache.list = Array.isArray(j.excluded) ? j.excluded : [];
        _excludedCache.key = key;
      }
      return _excludedCache.list;
    } catch { /* try next candidate */ }
  }
  _excludedCache.list = [];
  _excludedCache.key = '';
  return _excludedCache.list;
}

const ERROR_EVENT_TYPES = ['app_error', 'order_place_failed', 'login_failed'];

// Ordering funnel — action events, not screen views (the newer checkout doesn't
// reliably emit screen_entered). `place_order_tapped` is deliberately left out:
// only ~15% of purchases emit it, so it makes the funnel look like it collapses
// to zero and recovers.
const FUNNEL_STEPS = [
  'view_item_list', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase',
];

function parseProps(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// The apps put customer PII (name / email / phone / street address) in the
// properties of a few event types. We don't want it leaving the server, so it's
// stripped from every event row before it reaches the browser — the live feed,
// the event-detail modal, the SSE stream. The stored rows are left untouched.
const PII_EVENT_TYPES = new Set(['sign_up', 'signup_success', 'delivery_address_selected']);
const PII_FIELDS = ['email', 'phone', 'name', 'first_name', 'last_name', 'full_name', 'address'];

function redactRow(row) {
  if (!row || !row.properties || !PII_EVENT_TYPES.has(row.event_type)) return row;
  try {
    const p = JSON.parse(row.properties);
    let touched = false;
    for (const f of PII_FIELDS) if (f in p) { p[f] = '[redacted]'; touched = true; }
    return touched ? { ...row, properties: JSON.stringify(p) } : row;
  } catch { return row; }
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// One human-readable line per error event.
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

// app / platform filter fragment (independent, both optional). When no single
// app is selected, removed-from-sale apps are filtered out of the aggregate;
// selecting one explicitly still shows its real numbers.
function filterClause(appSlug, platform, excluded = []) {
  const parts = [], args = [];
  if (appSlug)  { parts.push('app_slug = ?'); args.push(appSlug); }
  if (platform) { parts.push('platform = ?'); args.push(platform); }
  if (!appSlug && excluded.length) {
    parts.push(`app_slug NOT IN (${excluded.map(() => '?').join(',')})`);
    args.push(...excluded);
  }
  return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
}

// KPI block for the window [sinceDays ago … untilDays ago). untilDays = 0 → now.
function windowKpis(db, f, sinceDays, untilDays) {
  const since = `-${sinceDays} days`;
  const twArgs = untilDays > 0 ? [since, `-${untilDays} days`] : [since];
  const tw = untilDays > 0
    ? `timestamp >= datetime('now', ?) AND timestamp < datetime('now', ?)`
    : `timestamp >= datetime('now', ?)`;
  const W = `WHERE ${tw}${f.sql}`;
  const A = [...twArgs, ...f.args];
  const one = (sql, ...extra) => db.prepare(sql).get(...A, ...extra);

  const events   = one(`SELECT COUNT(*) n FROM events ${W}`).n;
  const sessions = one(`SELECT COUNT(DISTINCT session_id) n FROM events ${W}`).n;
  const users    = one(`SELECT COUNT(DISTINCT anonymous_id) n FROM events ${W}`).n;
  const orders   = one(`SELECT COUNT(*) n FROM events ${W} AND event_type = 'purchase'`).n;
  const purchaseSessions = one(`SELECT COUNT(DISTINCT session_id) n FROM events ${W} AND event_type = 'purchase'`).n;
  const gmv = one(`
    SELECT COALESCE(SUM(CAST(json_extract(properties,'$.value') AS REAL)), 0) g
    FROM events ${W} AND event_type = 'purchase'
  `).g;
  const crashSessions = one(`
    SELECT COUNT(DISTINCT session_id) n FROM events ${W}
    AND event_type = 'app_error' AND properties LIKE '%"type":"crash"%'
  `).n;

  // New users = distinct anon active in the window with no earlier event at all.
  const newUsers = db.prepare(`
    SELECT COUNT(DISTINCT e.anonymous_id) n
    FROM events e
    WHERE ${tw}${f.sql}
      AND NOT EXISTS (
        SELECT 1 FROM events p
        WHERE p.anonymous_id = e.anonymous_id
          AND p.timestamp < datetime('now', ?)
      )
  `).get(...A, since).n;

  return {
    events, sessions, users, newUsers, orders, purchaseSessions,
    gmv: round2(gmv),
    conversion: sessions ? (purchaseSessions / sessions) * 100 : 0,
    aov: orders ? gmv / orders : 0,
    crashFreePct: sessions ? (1 - crashSessions / sessions) * 100 : 100,
  };
}

function computeStats(db, { appSlug = null, platform = null, days = 14 } = {}) {
  const excluded = appSlug ? [] : excludedApps();
  const f = filterClause(appSlug, platform, excluded);
  const since = `-${days} days`;
  const W = `WHERE timestamp >= datetime('now', ?)${f.sql}`;      // current window
  const A = [since, ...f.args];

  // ── KPI strip + period-over-period ──────────────────────────────────────────
  const kpis = windowKpis(db, f, days, 0);
  const prev = windowKpis(db, f, days * 2, days);

  // ── Funnel (windowed) ──────────────────────────────────────────────────────
  const stepStmt = db.prepare(`
    SELECT COUNT(DISTINCT session_id) n FROM events
    WHERE event_type = ? AND timestamp >= datetime('now', ?)${f.sql}
  `);
  const funnel = FUNNEL_STEPS
    .map(step => ({ step, sessions: stepStmt.get(step, since, ...f.args).n }))
    .map((row, i, arr) => {
      const first = arr[0].sessions;
      const prevStep = i > 0 ? arr[i - 1].sessions : row.sessions;
      return {
        ...row,
        drop: i > 0 ? Math.max(prevStep - row.sessions, 0) : 0,
        pctOfFirst:    first > 0 ? (row.sessions / first) * 100 : 0,
        pctOfPrevious: i > 0 ? (prevStep > 0 ? (row.sessions / prevStep) * 100 : 0) : 100,
      };
    });

  // ── Daily time series (windowed, zero-filled) ──────────────────────────────
  const dayAgg = db.prepare(`
    SELECT substr(timestamp,1,10) AS day,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(DISTINCT CASE WHEN event_type = 'purchase' THEN session_id END) AS purchaseSessions,
           COALESCE(SUM(CASE WHEN event_type = 'purchase'
                             THEN CAST(json_extract(properties,'$.value') AS REAL) END), 0) AS revenue
    FROM events ${W}
    GROUP BY day
  `).all(...A);
  const byDay = {};
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    byDay[k] = { day: k, sessions: 0, purchases: 0, revenue: 0 };
  }
  for (const r of dayAgg) {
    const b = byDay[r.day];
    if (!b) continue;
    b.sessions = r.sessions;
    b.purchases = r.purchaseSessions;
    b.revenue = round2(r.revenue);
  }
  const daily = Object.values(byDay).map(b => ({
    ...b,
    conversionRate: b.sessions > 0 ? (b.purchases / b.sessions) * 100 : 0,
  }));

  // ── Checkout health (windowed) ────────────────────────────────────────────
  const checkoutStarts = db.prepare(`
    SELECT COUNT(DISTINCT session_id) n FROM events ${W} AND event_type = 'begin_checkout'
  `).get(...A).n;
  const abandoned = db.prepare(`
    SELECT COUNT(*) c,
           COALESCE(SUM(CAST(json_extract(properties,'$.cart_value') AS REAL)), 0) v
    FROM events ${W} AND event_type = 'checkout_abandoned'
  `).get(...A);
  const failedOrders = db.prepare(`
    SELECT COUNT(*) c FROM events ${W} AND event_type = 'order_place_failed'
  `).get(...A).c;
  const coupons = db.prepare(`
    SELECT COUNT(*) c,
           COALESCE(SUM(CAST(json_extract(properties,'$.discount') AS REAL)), 0) v
    FROM events ${W} AND event_type = 'coupon_applied'
  `).get(...A);
  const tips = db.prepare(`
    SELECT COUNT(*) c, AVG(CAST(json_extract(properties,'$.amount') AS REAL)) a
    FROM events ${W} AND event_type = 'tip_selected'
  `).get(...A);
  const orderTypeRows = db.prepare(`
    SELECT json_extract(properties,'$.is_delivery') d, COUNT(*) c
    FROM events ${W} AND event_type = 'order_type_selected'
    GROUP BY d
  `).all(...A);
  let delivery = 0, pickup = 0;
  for (const r of orderTypeRows) {
    if (r.d === 1 || r.d === '1' || r.d === true) delivery += r.c;
    else pickup += r.c;
  }
  const paymentRows = db.prepare(`
    SELECT TRIM(COALESCE(json_extract(properties,'$.method'), 'Unknown')) m, COUNT(*) c
    FROM events ${W} AND event_type = 'payment_method_selected'
    GROUP BY m ORDER BY c DESC
  `).all(...A);

  const checkout = {
    starts: checkoutStarts,
    completed: kpis.purchaseSessions,
    abandonmentPct: checkoutStarts > 0
      ? Math.max(0, (1 - kpis.purchaseSessions / checkoutStarts) * 100) : 0,
    abandonedCarts: abandoned.c,
    abandonedValue: round2(abandoned.v),
    failedOrders,
    couponOrders: coupons.c,
    couponDiscount: round2(coupons.v),
    couponRate: checkoutStarts > 0 ? Math.min(100, (coupons.c / checkoutStarts) * 100) : 0,
    tipOrders: tips.c,
    avgTip: round2(tips.a),
    tipRate: checkoutStarts > 0 ? Math.min(100, (tips.c / checkoutStarts) * 100) : 0,
    delivery, pickup,
    payments: paymentRows.map(r => ({ method: r.m || 'Unknown', count: r.c })),
  };

  // ── Top items (windowed) ──────────────────────────────────────────────────
  const topItems = db.prepare(`
    SELECT json_extract(properties,'$.product_name') AS name,
           COUNT(*) AS adds,
           COUNT(DISTINCT session_id) AS sessions,
           AVG(CAST(json_extract(properties,'$.price') AS REAL)) AS price
    FROM events ${W} AND event_type = 'add_to_cart'
      AND json_extract(properties,'$.product_name') IS NOT NULL
    GROUP BY name ORDER BY adds DESC LIMIT 15
  `).all(...A).map(r => ({ name: r.name, adds: r.adds, sessions: r.sessions, price: round2(r.price) }));

  // ── Screen engagement (windowed, outliers capped) ─────────────────────────
  const screenTime = db.prepare(`
    SELECT screen_name,
           ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_sec,
           COUNT(*) AS views
    FROM events ${W}
      AND event_type = 'screen_exited' AND screen_name IS NOT NULL
      AND duration_ms BETWEEN 0 AND 600000
    GROUP BY screen_name ORDER BY avg_sec DESC
  `).all(...A);

  // ── Events by type (windowed) ────────────────────────────────────────────
  const byType = db.prepare(`
    SELECT event_type, COUNT(*) AS count FROM events ${W}
    GROUP BY event_type ORDER BY count DESC
  `).all(...A);

  // ── Per-app leaderboard (windowed; ignores the app filter, keeps platform) ─
  // Removed-from-sale apps are dropped from the board regardless of filter.
  const lbExcluded = excludedApps();
  const xf = lbExcluded.length ? ` AND app_slug NOT IN (${lbExcluded.map(() => '?').join(',')})` : '';
  const pf = (platform ? ' AND platform = ?' : '') + xf;
  const pfArgs = [...(platform ? [platform] : []), ...lbExcluded];
  const perAppCur = db.prepare(`
    SELECT app_slug,
           COUNT(*)                                                              AS events,
           COUNT(DISTINCT session_id)                                            AS sessions,
           COUNT(DISTINCT anonymous_id)                                          AS users,
           COUNT(DISTINCT CASE WHEN event_type='purchase' THEN session_id END)   AS purchaseSessions,
           SUM(CASE WHEN event_type='purchase' THEN 1 ELSE 0 END)                AS orders,
           COALESCE(SUM(CASE WHEN event_type='purchase'
                             THEN CAST(json_extract(properties,'$.value') AS REAL) END), 0) AS gmv
    FROM events
    WHERE timestamp >= datetime('now', ?)${pf} AND app_slug IS NOT NULL
    GROUP BY app_slug
  `).all(since, ...pfArgs);
  const prevOrders = {};
  for (const r of db.prepare(`
    SELECT app_slug, SUM(CASE WHEN event_type='purchase' THEN 1 ELSE 0 END) AS orders
    FROM events
    WHERE timestamp >= datetime('now', ?) AND timestamp < datetime('now', ?)${pf} AND app_slug IS NOT NULL
    GROUP BY app_slug
  `).all(`-${days * 2} days`, since, ...pfArgs)) {
    prevOrders[r.app_slug] = r.orders;
  }
  const perApp = perAppCur.map(r => {
    const gmv = round2(r.gmv);
    return {
      app_slug: r.app_slug,
      events: r.events,
      sessions: r.sessions,
      users: r.users,
      orders: r.orders,
      prevOrders: prevOrders[r.app_slug] || 0,
      conversionRate: r.sessions > 0 ? (r.purchaseSessions / r.sessions) * 100 : 0,
      gmv,
      revenue: gmv, // back-compat alias
      aov: r.orders > 0 ? round2(gmv / r.orders) : 0,
    };
  }).sort((a, b) => b.gmv - a.gmv);

  // ── Average orders per day ──────────────────────────────────────────────
  // All-time: total purchases over the days between the first and last one
  // (respects the app / platform filter and the removed-app exclusion). Also a
  // windowed rate so it tracks the selected period.
  const DAY_MS = 86400000;
  const ordersRange = db.prepare(`
    SELECT COUNT(*) n, MIN(timestamp) mn, MAX(timestamp) mx
    FROM events WHERE event_type = 'purchase'${f.sql}
  `).get(...f.args);
  const spanDays = (ordersRange.mn && ordersRange.mx)
    ? Math.max(1, (Date.parse(ordersRange.mx) - Date.parse(ordersRange.mn)) / DAY_MS)
    : 1;
  const ordersPerDay = {
    allTime: round2(ordersRange.n / spanDays),
    window: round2(kpis.orders / days),
    totalOrders: ordersRange.n,
    spanDays: Math.round(spanDays),
    excludedApps: excluded.length,
  };

  // ── Live feed + filter dropdown lists ────────────────────────────────────
  const recent = db.prepare(`
    SELECT * FROM events ${f.sql ? 'WHERE 1=1' + f.sql : ''} ORDER BY id DESC LIMIT 50
  `).all(...f.args).map(redactRow);
  const apps = db.prepare(
    `SELECT DISTINCT app_slug FROM events WHERE app_slug IS NOT NULL ORDER BY app_slug`
  ).all().map(r => r.app_slug);
  const platforms = db.prepare(
    `SELECT DISTINCT platform FROM events WHERE platform IS NOT NULL ORDER BY platform`
  ).all().map(r => r.platform);

  return {
    days,
    windowLabel: `last ${days} days`,
    kpis, prev,
    funnel, daily,
    checkout, topItems,
    screenTime, byType,
    perApp,
    ordersPerDay,
    recent, apps, platforms,

    // ── back-compat top-level fields (older cached clients / quick checks) ──
    total: kpis.events,
    sessions: kpis.sessions,
    users: kpis.users,
    conversionRate: kpis.conversion,
    revenue: kpis.gmv,
    aov: round2(kpis.aov),
    purchaseSessions: kpis.purchaseSessions,
  };
}

function computeErrors(db, { appSlug = null, platform = null, days = null, limit = 50, offset = 0, type = null } = {}) {
  const typeFilter = type && ERROR_EVENT_TYPES.includes(type) ? type : null;

  const filters = [`event_type IN (${ERROR_EVENT_TYPES.map(() => '?').join(',')})`];
  const args    = [...ERROR_EVENT_TYPES];
  if (appSlug)    { filters.push('app_slug = ?'); args.push(appSlug); }
  if (platform)   { filters.push('platform = ?'); args.push(platform); }
  if (typeFilter) { filters.push('event_type = ?'); args.push(typeFilter); }
  if (days)       { filters.push(`timestamp >= datetime('now', ?)`); args.push(`-${days} days`); }
  const where = `WHERE ${filters.join(' AND ')}`;

  const totalMatching = db.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).get(...args).n;

  const byType = db.prepare(`
    SELECT event_type, COUNT(*) AS count FROM events ${where}
    GROUP BY event_type ORDER BY count DESC
  `).all(...args);

  const groupScan = 5000;
  const scanRows = db.prepare(`
    SELECT id, timestamp, app_slug, platform, event_type, properties
    FROM events ${where} ORDER BY id DESC LIMIT ${groupScan}
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
    FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?
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

  return {
    total: totalMatching,
    byType, grouped,
    groupedFrom: scanRows.length, groupScan,
    list, limit, offset,
    days: days || null,
    apps, platforms,
  };
}

module.exports = { ERROR_EVENT_TYPES, parseProps, summarizeError, redactRow, computeStats, computeErrors, excludedApps };
