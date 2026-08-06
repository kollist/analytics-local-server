# analytics-local-server

Local analytics ingestion + live dashboard. `npm install && npm start`, then open `http://localhost:4000`.

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
