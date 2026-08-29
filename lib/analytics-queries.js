'use strict';

// All the heavy read-only aggregation for the dashboard. Kept in its own module
// so it can run inside a worker thread (analytics-worker.js) — better-sqlite3 is
// synchronous, and on a large DB these queries take seconds, so running them on
// the main thread would freeze HTTP and ingest. `db` is a better-sqlite3 handle
// (the worker opens a read-only one).

const ERROR_EVENT_TYPES = ['app_error', 'order_place_failed', 'login_failed'];

function parseProps(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// One human-readable line per error event, built from the properties each call
// site actually sends (see AnalyticsTracker.swift / AppDelegate.swift / ATCNetworkingManager.swift).
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

function computeStats(db, { appSlug = null, platform = null, days = 14, totalEvents = null } = {}) {
  const filters = [];
  const args    = [];
  if (appSlug)  { filters.push('app_slug = ?');  args.push(appSlug); }
  if (platform) { filters.push('platform = ?');  args.push(platform); }
  const where     = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const andClause = filters.length ? `AND ${filters.join(' AND ')}`   : '';

  const total = (!appSlug && !platform && totalEvents != null)
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
  const FUNNEL_STEPS = [
    'view_item_list', 'view_item', 'add_to_cart',
    'begin_checkout', 'place_order_tapped', 'purchase',
  ];
  const stepStmt = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as n FROM events
    WHERE event_type = ?
    ${andClause}
  `);
  const funnel = FUNNEL_STEPS.map((step) => ({ step, sessions: stepStmt.get(step, ...args).n }))
    .map((row, i, arr) => {
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

  // Revenue / AOV — `value` lives inside the purchase event's JSON properties blob.
  const purchaseRows = db.prepare(`
    SELECT properties FROM events WHERE event_type = 'purchase' ${andClause}
  `).all(...args);
  let revenue = 0;
  for (const r of purchaseRows) {
    const v = Number(parseProps(r.properties).value);
    if (!Number.isNaN(v)) revenue += v;
  }
  const aov = purchaseRows.length > 0 ? revenue / purchaseRows.length : 0;

  // Daily time series, aggregated in SQL (pulling every row in the window into
  // JS was millions of rows).
  const dayAggRows = db.prepare(`
    SELECT substr(timestamp,1,10) AS day,
           COUNT(DISTINCT session_id) AS sessions,
           COUNT(DISTINCT CASE WHEN event_type = 'purchase' THEN session_id END) AS purchaseSessions
    FROM events
    WHERE timestamp >= datetime('now', ?)
    ${andClause}
    GROUP BY day
  `).all(`-${days} days`, ...args);
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

  const recent = db.prepare(`
    SELECT * FROM events ${where} ORDER BY id DESC LIMIT 50
  `).all(...args);

  const apps = db.prepare(`
    SELECT DISTINCT app_slug FROM events WHERE app_slug IS NOT NULL ORDER BY app_slug
  `).all().map(r => r.app_slug);

  // Per-app leaderboard — respects the platform filter but never the app filter.
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
    SELECT event_type, COUNT(*) AS count
    FROM events ${where}
    GROUP BY event_type ORDER BY count DESC
  `).all(...args);

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

  return {
    total: totalMatching,
    byType, grouped,
    groupedFrom: scanRows.length,
    groupScan,
    list, limit, offset,
    days: days || null,
    apps, platforms,
  };
}

module.exports = { ERROR_EVENT_TYPES, parseProps, summarizeError, computeStats, computeErrors };
