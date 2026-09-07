'use strict';

// Pulls the zero-order picture for one calendar month, one platform (default
// iOS), for published apps only (the removed-from-sale exclusion list is
// respected exactly as the dashboard uses it).
//
// Everything the report needs is computed here and returned as a plain object,
// so it can be dumped to JSON as well as rendered to .docx.
//
// The apps emit several parallel event names for the same action (e.g.
// `browse_menu` and `view_item_list`; `add_to_cart` and `item_added_to_cart`),
// so each funnel step matches a SET of event types. Every rate an app is judged
// on is compared against the same rate for the apps that DID take orders this
// month — "abnormal" always means abnormal relative to the platform, never an
// absolute guess.

// step key -> { label, events: [event_type, ...] }.  "opened" is just sessions.
// The apps emit synonyms, so each step matches a set. `browse_menu` is dropped
// on purpose: it fires on nearly every session (app-open / home-refresh), even
// for apps that took no orders, so it hides the real "looked at the menu"
// signal, which is `view_item_list`. `view_item` (opened a dish) is its own
// step — for healthy apps it follows view_item_list ~90% of the time, so a big
// gap there is a strong "menu shows, items don't work" signal.
const FUNNEL = [
  { key: 'opened', label: 'Opened app', events: null },
  { key: 'list', label: 'Opened the menu', events: ['view_item_list'] },
  { key: 'item', label: 'Viewed an item', events: ['view_item'] },
  { key: 'cart', label: 'Added to cart', events: ['add_to_cart', 'item_added_to_cart'] },
  { key: 'checkout', label: 'Started checkout', events: ['begin_checkout'] },
  { key: 'purchase', label: 'Placed order', events: ['purchase'] },
];
const FUNNEL_EVENT_TYPES = [...new Set(FUNNEL.flatMap((s) => s.events || []))];
const STEP_OF_EVENT = {};
for (const s of FUNNEL) for (const e of s.events || []) STEP_OF_EVENT[e] = s.key;

const ERROR_TYPES = ['app_error', 'order_place_failed', 'login_failed'];

// Tunables — surfaced in the report's methodology section. Funnel transitions
// are judged against the platform baseline (apps that took orders this month):
// an app's step-to-step retention is "abnormal" only relative to that.
const THRESHOLDS = {
  noTrafficUsers: 5, // fewer distinct users than this in the month = "no traffic"
  minSessionsToJudgeFunnel: 20, // below this, funnel shape is noise; fall back to history/traffic
  minAtStepToJudge: 12, // need this many sessions at a step before judging the drop after it
  minOpenedToJudgeList: 50, // opened->menu is noisy; need this many sessions to flag it
  minLostToJudge: 12, // a transition's absolute drop must be at least this to be the "worst"
  crashRatePct: 2, // crashed-session share above this = stability fault (platform p95 ~ 0)
  errPerSessionMult: 2.5, // app_error per session above baseline * this = erroring abnormally
  abnormalFrac: 0.5, // transition retention below baseline * this = abnormal
  brokenFrac: 0.15, // ... below baseline * this = looks broken, not just weak
  checkoutMin: 3, // need this many checkout sessions to call checkout itself broken
  staleOrderDays: 90, // last order older than this = treat as churned, not active
};

function monthBounds(month) {
  // month = 'YYYY-MM'
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  const pm = m === 1 ? 12 : m - 1;
  const pmY = m === 1 ? y - 1 : y;
  const prevStart = `${pmY}-${String(pm).padStart(2, '0')}-01`;
  return { start, end, prevStart, prevEnd: start };
}

function prevMonthOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysBetween(aIso, bIso) {
  return Math.round((Date.parse(bIso) - Date.parse(aIso)) / 86400000);
}

function pctText(x) {
  return `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
}

// Human label + owning bucket for each funnel transition when it is the leak.
const TRANSITIONS = [
  {
    from: 'opened', to: 'list',
    weak: { category: 'App / UX', verdict: 'Sessions open the app but do not reach the menu',
      why: 'the app may open to a forced-login / signup wall, a slow or failing first screen, or the menu API returns nothing for this merchant' },
    broken: { category: 'App / technical', verdict: 'The menu is not loading for most sessions',
      why: 'the menu screen or its API call is failing for this merchant on the live build' },
  },
  {
    from: 'list', to: 'item',
    weak: { category: 'Business / UX', verdict: 'People open the menu but rarely tap into a dish',
      why: 'the menu likely looks thin, unappetising or has no photos/descriptions for this merchant' },
    broken: { category: 'App / technical', verdict: 'The menu shows but items cannot be opened',
      why: 'item navigation is broken or items render as unavailable — customers see the list and cannot tap through' },
  },
  {
    from: 'item', to: 'cart',
    weak: { category: 'Business / pricing', verdict: 'People view dishes but do not add them',
      why: 'price, portion or availability on the item page is putting customers off' },
    broken: { category: 'App / technical', verdict: 'The "add to cart" step is failing',
      why: 'the add-to-cart button does nothing, or items are flagged out of stock — almost no one who views a dish adds it' },
  },
  {
    from: 'cart', to: 'checkout',
    weak: { category: 'Business / pricing', verdict: 'Carts are built then abandoned at the cart',
      why: 'delivery fee, service fee, minimum order, or delivery not offered in the area is killing the order at the cart' },
    broken: { category: 'App / checkout', verdict: 'Carts are built but checkout will not start',
      why: 'the "checkout" button is broken or a silent minimum-order / delivery-area block stops it' },
  },
];

// Decide the single most likely reason an app booked zero orders by finding the
// funnel transition where it loses the most customers relative to the platform,
// after ruling out crashes / failed orders / no-traffic. `app.f` carries this
// month's step session-counts; `base` the same rates for apps that DID sell.
function classify(app, base, ctx) {
  const f = app.f;
  const sess = f.opened || 0;
  const crashRatePct = sess ? (app.crashSessions / sess) * 100 : 0;
  const errPerSession = sess ? app.appError / sess : 0;

  const hadOrdersEver = app.allTimeOrders > 0;
  const lastOrderAgeDays = app.lastOrderAt ? daysBetween(app.lastOrderAt, ctx.end) : null;
  const soldRecently = hadOrdersEver && lastOrderAgeDays != null && lastOrderAgeDays <= THRESHOLDS.staleOrderDays;
  const historyNote = hadOrdersEver
    ? `Sold before (${app.allTimeOrders} all-time, last ${app.lastOrderAt ? app.lastOrderAt.slice(0, 10) : 'n/a'}${
        app.prevMonthOrders ? `; ${app.prevMonthOrders} the previous month` : ''
      }).`
    : 'Never recorded an order.';
  const regressionTag = (cat) => (soldRecently && cat.startsWith('App') ? 'App / regression' : cat);

  // 1. Not enough traffic to judge anything.
  if (app.users < THRESHOLDS.noTrafficUsers && sess < THRESHOLDS.noTrafficUsers) {
    return {
      category: 'Demand / acquisition',
      verdict: 'Almost no one opened the app',
      reason:
        `Only ${app.users} user(s) / ${sess} session(s) all month — too little to judge the app. ` +
        `This is a marketing / customer-base question. ${historyNote}`,
    };
  }

  // 2. Orders explicitly failing at placement.
  if (app.orderFailed > 0) {
    return {
      category: regressionTag('App / technical'),
      verdict: 'Orders are failing at placement',
      reason:
        `${app.orderFailed} order(s) hit "order_place_failed" and none succeeded. Customers get all the way to ` +
        `paying, so this is a payment / backend fault that should recover orders once fixed. Pull the failure codes. ${historyNote}`,
    };
  }

  // 3. Crashing well above the platform (which barely crashes at all).
  if (crashRatePct >= THRESHOLDS.crashRatePct && app.crashSessions >= 3) {
    return {
      category: regressionTag('App / technical'),
      verdict: 'The app is crashing users out',
      reason:
        `${app.crashSessions}/${sess} sessions crashed (${pctText(crashRatePct / 100)}) — the rest of the platform is ~0%. ` +
        `Fix the crash before reading anything else into the funnel. ${historyNote}`,
    };
  }

  // 4. Too thin to read the funnel.
  if (sess < THRESHOLDS.minSessionsToJudgeFunnel) {
    return {
      category: hadOrdersEver ? 'App / regression' : 'Demand / acquisition',
      verdict: 'Too little traffic to pinpoint a cause',
      reason:
        `${sess} session(s) / ${app.users} user(s) — enough to see there are no orders, not enough to say why. ` +
        `${f.list} opened the menu, ${f.item} viewed a dish, ${f.cart} built a cart. ${historyNote}`,
    };
  }

  // 5. Find the transition with the worst retention vs the platform norm.
  const baseRate = {
    list: base.opened ? base.list / base.opened : 0,
    item: base.list ? base.item / base.list : 0,
    cart: base.item ? base.cart / base.item : 0,
    checkout: base.cart ? base.checkout / base.cart : 0,
  };
  // Walk the funnel in order and stop at the FIRST transition that retains well
  // below the platform — the earliest break is the root cause; later steps have
  // tiny counts only because of it.
  let worst = null;
  for (const tr of TRANSITIONS) {
    const fromN = f[tr.from];
    const toN = f[tr.to];
    // `view_item_list` is a noisy event even for healthy apps, so the very first
    // transition needs more volume behind it before we'll call it abnormal.
    const minFrom = tr.from === 'opened' ? THRESHOLDS.minOpenedToJudgeList : THRESHOLDS.minAtStepToJudge;
    if (fromN < minFrom) continue;
    if (fromN - toN < THRESHOLDS.minLostToJudge) continue; // the drop itself is too small to matter
    const appRate = fromN ? toN / fromN : 0;
    const bRate = baseRate[tr.to] || 0;
    if (bRate <= 0) continue;
    const ratio = appRate / bRate; // <1 means worse than platform
    if (ratio < THRESHOLDS.abnormalFrac) {
      worst = { tr, appRate, bRate, ratio, fromN, toN };
      break;
    }
  }

  if (worst) {
    const broken = worst.ratio < THRESHOLDS.brokenFrac;
    const spec = broken ? worst.tr.broken : worst.tr.weak;
    const stepLabel = {
      opened: 'opened the app', list: 'opened the menu', item: 'viewed a dish', cart: 'added to cart', checkout: 'started checkout',
    };
    return {
      category: regressionTag(spec.category),
      verdict: spec.verdict,
      reason:
        `Biggest gap vs the platform is ${stepLabel[worst.tr.from]} -> ${stepLabel[worst.tr.to]}: ` +
        `${worst.toN} of ${worst.fromN} sessions (${pctText(worst.appRate)}) against a ${pctText(worst.bRate)} norm ` +
        `(${Math.round(worst.ratio * 100)}% of normal). Reads as ${spec.why}. ` +
        (broken ? `The size of the gap points at a bug more than a soft factor — verify on the live iOS build. ` : '') +
        (soldRecently && spec.category.startsWith('App') ? `It converted recently, so treat this as a regression. ` : '') +
        `${historyNote}`,
    };
  }

  // 6. Checkout starts and never finishes, nothing logged.
  if (f.checkout >= THRESHOLDS.checkoutMin) {
    return {
      category: regressionTag('App / checkout'),
      verdict: 'Checkout starts but never completes',
      reason:
        `${f.checkout} session(s) started checkout and 0 finished, with no failure event logged. ` +
        `Likely a broken payment step, a stuck confirm button, or a silent delivery-area / minimum-order block. ` +
        `Needs a manual test order on the live iOS build. ${historyNote}`,
    };
  }

  // 7. Erroring far above the platform, funnel otherwise ordinary.
  if (base.errPerSession > 0 && errPerSession > base.errPerSession * THRESHOLDS.errPerSessionMult) {
    return {
      category: regressionTag('App / technical'),
      verdict: 'The app is erroring well above normal',
      reason:
        `${errPerSession.toFixed(1)} app_error events per session vs ${base.errPerSession.toFixed(1)} platform norm, ` +
        `with an otherwise ordinary funnel — chase the errors first. ${historyNote}`,
    };
  }

  // 8. Normal-shaped funnel, just too little volume to land an order.
  return {
    category: hadOrdersEver ? 'App / regression' : 'Demand / engagement',
    verdict: 'Funnel shape is normal — just not enough volume',
    reason:
      `Every step retains roughly the platform rate (menu ${pctText(sess ? f.list / sess : 0)}, ` +
      `item ${pctText(f.list ? f.item / f.list : 0)}, cart ${pctText(f.item ? f.cart / f.item : 0)}), ` +
      `there just isn't the volume to convert one. ` +
      (hadOrdersEver ? `It has converted before. ` : `Reads as weak local demand rather than a bug. `) +
      `${historyNote}`,
  };
}

function analyze(db, opts = {}) {
  const platform = (opts.platform || 'ios').toLowerCase();
  const month = opts.month || prevMonthOf(opts.now ? new Date(opts.now) : new Date());
  const { start, end, prevStart, prevEnd } = monthBounds(month);

  const totalEvents = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  if (totalEvents === 0) {
    return {
      empty: true,
      month,
      platform,
      generatedAt: new Date().toISOString(),
      window: { start, end, prevStart, prevEnd },
      excludedCount: 0,
    };
  }

  let excluded = [];
  try {
    excluded = require('../../lib/analytics-queries.js').excludedApps() || [];
  } catch {
    /* no exclusion list available -> report on everything */
  }
  const exPlaceholders = excluded.length ? excluded.map(() => '?').join(',') : null;
  const notExcluded = exPlaceholders ? ` AND app_slug NOT IN (${exPlaceholders})` : '';
  const P = `LOWER(platform) = '${platform}'`;

  // ── Universe: published apps with activity in the month ────────────────────
  const universe = db
    .prepare(
      `SELECT app_slug,
              COUNT(*) events,
              COUNT(DISTINCT session_id) sessions,
              COUNT(DISTINCT anonymous_id) users,
              SUM(CASE WHEN event_type='purchase' THEN 1 ELSE 0 END) orders,
              COALESCE(SUM(CASE WHEN event_type='purchase'
                    THEN CAST(json_extract(properties,'$.value') AS REAL) END),0) gmv
       FROM events
       WHERE ${P} AND app_slug IS NOT NULL
         AND timestamp >= ? AND timestamp < ?${notExcluded}
       GROUP BY app_slug`
    )
    .all(start, end, ...excluded);

  const zeroOrderSlugs = universe.filter((r) => !r.orders).map((r) => r.app_slug);
  const withOrders = universe.filter((r) => r.orders > 0);

  // ── Platform baseline: the same funnel for apps that DID sell this month ───
  const eventSteps = FUNNEL.filter((s) => s.events); // list, item, cart, checkout, purchase
  const stepCols = eventSteps
    .map((s) => `COUNT(DISTINCT CASE WHEN event_type IN (${s.events.map(() => '?').join(',')}) THEN session_id END) ${s.key}`)
    .join(',\n              ');
  const woSlugs = withOrders.map((r) => r.app_slug);
  const baseRow = db
    .prepare(
      `SELECT COUNT(DISTINCT session_id) opened,
              ${stepCols},
              SUM(CASE WHEN event_type='app_error' THEN 1 ELSE 0 END) errs,
              COUNT(DISTINCT CASE WHEN event_type='app_error' AND properties LIKE '%"type":"crash"%' THEN session_id END) crash_sessions
       FROM events
       WHERE ${P} AND timestamp >= ? AND timestamp < ?
         AND app_slug IN (${woSlugs.map(() => '?').join(',') || "''"})`
    )
    .get(...eventSteps.flatMap((s) => s.events), start, end, ...woSlugs);

  const baseline = {
    apps: withOrders.length,
    opened: baseRow.opened,
    errPerSession: baseRow.opened ? baseRow.errs / baseRow.opened : 0,
    crashRate: baseRow.opened ? baseRow.crash_sessions / baseRow.opened : 0,
  };
  for (const s of eventSteps) baseline[s.key] = baseRow[s.key];
  // step-to-step retention (each vs the previous funnel step)
  baseline.rates = {};
  const allKeys = FUNNEL.map((s) => s.key);
  for (let i = 1; i < allKeys.length; i++) {
    const prev = i === 1 ? baseRow.opened : baseRow[allKeys[i - 1]];
    baseline.rates[allKeys[i]] = prev ? baseRow[allKeys[i]] / prev : 0;
  }

  // ── Per-app detail for every zero-order app ───────────────────────────────
  const funnelStmt = db.prepare(
    `SELECT event_type,
            COUNT(DISTINCT session_id) sessions,
            COUNT(DISTINCT anonymous_id) users
     FROM events
     WHERE ${P} AND app_slug = ? AND timestamp >= ? AND timestamp < ?
       AND event_type IN (${FUNNEL_EVENT_TYPES.map(() => '?').join(',')})
     GROUP BY event_type`
  );
  const errStmt = db.prepare(
    `SELECT event_type, COUNT(*) c
     FROM events
     WHERE ${P} AND app_slug = ? AND timestamp >= ? AND timestamp < ?
       AND event_type IN (${ERROR_TYPES.map(() => '?').join(',')})
     GROUP BY event_type`
  );
  const crashStmt = db.prepare(
    `SELECT COUNT(DISTINCT session_id) n
     FROM events
     WHERE ${P} AND app_slug = ? AND timestamp >= ? AND timestamp < ?
       AND event_type='app_error' AND properties LIKE '%"type":"crash"%'`
  );
  const appErrStmt = db.prepare(
    `SELECT COUNT(*) n FROM events
     WHERE ${P} AND app_slug = ? AND timestamp >= ? AND timestamp < ? AND event_type='app_error'`
  );
  const abandonStmt = db.prepare(
    `SELECT COUNT(*) c,
            COALESCE(SUM(CAST(json_extract(properties,'$.cart_value') AS REAL)),0) v
     FROM events
     WHERE ${P} AND app_slug = ? AND timestamp >= ? AND timestamp < ?
       AND event_type='checkout_abandoned'`
  );
  const versionStmt = db.prepare(
    `SELECT COALESCE(app_version,'(unknown)') v, COUNT(DISTINCT session_id) s
     FROM events
     WHERE ${P} AND app_slug = ? AND timestamp >= ? AND timestamp < ?
     GROUP BY v ORDER BY s DESC`
  );
  const screenStmt = db.prepare(
    `SELECT screen_name,
            COUNT(*) views,
            ROUND(AVG(CASE WHEN duration_ms BETWEEN 0 AND 600000 THEN duration_ms END)/1000.0,1) avg_sec
     FROM events
     WHERE ${P} AND app_slug = ? AND timestamp >= ? AND timestamp < ?
       AND event_type='screen_exited' AND screen_name IS NOT NULL
     GROUP BY screen_name ORDER BY views DESC LIMIT 6`
  );
  const historyStmt = db.prepare(
    `SELECT
       SUM(CASE WHEN event_type='purchase' AND timestamp >= ? AND timestamp < ? THEN 1 ELSE 0 END) prev_orders,
       SUM(CASE WHEN event_type='purchase' THEN 1 ELSE 0 END) alltime_orders,
       MAX(CASE WHEN event_type='purchase' THEN timestamp END) last_order_at,
       MIN(timestamp) first_seen, MAX(timestamp) last_seen
     FROM events
     WHERE app_slug = ? AND ${P}`
  );
  const newUsersStmt = db.prepare(
    `SELECT COUNT(DISTINCT e.anonymous_id) n
     FROM events e
     WHERE ${P} AND e.app_slug = ? AND e.timestamp >= ? AND e.timestamp < ?
       AND NOT EXISTS (
         SELECT 1 FROM events p
         WHERE p.anonymous_id = e.anonymous_id AND p.timestamp < ?
       )`
  );

  const ctx = { start, end, prevStart, prevEnd };
  const stepKeys = FUNNEL.map((s) => s.key);

  const apps = universe
    .filter((r) => !r.orders)
    .map((r) => {
      const slug = r.app_slug;

      // distinct sessions / users per funnel step (union of the step's events)
      const perEvent = {};
      for (const row of funnelStmt.all(slug, start, end, ...FUNNEL_EVENT_TYPES)) {
        perEvent[row.event_type] = row;
      }
      const f = { opened: r.sessions };
      const fUsers = { opened: r.users };
      for (const step of FUNNEL) {
        if (!step.events) continue;
        // approximate distinct-union by the max over the step's event types
        // (exact union would need a second query per step; the events are near-
        // synonyms so max is within a few % and never overstates the union)
        let s = 0;
        let u = 0;
        for (const e of step.events) {
          if (perEvent[e]) {
            s = Math.max(s, perEvent[e].sessions);
            u = Math.max(u, perEvent[e].users);
          }
        }
        f[step.key] = s;
        fUsers[step.key] = u;
      }

      const errs = { app_error: 0, order_place_failed: 0, login_failed: 0 };
      for (const row of errStmt.all(slug, start, end, ...ERROR_TYPES)) errs[row.event_type] = row.c;
      const crashSessions = crashStmt.get(slug, start, end).n;
      const appError = appErrStmt.get(slug, start, end).n;
      const ab = abandonStmt.get(slug, start, end);
      const versions = versionStmt.all(slug, start, end);
      const screens = screenStmt.all(slug, start, end);
      const hist = historyStmt.get(prevStart, prevEnd, slug);
      const newUsers = newUsersStmt.get(slug, start, end, start).n;

      const funnelSteps = stepKeys.map((key, i) => {
        const label = FUNNEL[i].label;
        const sessions = f[key];
        const users = fUsers[key];
        const prev = i === 0 ? sessions : f[stepKeys[i - 1]];
        const first = f[stepKeys[0]];
        return {
          key,
          label,
          sessions,
          users,
          dropFromPrev: i === 0 ? 0 : Math.max(0, prev - sessions),
          pctOfPrev: i === 0 ? 100 : prev > 0 ? (sessions / prev) * 100 : 0,
          pctOfFirst: first > 0 ? (sessions / first) * 100 : 0,
        };
      });

      const app = {
        slug,
        events: r.events,
        sessions: r.sessions,
        users: r.users,
        newUsers,
        returningUsers: Math.max(0, r.users - newUsers),
        f,
        fUsers,
        funnelSteps,
        appError,
        orderFailed: errs.order_place_failed,
        loginFailed: errs.login_failed,
        crashSessions,
        abandonedCarts: ab.c,
        abandonedValue: Math.round(ab.v * 100) / 100,
        versions,
        screens,
        prevMonthOrders: hist.prev_orders || 0,
        allTimeOrders: hist.alltime_orders || 0,
        lastOrderAt: hist.last_order_at || null,
        firstSeen: hist.first_seen || null,
        lastSeen: hist.last_seen || null,
      };
      app.rates = {
        list: app.sessions ? app.f.list / app.sessions : 0,
        item: app.f.list ? app.f.item / app.f.list : 0,
        cart: app.f.item ? app.f.cart / app.f.item : 0,
        checkout: app.f.cart ? app.f.checkout / app.f.cart : 0,
        errPerSession: app.sessions ? app.appError / app.sessions : 0,
        crash: app.sessions ? app.crashSessions / app.sessions : 0,
      };
      app.diagnosis = classify(app, baseline, ctx);
      return app;
    })
    .sort((a, b) => b.users - a.users);

  // ── Published apps that were completely dark this month ───────────────────
  const activeSet = new Set(universe.map((r) => r.app_slug));
  const everActive = db
    .prepare(
      `SELECT app_slug,
              MAX(timestamp) last_seen,
              SUM(CASE WHEN event_type='purchase' THEN 1 ELSE 0 END) alltime_orders,
              MAX(CASE WHEN event_type='purchase' THEN timestamp END) last_order_at
       FROM events
       WHERE ${P} AND app_slug IS NOT NULL${notExcluded}
       GROUP BY app_slug`
    )
    .all(...excluded);
  const dark = everActive
    .filter((r) => !activeSet.has(r.app_slug))
    .map((r) => ({
      slug: r.app_slug,
      lastSeen: r.last_seen,
      lastSeenDays: daysBetween(r.last_seen, end),
      allTimeOrders: r.alltime_orders || 0,
      lastOrderAt: r.last_order_at || null,
    }))
    .sort((a, b) => a.lastSeenDays - b.lastSeenDays);

  // ── Platform-wide context (published apps, this month vs previous) ────────
  const ctxRow = (s, e) =>
    db
      .prepare(
        `SELECT COUNT(DISTINCT app_slug) apps,
                COUNT(DISTINCT session_id) sessions,
                COUNT(DISTINCT anonymous_id) users,
                SUM(CASE WHEN event_type='purchase' THEN 1 ELSE 0 END) orders,
                COALESCE(SUM(CASE WHEN event_type='purchase'
                     THEN CAST(json_extract(properties,'$.value') AS REAL) END),0) gmv
         FROM events
         WHERE ${P} AND app_slug IS NOT NULL AND timestamp >= ? AND timestamp < ?${notExcluded}`
      )
      .get(s, e, ...excluded);
  const thisMonth = ctxRow(start, end);
  const lastMonth = ctxRow(prevStart, prevEnd);

  // ── Aggregate drop-off across all zero-order apps ────────────────────────
  const aggSteps = stepKeys.map((key, i) => ({
    key,
    label: FUNNEL[i].label,
    sessions: apps.reduce((n, a) => n + (a.f[key] || 0), 0),
    users: apps.reduce((n, a) => n + (a.fUsers[key] || 0), 0),
  }));
  const aggFunnel = aggSteps.map((row, i, rows) => {
    const prev = i === 0 ? row.sessions : rows[i - 1].sessions;
    const first = rows[0].sessions;
    // platform norm kept-vs-previous for the same step
    const baseKept = i === 0 ? 100 : (baseline.rates[row.key] || 0) * 100;
    return {
      key: row.key,
      label: row.label,
      sessions: row.sessions,
      users: row.users,
      dropFromPrev: i === 0 ? 0 : Math.max(0, prev - row.sessions),
      pctOfPrev: i === 0 ? 100 : prev > 0 ? (row.sessions / prev) * 100 : 0,
      pctOfFirst: first > 0 ? (row.sessions / first) * 100 : 0,
      platformPctOfPrev: baseKept,
    };
  });
  const aggBiggestDrop = aggFunnel.slice(1).reduce((mx, s) => (s.dropFromPrev > mx.dropFromPrev ? s : mx), {
    dropFromPrev: -1,
  });

  // ── Data-quality check: app_slug truncation ─────────────────────────────
  const slugLen = db
    .prepare(
      `SELECT LENGTH(app_slug) L, COUNT(DISTINCT app_slug) n
       FROM events WHERE app_slug IS NOT NULL GROUP BY L ORDER BY L`
    )
    .all();
  const distinctSlugs = slugLen.reduce((s, r) => s + r.n, 0);
  const atCapCount = slugLen.filter((r) => r.L >= 13 && r.L <= 14).reduce((s, r) => s + r.n, 0);
  const slugExists = db.prepare('SELECT 1 FROM events WHERE app_slug = ? LIMIT 1');
  const truncationExamples = [];
  for (const s of excluded.filter((x) => x.length > 14)) {
    if (!slugExists.get(s) && slugExists.get(s.slice(0, 14))) {
      truncationExamples.push({ full: s, stored: s.slice(0, 14) });
    }
  }
  const dataQuality = {
    slugLengthHistogram: slugLen,
    distinctSlugs,
    maxSlugLen: slugLen.reduce((m, r) => Math.max(m, r.L), 0),
    truncationConfirmed: truncationExamples.length > 0,
    truncationExamples,
    slugsAtCap: atCapCount,
    excludedSlugsOverCap: excluded.filter((s) => s.length > 14).length,
  };

  // ── Category roll-up ────────────────────────────────────────────────────
  const byCategory = {};
  for (const a of apps) (byCategory[a.diagnosis.category] = byCategory[a.diagnosis.category] || []).push(a.slug);

  const bucketOf = (cat) => (cat.startsWith('App') ? 'app' : cat.startsWith('Business') ? 'business' : 'demand');
  const buckets = { app: 0, business: 0, demand: 0 };
  const bucketUsers = { app: 0, business: 0, demand: 0 };
  for (const a of apps) {
    buckets[bucketOf(a.diagnosis.category)]++;
    bucketUsers[bucketOf(a.diagnosis.category)] += a.users;
  }
  const zeroOrderUsers = apps.reduce((s, a) => s + a.users, 0);

  return {
    empty: false,
    generatedAt: new Date().toISOString(),
    month,
    platform,
    window: { start, end, prevStart, prevEnd },
    thresholds: THRESHOLDS,
    funnelDef: FUNNEL.map((s) => ({ label: s.label, events: s.events })),
    excludedCount: excluded.length,
    baseline,
    totals: {
      publishedActive: universe.length,
      withOrders: withOrders.length,
      zeroOrder: apps.length,
      zeroOrderPct: universe.length ? (apps.length / universe.length) * 100 : 0,
      darkThisMonth: dark.length,
      buckets,
      bucketUsers,
      zeroOrderUsers,
      regressions: apps.filter((a) => a.diagnosis.category.includes('regression') || a.prevMonthOrders > 0).length,
      neverSold: apps.filter((a) => a.allTimeOrders === 0).length,
      noTraffic: apps.filter((a) => a.diagnosis.category.startsWith('Demand / acquisition')).length,
    },
    context: { thisMonth, lastMonth },
    dataQuality,
    aggFunnel,
    aggBiggestDrop,
    byCategory,
    apps,
    dark,
    universe: universe.sort((a, b) => b.users - a.users),
    zeroOrderSlugs,
  };
}

module.exports = { analyze, classify, monthBounds, prevMonthOf, FUNNEL, THRESHOLDS };
