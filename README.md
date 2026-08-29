# analytics-local-server

Local analytics ingestion + live dashboard. `npm install && npm start`, then open `http://localhost:4000`.

## Dashboard auth

The dashboard (and `/api/stats`, `/api/errors`, the live stream) sit behind HTTP
basic auth when `DASH_USER` and `DASH_PASS` are set in the environment. The
ingest endpoint (`POST /api/v1/events`) is always open — the mobile apps post to
it unauthenticated. With no credentials set the dashboard is open and the server
logs a warning on boot. **Set both on the production host** (Hostinger: hPanel →
Advanced → Node.js → environment variables).

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
