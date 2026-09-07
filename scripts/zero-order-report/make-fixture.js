#!/usr/bin/env node
'use strict';

// Builds a small synthetic analytics.sqlite so the report pipeline can be
// exercised without the production data. NOT used in production — test only.
//
//   node scripts/zero-order-report/make-fixture.js /tmp/fixture.sqlite

const Database = require('better-sqlite3');

const out = process.argv[2] || '/tmp/zero-order-fixture.sqlite';
const db = new Database(out);
db.exec(`
  DROP TABLE IF EXISTS events;
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    app_slug TEXT, platform TEXT, user_id TEXT,
    anonymous_id TEXT NOT NULL, session_id TEXT NOT NULL,
    event_type TEXT NOT NULL, screen_name TEXT, duration_ms INTEGER,
    properties TEXT, timestamp TEXT NOT NULL,
    app_version TEXT, os_version TEXT,
    received_at TEXT DEFAULT (datetime('now'))
  );
`);

let seq = 0;
const ins = db.prepare(`INSERT INTO events
  (event_id, app_slug, platform, anonymous_id, session_id, event_type, screen_name, duration_ms, properties, timestamp, app_version, os_version)
  VALUES (@event_id,@app_slug,@platform,@anonymous_id,@session_id,@event_type,@screen_name,@duration_ms,@properties,@timestamp,@app_version,@os_version)`);

function ev(o) {
  seq++;
  ins.run({
    event_id: `e${seq}`,
    app_slug: o.app || null,
    platform: o.platform || 'ios',
    anonymous_id: o.anon,
    session_id: o.sess,
    event_type: o.type,
    screen_name: o.screen || null,
    duration_ms: o.duration || null,
    properties: o.props ? JSON.stringify(o.props) : null,
    timestamp: o.ts,
    app_version: o.ver || '3.4.0',
    os_version: o.os || 'iOS 18.5',
  });
}

// helper: a session that walks the funnel up to `stop`
const STEPS = ['view_item_list', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
function funnelSession(app, anon, sess, ts, stopIdx, extra = {}) {
  ev({ app, anon, sess, type: 'session_start', ts, ...extra });
  ev({ app, anon, sess, type: 'screen_exited', screen: 'Home', duration: 8000, ts, ...extra });
  for (let i = 0; i <= stopIdx; i++) {
    const props = STEPS[i] === 'purchase' ? { value: 24.5 } : STEPS[i] === 'add_to_cart' ? { product_name: 'Burrito', price: 11 } : undefined;
    ev({ app, anon, sess, type: STEPS[i], ts, props, ...extra });
  }
}

const AUG = (d, h = 12) => `2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const JUL = (d) => `2026-07-${String(d).padStart(2, '0')}T12:00:00Z`;

// 1. healthy-selling app (should NOT appear as zero-order)
for (let i = 0; i < 20; i++) funnelSession('tacoloco', `u_tl_${i}`, `s_tl_${i}`, AUG(1 + (i % 27)), 4);

// 2. regression: sold well in July, checkout broken in Aug (reaches checkout, 0 purchases, order_place_failed)
for (let i = 0; i < 12; i++) funnelSession('sushizen', `u_sz_${i}`, `s_sz_${i}`, JUL(2 + i), 4);
for (let i = 0; i < 15; i++) {
  funnelSession('sushizen', `u_sz_a${i}`, `s_sz_a${i}`, AUG(3 + i), 3);
  ev({ app: 'sushizen', anon: `u_sz_a${i}`, sess: `s_sz_a${i}`, type: 'order_place_failed', ts: AUG(3 + i), props: { code: 500, message: 'gateway timeout', from_backend: true } });
}

// 3. crashing app: users arrive, app crashes before menu
for (let i = 0; i < 18; i++) {
  ev({ app: 'wingshack', anon: `u_ws_${i}`, sess: `s_ws_${i}`, type: 'session_start', ts: AUG(2 + i) });
  ev({ app: 'wingshack', anon: `u_ws_${i}`, sess: `s_ws_${i}`, type: 'app_error', ts: AUG(2 + i), props: { type: 'crash', name: 'NSInvalidArgument', reason: 'nil menu' } });
}

// 4. cart abandonment / pricing: build carts, never checkout
for (let i = 0; i < 22; i++) funnelSession('pokebowlco', `u_pb_${i}`, `s_pb_${i}`, AUG(1 + i), 2);

// 5. browse-only: reach menu, never add
for (let i = 0; i < 14; i++) funnelSession('greensalad', `u_gs_${i}`, `s_gs_${i}`, AUG(2 + i), 0);

// 6. no traffic: 2 users, nothing
ev({ app: 'lonelydiner', anon: 'u_ld_1', sess: 's_ld_1', type: 'session_start', ts: AUG(9) });
ev({ app: 'lonelydiner', anon: 'u_ld_2', sess: 's_ld_2', type: 'session_start', ts: AUG(19) });

// 7. android activity only for an app that's iOS-dark (should be ignored on ios run)
for (let i = 0; i < 5; i++) funnelSession('droidonly', `u_do_${i}`, `s_do_${i}`, AUG(4 + i), 4, { platform: 'android' });

// 8. excluded/removed app with zero orders — must NOT show up if on the excluded list.
//    (won't be excluded in fixture unless excluded-apps.json lists it; included here as a universe member)
for (let i = 0; i < 3; i++) funnelSession('KawaiiToriSushi', `u_kt_${i}`, `s_kt_${i}`, AUG(6 + i), 1);

// 9. iOS-dark published app: last activity in July, nothing in Aug
for (let i = 0; i < 4; i++) funnelSession('oldpizzeria', `u_op_${i}`, `s_op_${i}`, JUL(10 + i), 4);

console.log(`Wrote ${out} with ${seq} events`);
db.close();
