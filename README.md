# analytics-local-server

Local analytics ingestion + live dashboard. `npm install && npm start`, then open `http://localhost:4000`.

## Dashboard auth

The dashboard (and `/api/stats`, `/api/errors`, the live stream) sit behind HTTP
basic auth when `DASH_USER` and `DASH_PASS` are set in the environment. The
ingest endpoint (`POST /api/v1/events`) is always open — the mobile apps post to
it unauthenticated. With no credentials set the dashboard is open and the server
logs a warning on boot. **Set both on the production host** (Hostinger: hPanel →
Advanced → Node.js → environment variables).

## Canonical events

- **Orders / GMV / conversion are all counted from the `purchase` event.** It has
  the full history and fires for every order.
- **`order_placed` is ignored.** It was added later, only fires for ~10% of
  orders, and only ~11 sessions in the whole DB have it without a matching
  `purchase`. It carries `order_type` / `payment` / `total` inline, but the
  dashboard gets those from `order_type_selected` / `payment_method_selected`.
  The app should stop sending `order_placed` (or fold its fields into
  `purchase`); nothing here needs to change and there's nothing to backfill.
- The ordering funnel is `view_item_list → view_item → add_to_cart →
  begin_checkout → purchase`. `place_order_tapped` is left out — only ~15% of
  purchases emit it.

## Removed-from-sale apps

Apps pulled from the App Store shouldn't drag down the "all apps" order metrics
(most have zero orders). `scripts/sync-excluded-apps.js` builds the exclusion
list from App Store Connect (an app available in zero territories is removed
from sale) plus `merchants.json` (a slug flagged `unpublished` with no ASC
record is fully deleted), and writes it to `<analytics-data>/excluded-apps.json`.

```bash
# needs ASC_KEY_ID / ASC_ISSUER_ID / ASC_API_KEY_CONTENT (see branded-apps/.env.local)
# and MERCHANTS_JSON pointing at the branded-apps merchants.json
MERCHANTS_JSON=/path/to/merchants.json node scripts/sync-excluded-apps.js
```

The Aug-2026 scan found `merchants.json`'s `unpublished` flag to be exact —
every one of the 194 unpublished merchants is removed from sale in ASC, and no
published merchant is — so `--no-asc` (merchants.json only, no credentials) is a
fine daily mode; run the full ASC pass occasionally to catch apps removed since
the file was last updated and the few whose bundle id no longer maps to a slug.

Two hand-maintained lists live next to the script:
`excluded-apps.extra.json` `{ "exclude": [...] }` — internal / sandbox / template
builds (The Foodies, Zaytech Academy/Scanner, VCC FL, `vccsandbox`, …) that are
not merchants; `excluded-apps.keep.json` `{ "keep": [...] }` — removed apps whose
orders should still count (currently empty). The keep-list wins.

Run the sync on a schedule (cron / a routine). The dashboard re-reads the result
at most once a minute, preferring `<analytics-data>/excluded-apps.json` and
falling back to a checked-in `excluded-apps.json` at the repo root. With no file
present nothing is excluded. Selecting a single app in the dashboard filter
always shows that app's real numbers, removed or not; the exclusion only applies
to the all-apps aggregate and the leaderboard. The **Orders / day** KPI is the
all-time average (total purchases over the days they span), also filtered this
way.

## Architecture note

The dashboard aggregation runs in a worker thread (`analytics-worker.js` +
`lib/analytics-queries.js`) with its own read-only SQLite connection, so the
multi-second `GROUP BY` / `COUNT(DISTINCT)` queries never block HTTP or event
ingest on the main thread. `/api/stats` and `/api/errors` are served from a
stale-while-revalidate cache the worker keeps warm. The heavy covering indexes
are built in the background after boot (see `DEFERRED_INDEXES` in `server.js`).

## Deploy note — read before pushing to a new host

The production host has Git auto-deploy on: every push to `main` wipes untracked
files inside this repo's working directory (this is *not* a plain `git pull` —
it resets the tree). `analytics.sqlite` is gitignored, so a push here would
delete the entire event history unless it lives outside the deploy path.

`server.js` handles this automatically: it walks up from `server.js` looking
for an `analytics-data/` directory (checking the immediate parent first, then
a few more ancestor levels) and uses that if found, since deploys never touch
anything outside the git working tree. The multi-level walk matters because
some hosts (e.g. Hostinger's Node.js auto-deploy) don't deploy into a fixed
directory — every push builds a fresh versioned folder several levels deep
(`.../hbuilds/versions/<uuid>/nodejs`) — so a plain sibling check would miss
it. If no `analytics-data/` is found anywhere up the tree (e.g. a fresh clone,
or local dev), it falls back to `analytics.sqlite` inside this directory —
zero setup needed locally.

**First-time setup on a new host:**

```bash
mkdir -p ../analytics-data
mv analytics.sqlite ../analytics-data/analytics.sqlite   # if one already exists
```

After that, every future push is safe — the database is never in the path a
deploy resets.
