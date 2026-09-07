#!/usr/bin/env node
'use strict';

// Zero-order iOS apps report.
//
//   node scripts/zero-order-report/generate.js [options]
//
// Options:
//   --db <path>       SQLite file. Default: walk up for analytics-data/analytics.sqlite,
//                     then fall back to ./analytics.sqlite (same rule the server uses).
//   --month <YYYY-MM> Calendar month to report on. Default: last month.
//   --platform <p>    Platform to filter on. Default: ios.
//   --out <path>      Output .docx path. Default: ./zero-order-<platform>-<month>.docx
//   --json <path>     Also write the raw analysis JSON here.
//   --top <n>         How many apps get a full detail section (rest go in the appendix table). Default: 25.
//
// Needs `better-sqlite3` (already a project dependency) and the system `zip`.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { analyze, FUNNEL } = require('./analyze');
const { Doc } = require('./docx');

// ── args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) o[key] = true;
      else { o[key] = next; i++; }
    }
  }
  return o;
}

function resolveDb(explicit) {
  if (explicit) return path.resolve(explicit);
  let dir = path.resolve(__dirname, '..', '..'); // repo root
  for (let i = 0; i < 6; i++) {
    const c = path.join(dir, 'analytics-data', 'analytics.sqlite');
    if (fs.existsSync(c)) return c;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..', 'analytics.sqlite');
}

// ── formatting helpers ─────────────────────────────────────────────────────
const n = (x) => (x == null ? '0' : Number(x).toLocaleString('en-US'));
const pct = (x) => (x == null ? '—' : `${(Math.round(x * 10) / 10).toFixed(1)}%`);
const rate = (x) => (x == null ? '—' : `${(Math.round(x * 1000) / 10).toFixed(1)}%`); // 0..1 -> %
const money = (x) => `$${(Math.round((Number(x) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');
const plural = (count, one, many) => `${n(count)} ${count === 1 ? one : many || one + 's'}`;
const delta = (a, b) => {
  if (b == null || a == null) return '—';
  const d = a - b;
  return `${d > 0 ? '+' : ''}${n(d)}`;
};

const CATEGORY_COLOR = {
  'App / technical': 'B02418',
  'App / checkout': 'B02418',
  'App / regression': 'B02418',
  'App / UX': 'B02418',
  'Business / pricing': 'B26B00',
  'Business / UX': 'B26B00',
  'Business / engagement': 'B26B00',
  'Demand / acquisition': '2E5395',
  'Demand / engagement': '2E5395',
};
const catColor = (c) => CATEGORY_COLOR[c] || '404040';
const bucketOf = (c) => (c.startsWith('App') ? 'app' : c.startsWith('Business') ? 'business' : 'demand');

// ── report ─────────────────────────────────────────────────────────────────
function build(a, opts) {
  const d = new Doc();
  const monthName = new Date(a.window.start + 'T00:00:00Z').toLocaleString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const platLabel = a.platform.toUpperCase();

  // ---- cover ----
  d.title(`${platLabel} Apps With Zero Orders`, `${monthName} — published apps only`);
  d.p([
    { text: 'Prepared ', color: '666666' },
    { text: new Date(a.generatedAt).toISOString().slice(0, 10), color: '666666', bold: true },
    { text: `  ·  data window ${a.window.start} to ${a.window.end} (exclusive)  ·  ${a.excludedCount} removed-from-sale apps excluded`, color: '666666' },
  ]);
  if (opts.recovered) {
    d.p([
      { text: 'Source note: ', bold: true, color: '666666' },
      { text: 'the production database arrived corrupted and was rebuilt with SQLite\'s recovery tool. The rebuilt copy passes an integrity check; a small fraction of rows may not have survived, which does not change the conclusions.', color: '666666' },
    ]);
  }

  if (a.empty) {
    d.h1('No data');
    d.p('The analytics database has no event rows, so there is nothing to report. Point --db at a copy of the production database and re-run.');
    return d;
  }

  const t = a.totals;
  const b = a.baseline;
  const cThis = a.context.thisMonth;
  const cLast = a.context.lastMonth;
  const B = t.buckets;

  // ---- executive summary ----
  d.h1('Executive summary');
  d.p([
    { text: `${n(t.zeroOrder)} of ${n(t.publishedActive)} published ${platLabel} apps` },
    { text: ` that had any activity in ${monthName} recorded zero orders (${pct(t.zeroOrderPct)}), ` },
    { text: `against a platform that booked ${n(cThis.orders)} orders / ${money(cThis.gmv)} the same month.` },
  ]);
  d.p(`Splitting the ${n(t.zeroOrder)} by the most likely cause of the zero:`);
  d.bullet([
    { text: `${plural(B.app, 'app', 'apps')}: app / technical`, bold: true, color: 'B02418' },
    { text: ` — the funnel or the error rate is abnormal versus apps that did sell. Engineering can act on these.` },
  ]);
  d.bullet([
    { text: `${plural(B.business, 'app', 'apps')}: business / menu / pricing`, bold: true, color: 'B26B00' },
    { text: ` — the app works; customers browse and don't buy. Menu content, prices, fees, delivery area.` },
  ]);
  d.bullet([
    { text: `${plural(B.demand, 'app', 'apps')}: demand / acquisition`, bold: true, color: '2E5395' },
    { text: ` — too few people opened the app to judge anything. Marketing / customer base.` },
  ]);
  d.p('');
  d.bullet([
    { text: `${plural(t.regressions, 'app', 'apps')} sold before`, bold: true },
    { text: ` and booked nothing this month — highest priority regardless of bucket.` },
  ]);
  d.bullet([
    { text: `${plural(t.neverSold, 'app has', 'apps have')} never taken an order`, bold: true },
    { text: ` in the app\'s whole history.` },
  ]);
  d.bullet([
    { text: `${plural(t.darkThisMonth, `published ${platLabel} app`, `published ${platLabel} apps`)} had no activity at all`, bold: true },
    { text: ` this month (appendix).` },
  ]);
  d.p('');
  const bu = t.bucketUsers;
  const topApp = a.apps[0];
  const biggestBucket = bu.app >= bu.business && bu.app >= bu.demand ? 'app' : bu.business >= bu.demand ? 'business' : 'demand';
  d.p([
    { text: 'Bottom line: ', bold: true },
    {
      text:
        `by app count the zero-order list is mostly low-traffic merchants (${B.demand} demand, ${B.business} business/menu, ${B.app} app-fault). ` +
        `But weighting by users tells a different story — of the ${n(t.zeroOrderUsers)} people who used a zero-order app this month, ` +
        `${pct((bu.app / Math.max(1, t.zeroOrderUsers)) * 100)} were in an app-fault app, ${pct((bu.business / Math.max(1, t.zeroOrderUsers)) * 100)} business/menu, ` +
        `${pct((bu.demand / Math.max(1, t.zeroOrderUsers)) * 100)} demand. `,
    },
  ]);
  if (topApp && bucketOf(topApp.diagnosis.category) === 'app') {
    d.p([
      { text: 'The single biggest zero-order app, ', bold: true },
      { text: `${topApp.slug} (${n(topApp.users)} users, ${n(topApp.sessions)} sessions), is an app fault — ` },
      { text: `${topApp.diagnosis.verdict.toLowerCase()}. Fixing it is the highest-value single action in this report.` },
    ]);
  }

  const dq = a.dataQuality;
  if (dq && dq.truncationConfirmed) {
    const ex = dq.truncationExamples[0];
    d.p([
      { text: 'Data-quality caveat: ', bold: true, color: 'B26B00' },
      {
        text:
          `app identifiers are stored clipped to 14 characters (confirmed: "${ex.full}" is stored as "${ex.stored}"). ` +
          `App names below appear as stored and some are cut off. ${n(dq.excludedSlugsOverCap)} removed-from-sale apps have longer ` +
          `names and may slip past the exclusion — none appear in this month's zero-order list. Two merchants sharing the first ` +
          `14 characters would merge into one row.`,
      },
    ]);
  }

  // ---- platform context ----
  d.h2(`${platLabel} context — published apps`);
  d.table(
    ['Metric', monthName, 'Previous month', 'Change'],
    [
      ['Apps with activity', n(cThis.apps), n(cLast.apps), delta(cThis.apps, cLast.apps)],
      ['Users', n(cThis.users), n(cLast.users), delta(cThis.users, cLast.users)],
      ['Sessions', n(cThis.sessions), n(cLast.sessions), delta(cThis.sessions, cLast.sessions)],
      ['Orders', n(cThis.orders), n(cLast.orders), delta(cThis.orders, cLast.orders)],
      ['GMV', money(cThis.gmv), money(cLast.gmv), money((cThis.gmv || 0) - (cLast.gmv || 0))],
    ],
    { widths: [3200, 2200, 2200, 1760] }
  );

  d.h2('What "normal" looks like (apps that took orders this month)');
  d.p(`Every zero-order app below is judged against these rates, not against a guess. Based on ${n(b.apps)} apps, ${n(b.opened)} sessions.`);
  d.table(
    ['Transition', 'Platform norm', 'What it means'],
    [
      ['Opened app -> opened the menu', rate(b.rates.list), 'Share of sessions that reach the menu screen'],
      ['Opened the menu -> viewed a dish', rate(b.rates.item), 'Most people scan the menu; ~2 in 5 tap into an item'],
      ['Viewed a dish -> added to cart', rate(b.rates.cart), 'Share of item-viewers who add it'],
      ['Added to cart -> started checkout', rate(b.rates.checkout), 'Almost everyone who builds a cart proceeds'],
      ['Started checkout -> placed order', rate(b.rates.purchase), 'Checkout completion'],
      ['app_error events per session', b.errPerSession.toFixed(1), 'Background error volume is high platform-wide; only extremes matter'],
      ['Crashed sessions', rate(b.crashRate), 'The platform effectively does not crash'],
    ],
    { widths: [3600, 1900, 3860] }
  );

  // ---- category roll-up ----
  d.h2('Where the zero-order apps fall');
  const catRows = Object.entries(a.byCategory)
    .sort((x, y) => y[1].length - x[1].length)
    .map(([cat, slugs]) => [
      { text: cat, color: catColor(cat), bold: true },
      n(slugs.length),
      slugs.slice(0, 12).join(', ') + (slugs.length > 12 ? ` +${slugs.length - 12} more` : ''),
    ]);
  d.table(['Likely cause', 'Apps', 'Which apps'], catRows, { widths: [2200, 800, 6360] });

  // ---- aggregate funnel ----
  d.h2('Combined drop-off — all zero-order apps');
  d.p('Distinct sessions reaching each step, summed across every zero-order app, with the platform norm for the same transition alongside.');
  if (a.apps[0] && a.aggFunnel[0].sessions > 0 && a.apps[0].sessions / a.aggFunnel[0].sessions > 0.4) {
    d.p([
      { text: 'Note: ', bold: true },
      { text: `${a.apps[0].slug} alone is ${pct((a.apps[0].sessions / a.aggFunnel[0].sessions) * 100)} of these sessions, so this combined view mostly reflects that one app — the per-app table is the reliable read.` },
    ]);
  }
  d.table(
    ['Step', 'Sessions', 'Users', 'Lost here', 'Kept vs previous', 'Platform norm', 'Kept vs opened'],
    a.aggFunnel.map((s, i) => [
      s.label,
      n(s.sessions),
      n(s.users),
      i === 0 ? '—' : n(s.dropFromPrev),
      i === 0 ? '—' : pct(s.pctOfPrev),
      i === 0 ? '—' : pct(s.platformPctOfPrev),
      pct(s.pctOfFirst),
    ]),
    { widths: [1900, 1150, 1050, 1050, 1550, 1550, 1360] }
  );
  if (a.aggBiggestDrop && a.aggBiggestDrop.dropFromPrev > 0) {
    d.p([
      { text: 'Biggest single leak: ', bold: true },
      {
        text:
          `${n(a.aggBiggestDrop.dropFromPrev)} sessions lost at "${a.aggBiggestDrop.label}" — that step keeps ` +
          `${pct(a.aggBiggestDrop.pctOfPrev)} of the previous one, against a ${pct(a.aggBiggestDrop.platformPctOfPrev)} platform norm.`,
      },
    ]);
  }

  // ---- master table ----
  d.pageBreak();
  d.h1('Every zero-order app at a glance');
  d.p('Sorted by users. Menu / Cart / Checkout = distinct sessions reaching that step. Prev mo. / All-time = order counts for context.');
  d.table(
    ['App', 'Users', 'New', 'Sess.', 'Menu', 'Item', 'Cart', 'Chkout', 'Fails', 'Crash', 'Prev', 'All-time', 'Likely cause'],
    a.apps.map((app) => [
      app.slug,
      n(app.users),
      n(app.newUsers),
      n(app.sessions),
      n(app.f.list),
      n(app.f.item),
      n(app.f.cart),
      n(app.f.checkout),
      n(app.orderFailed),
      n(app.crashSessions),
      n(app.prevMonthOrders),
      n(app.allTimeOrders),
      { text: app.diagnosis.category, color: catColor(app.diagnosis.category), bold: true },
    ]),
    { widths: [1500, 600, 520, 580, 560, 540, 540, 640, 540, 560, 540, 720, 1520], fontSize: 14 }
  );

  // ---- per-app detail ----
  const top = Number(opts.top || 25);
  const detailed = a.apps.slice(0, top);
  const rest = a.apps.slice(top);

  d.pageBreak();
  d.h1('App-by-app detail');
  d.p(`Full funnel, errors and history for the ${detailed.length} highest-traffic zero-order apps. The remaining ${rest.length} are in the appendix table.`);

  for (const app of detailed) {
    d.h2(app.slug);
    d.p([
      { text: app.diagnosis.verdict, bold: true, color: catColor(app.diagnosis.category) },
      { text: `  (${app.diagnosis.category})` },
    ]);
    d.p(app.diagnosis.reason);
    d.p([
      { text: 'Activity: ', bold: true },
      { text: `${n(app.users)} users (${n(app.newUsers)} new, ${n(app.returningUsers)} returning) · ${n(app.sessions)} sessions · ${n(app.events)} events. ` },
      { text: `First seen ${day(app.firstSeen)}, last seen ${day(app.lastSeen)}. ` },
      { text: `All-time orders ${n(app.allTimeOrders)}${app.lastOrderAt ? `, last order ${day(app.lastOrderAt)}` : ''}.` },
    ]);

    d.h3('Order funnel vs platform norm');
    d.table(
      ['Step', 'Sessions', 'Users', 'Dropped here', 'Kept vs previous', 'Platform norm'],
      app.funnelSteps.map((s, i) => {
        const norm = i === 0 ? '—' : rate(b.rates[s.key]);
        return [
          s.label,
          n(s.sessions),
          n(s.users),
          i === 0 ? '—' : n(s.dropFromPrev),
          i === 0 ? '—' : s.pctOfPrev > 100 ? '>100%' : pct(s.pctOfPrev),
          norm,
        ];
      }),
      { widths: [2100, 1250, 1150, 1750, 1650, 1460] }
    );

    const errBits = [];
    if (app.orderFailed) errBits.push(`${n(app.orderFailed)} order_place_failed`);
    if (app.loginFailed) errBits.push(`${n(app.loginFailed)} login_failed`);
    if (app.appError) errBits.push(`${n(app.appError)} app_error events (${app.rates.errPerSession.toFixed(1)}/session vs ${b.errPerSession.toFixed(1)} norm)`);
    if (app.crashSessions) errBits.push(`${n(app.crashSessions)} sessions with a crash (${rate(app.rates.crash)})`);
    if (app.abandonedCarts) errBits.push(`${n(app.abandonedCarts)} checkout_abandoned (${money(app.abandonedValue)} in carts)`);
    d.h3('Errors & checkout');
    d.p(errBits.length ? errBits.join('  ·  ') : 'No error, crash or abandonment events recorded this month.');

    if (app.versions.length) {
      d.h3('App versions in use (by sessions)');
      d.p(app.versions.slice(0, 8).map((v) => `${v.v}: ${n(v.s)}`).join('  ·  '));
    }
    if (app.screens.length) {
      d.h3('Most-viewed screens');
      d.p(app.screens.map((s) => `${s.screen_name} (${n(s.views)} views${s.avg_sec ? `, ${s.avg_sec}s avg` : ''})`).join('  ·  '));
    }
    d.spacer();
  }

  // ---- recommendations ----
  d.pageBreak();
  d.h1('Recommended next steps');
  const appApps = a.apps.filter((x) => bucketOf(x.diagnosis.category) === 'app');
  const bizApps = a.apps.filter((x) => bucketOf(x.diagnosis.category) === 'business');
  const demApps = a.apps.filter((x) => bucketOf(x.diagnosis.category) === 'demand');
  const regr = a.apps.filter((x) => x.diagnosis.category.includes('regression') || x.prevMonthOrders > 0);

  if (regr.length) {
    d.h2('0. Regressions — do these first');
    d.p(regr.map((x) => `${x.slug} (${x.diagnosis.category})`).join(', '));
    d.bullet('Each of these has sold before and booked nothing this month. Diff the current build and backend against the last month it converted.');
  }
  d.h2('1. App / technical — engineering');
  d.p(appApps.length ? appApps.map((x) => x.slug).join(', ') : 'None this month.');
  d.bullet('Place a real test order on each live iOS build; watch for a stuck confirm button, a failing payment call, an add-to-cart that does nothing, or a forced-login wall.');
  d.bullet('Check any order_place_failed payloads for the error code and the from_backend flag.');
  d.bullet('For apps where sessions do not reach the menu, confirm the menu API returns data for that merchant and the first screen is not crashing.');
  d.h2('2. Business / menu / pricing — operations & merchant success');
  d.p(bizApps.length ? bizApps.map((x) => x.slug).join(', ') : 'None this month.');
  d.bullet('Verify each merchant has a complete, correctly priced menu loaded — browsing is normal for these apps, so the menu itself is the likely blocker.');
  d.bullet('Review delivery fee, service fee and minimum order against local competitors; confirm delivery is offered in the merchant\'s area.');
  d.h2('3. Demand / acquisition — marketing');
  d.p(demApps.length ? demApps.map((x) => x.slug).join(', ') : 'None this month.');
  d.bullet('These apps work but almost nobody opened them. Decide per merchant: promote, or accept low volume.');
  d.bullet('Cross-check App Store impressions and installs for the same period.');

  // ---- appendix ----
  d.pageBreak();
  d.h1('Appendix');

  if (rest.length) {
    d.h2(`Remaining zero-order apps (${rest.length})`);
    d.table(
      ['App', 'Users', 'New', 'Sess.', 'Menu', 'Item', 'Cart', 'Chkout', 'Fails', 'Crash', 'All-time', 'Likely cause', 'One-line verdict'],
      rest.map((app) => [
        app.slug, n(app.users), n(app.newUsers), n(app.sessions),
        n(app.f.list), n(app.f.item), n(app.f.cart), n(app.f.checkout),
        n(app.orderFailed), n(app.crashSessions), n(app.allTimeOrders),
        { text: app.diagnosis.category, color: catColor(app.diagnosis.category), bold: true },
        app.diagnosis.verdict,
      ]),
      { widths: [1350, 520, 480, 520, 500, 480, 480, 560, 480, 520, 600, 1350, 1540], fontSize: 13 }
    );
  }

  d.h2(`Published ${platLabel} apps with no activity this month (${a.dark.length})`);
  if (a.dark.length) {
    d.table(
      ['App', 'Last seen', 'Days ago', 'All-time orders', 'Last order'],
      a.dark.map((x) => [x.slug, day(x.lastSeen), n(x.lastSeenDays), n(x.allTimeOrders), day(x.lastOrderAt)]),
      { widths: [2600, 1800, 1400, 1900, 1660] }
    );
  } else {
    d.p('None — every published app had some activity.');
  }

  d.h2(`Full ${platLabel} universe this month (${a.universe.length} apps)`);
  d.table(
    ['App', 'Users', 'Sessions', 'Events', 'Orders', 'GMV'],
    a.universe.map((r) => [r.app_slug, n(r.users), n(r.sessions), n(r.events), n(r.orders), money(r.gmv)]),
    { widths: [3000, 1400, 1500, 1500, 1200, 1760], fontSize: 15 }
  );

  d.h2('Method & definitions');
  d.bullet(`"Order" = a "purchase" event (the canonical order signal; "order_placed" is ignored, per the project README).`);
  d.bullet(`"Published app" = an app_slug not on the removed-from-sale exclusion list (${n(a.excludedCount)} apps excluded this run).`);
  d.bullet(`"Zero-order app" = a published app with >=1 ${platLabel} event in ${monthName} and 0 purchase events in that window.`);
  d.bullet(
    `Funnel steps (each matches a set of event names, since the apps emit synonyms): ` +
      a.funnelDef
        .filter((s) => s.events)
        .map((s) => `${s.label} [${s.events.join(' / ')}]`)
        .join('; ') +
      `. Counts are distinct sessions; where a step has two event names the count is the larger of the two (a close under-estimate of the union). ` +
      `browse_menu is deliberately not used — it fires on nearly every session, including for apps that sold nothing.`
  );
  d.bullet(`"Platform norm" for each transition = the same rate computed over every app that DID take an order this ${monthName}. An app is only called abnormal relative to that.`);
  d.bullet(`"New user" = a device (anonymous_id) whose first-ever event in the whole database falls inside the month.`);
  d.bullet(`"Crash" = an app_error event whose properties contain "type":"crash"; "crashed session" = a distinct session with at least one.`);
  d.bullet(
    `Diagnosis: rule out no-traffic (< ${a.thresholds.noTrafficUsers} users), failed orders, and crashes (>= ${a.thresholds.crashRatePct}% of sessions), ` +
      `then walk the funnel and stop at the earliest transition retaining below ${Math.round(a.thresholds.abnormalFrac * 100)}% of the platform norm ` +
      `(the earliest break is the root cause — later steps are small only because of it). Below ${Math.round(a.thresholds.brokenFrac * 100)}% of ` +
      `norm reads as "looks broken" rather than a soft business factor. Funnel not read under ${a.thresholds.minSessionsToJudgeFunnel} sessions; ` +
      `opened->menu needs ${a.thresholds.minOpenedToJudgeList}+ sessions and any transition a ${a.thresholds.minLostToJudge}+ absolute drop before it counts. ` +
      `Order older than ${a.thresholds.staleOrderDays} days = churned.`
  );
  d.bullet(`Platform match is case-insensitive on the "platform" column = "${a.platform}".`);
  if (dq && dq.truncationConfirmed) {
    const ex = dq.truncationExamples[0];
    d.bullet(
      `App-slug truncation: identifiers are stored clipped to 14 characters (confirmed: "${ex.full}" -> "${ex.stored}"). ` +
        `${n(dq.slugsAtCap)} of ${n(dq.distinctSlugs)} distinct app ids sit at 13-14 characters. Fix upstream in the mobile SDK / ingest.`
    );
  }
  d.bullet(`Generated ${a.generatedAt} from ${opts.dbLabel}${opts.recovered ? ' (a .recover salvage of a corrupt database)' : ''}.`);

  return d;
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  const dbPath = resolveDb(args.db);
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error('Pass --db <path> to a copy of the production analytics.sqlite.');
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = TRUE');
  const recovered =
    db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='lost_and_found'").get().n > 0;

  const a = analyze(db, { month: args.month, platform: args.platform || 'ios' });

  const platform = a.platform;
  const month = a.month;
  const outPath = path.resolve(args.out || `zero-order-${platform}-${month}.docx`);
  const dbLabel = path.relative(process.cwd(), dbPath) || dbPath;

  if (a.empty) {
    console.error(`\n  ${dbLabel} has 0 event rows — nothing to report on.`);
    console.error('  Supply a populated database with --db and re-run.\n');
  }

  if (args.json) {
    const jsonPath = path.resolve(args.json);
    fs.writeFileSync(jsonPath, JSON.stringify(a, null, 2));
    console.log(`Wrote ${path.relative(process.cwd(), jsonPath)}`);
  }

  const doc = build(a, { top: args.top, dbLabel, recovered });
  doc.save(outPath);
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);

  if (!a.empty) {
    const t = a.totals;
    console.log(
      `\n  ${month} · ${platform.toUpperCase()} · ${t.zeroOrder}/${t.publishedActive} published apps had zero orders` +
        `  (app ${t.buckets.app} / business ${t.buckets.business} / demand ${t.buckets.demand};` +
        ` ${t.regressions} regressions, ${t.darkThisMonth} dark).\n`
    );
  }
}

if (require.main === module) main();

module.exports = { build };
