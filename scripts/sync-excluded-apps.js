'use strict';

/*
 * sync-excluded-apps.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds the list of app_slugs the dashboard should NOT count in the "all apps"
 * order metrics — apps pulled from the App Store — and writes it to
 *   <analytics-data>/excluded-apps.json
 * (same directory-resolution rule as server.js, so it survives host auto-deploys).
 *
 * Sources, unioned:
 *   1. merchants.json  — every merchant flagged  "unpublished": true.
 *      A full territory-availability scan of App Store Connect (Aug 2026)
 *      confirmed this flag is exact: all 194 unpublished merchants are removed
 *      from sale (or have no App Store record at all), and no published merchant
 *      is. So this alone is enough, needs no credentials, and runs anywhere.
 *   2. App Store Connect  — apps available in zero territories ("removed from
 *      sale"). Only consulted when ASC creds are in the env. Catches the handful
 *      of removed apps whose bundle id no longer matches a merchant slug, and
 *      anything removed after merchants.json was last updated.
 *
 * A keep-list (scripts/excluded-apps.keep.json { "keep": [...] }, or
 * --keep a,b,c) force-keeps specific slugs in the metrics even when they're
 * removed.
 *
 * Env:
 *   MERCHANTS_JSON      path to the branded-apps merchants.json   [required]
 *   ASC_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_CONTENT (base64 .p8)   [optional]
 *   ASC_API_KEY_PATH   path to the .p8, instead of _CONTENT       [optional]
 *   ASC_BUNDLE_PREFIX  default "com.zaytech"
 *   (see branded-apps/.env.local for the ASC values)
 *
 * Usage:
 *   MERCHANTS_JSON=/path/to/merchants.json node scripts/sync-excluded-apps.js
 *   node scripts/sync-excluded-apps.js --dry-run
 *   node scripts/sync-excluded-apps.js --keep aldo,srpcafe
 *   node scripts/sync-excluded-apps.js --no-asc      # merchants.json only
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_ASC = args.includes('--no-asc');
const keepArg = (() => {
  const i = args.indexOf('--keep');
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map(s => s.trim()).filter(Boolean) : [];
})();

// ── config ───────────────────────────────────────────────────────────────────
const MERCHANTS_JSON = process.env.MERCHANTS_JSON || args.find(a => a.endsWith('merchants.json'));
if (!MERCHANTS_JSON || !fs.existsSync(MERCHANTS_JSON)) {
  console.error('Set MERCHANTS_JSON to the path of the branded-apps merchants.json');
  process.exit(1);
}
const BUNDLE_PREFIX = process.env.ASC_BUNDLE_PREFIX || 'com.zaytech';
const ASC_ENABLED = !NO_ASC && process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID &&
  (process.env.ASC_API_KEY_CONTENT || process.env.ASC_API_KEY_PATH);

// ── App Store Connect ────────────────────────────────────────────────────────
const BASE = 'https://api.appstoreconnect.apple.com';
let _token, _tokenAt = 0;
function authToken() {
  if (Date.now() - _tokenAt < 15 * 60 * 1000) return _token;
  const p8 = process.env.ASC_API_KEY_CONTENT
    ? Buffer.from(process.env.ASC_API_KEY_CONTENT, 'base64').toString('utf8')
    : fs.readFileSync(process.env.ASC_API_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput =
    `${b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' })}.` +
    `${b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' })}`;
  const sig = crypto.sign(null, Buffer.from(signingInput),
    { key: crypto.createPrivateKey(p8), dsaEncoding: 'ieee-p1363' });
  _token = `${signingInput}.${sig.toString('base64url')}`;
  _tokenAt = Date.now();
  return _token;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ascGet(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${authToken()}` } });
    if (res.status === 429 && attempt < 6) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    return res.json();
  }
}
async function listAllApps() {
  let out = [];
  let url = '/v1/apps?limit=200&fields[apps]=name,bundleId';
  while (url) {
    const page = await ascGet(url);
    out = out.concat(page.data);
    url = page.links && page.links.next ? page.links.next : null;
  }
  return out;
}
// Removed from sale ⇔ available in zero territories. Short-circuits on the first
// available territory (the common, live case → one request).
async function isRemovedFromSale(appId) {
  let av;
  try { av = await ascGet(`/v1/apps/${appId}/appAvailabilityV2`); }
  catch (e) { if (String(e.message).startsWith('404')) return true; throw e; }
  const availId = av.data && av.data.id;
  if (!availId) return true;
  let url = `/v2/appAvailabilities/${availId}/territoryAvailabilities?limit=50&fields[territoryAvailabilities]=available`;
  while (url) {
    const page = await ascGet(url);
    if (page.data.some(t => t.attributes && t.attributes.available)) return false;
    url = page.links && page.links.next ? page.links.next : null;
  }
  return true;
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const merchants = JSON.parse(fs.readFileSync(MERCHANTS_JSON, 'utf8'));
  const slugByBundle = {};
  for (const [key, m] of Object.entries(merchants)) {
    const slug = m.slug || key;
    slugByBundle[`${BUNDLE_PREFIX}.${m.bundleID || slug}`] = slug;
  }

  const keepList = new Set([...keepArg, ...loadListFile('excluded-apps.keep.json', 'keep')]);
  const removed = new Set();
  const reasons = {};
  const mark = (slug, why) => { removed.add(slug); (reasons[slug] || (reasons[slug] = [])).push(why); };

  // 1. merchants.json unpublished flag
  let unpublishedCount = 0;
  for (const [key, m] of Object.entries(merchants)) {
    if (m.unpublished) { mark(m.slug || key, 'merchants.json:unpublished'); unpublishedCount++; }
  }

  // 1b. manual always-exclude list (internal / sandbox apps that aren't merchants)
  let extraCount = 0;
  for (const slug of loadListFile('excluded-apps.extra.json', 'exclude')) {
    mark(slug, 'manual:internal-app'); extraCount++;
  }

  // 2. App Store Connect territory availability
  let ascChecked = 0, ascRemoved = 0, ascUnmapped = [];
  if (ASC_ENABLED) {
    console.error('Scanning App Store Connect availability (a few minutes)…');
    const apps = await listAllApps();
    for (const a of apps) {
      const bundle = a.attributes.bundleId;
      const slug = slugByBundle[bundle];
      let gone = false;
      try { gone = await isRemovedFromSale(a.id); }
      catch (e) { console.error(`  ! ${bundle}: ${e.message}`); continue; }
      ascChecked++;
      if (!gone) continue;
      ascRemoved++;
      if (slug) mark(slug, 'asc:removed-from-sale');
      else {
        // bundle id no longer matches a merchant slug — fall back to the part
        // after the bundle prefix, which is normally what the app reports as
        // app_slug (APP_BUNDLE_SLUG usually equals APP_SLUG).
        const guess = bundle.startsWith(BUNDLE_PREFIX + '.')
          ? bundle.slice(BUNDLE_PREFIX.length + 1)
          : bundle.split('.').pop();
        mark(guess, 'asc:removed-from-sale(unmapped)');
        ascUnmapped.push({ bundle, name: a.attributes.name, slugGuess: guess });
      }
    }
  } else {
    console.error('ASC creds not set — using merchants.json only (--no-asc or missing env).');
  }

  // 3. keep-list wins
  const kept = [];
  for (const slug of keepList) if (removed.delete(slug)) kept.push(slug);

  const excluded = [...removed].sort();
  const payload = {
    generatedAt: new Date().toISOString(),
    sources: ASC_ENABLED
      ? ['merchants.json:unpublished', 'appStoreConnect:appAvailabilityV2']
      : ['merchants.json:unpublished'],
    bundlePrefix: BUNDLE_PREFIX,
    counts: {
      excluded: excluded.length,
      unpublishedInJson: unpublishedCount,
      manualInternal: extraCount,
      ascChecked, ascRemovedFromSale: ascRemoved,
      ascUnmapped: ascUnmapped.length,
      kept: kept.length,
    },
    excluded,
    kept: kept.sort(),
    reasons,
    ascUnmapped,
  };

  const outPath = path.join(resolveDataDir(), 'excluded-apps.json');
  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    console.error(`\n[dry-run] would write ${outPath}`);
  } else {
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
    console.error(`\nWrote ${outPath}`);
  }
  console.error(`  ${excluded.length} excluded · ${kept.length} kept` +
    (ASC_ENABLED ? ` · ${ascRemoved} removed-from-sale in ASC (${ascUnmapped.length} unmapped)` : ''));
})().catch(e => { console.error(e); process.exit(1); });

// ── helpers ──────────────────────────────────────────────────────────────────
function loadListFile(name, prop) {
  const p = path.join(__dirname, name);
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : Array.isArray(j[prop]) ? j[prop] : [];
    return arr.filter(s => typeof s === 'string' && s && !s.startsWith('_'));
  } catch { return []; }
}

// Mirrors findPersistentDir() in server.js.
function resolveDataDir() {
  let dir = path.dirname(__dirname); // repo root
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'analytics-data');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(__dirname);
}
