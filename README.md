# analytics-local-server

Local analytics ingestion + live dashboard. `npm install && npm start`, then open `http://localhost:4000`.

## Deploy note — read before pushing to a new host

The production host has Git auto-deploy on: every push to `main` wipes untracked
files inside this repo's working directory (this is *not* a plain `git pull` —
it resets the tree). `analytics.sqlite` is gitignored, so a push here would
delete the entire event history unless it lives outside the deploy path.

`server.js` handles this automatically: it looks for a sibling `analytics-data/`
directory next to this repo (i.e. `../analytics-data/analytics.sqlite` relative
to `server.js`) and uses that if present, since deploys never touch anything
outside the git working tree. If it's not there (e.g. a fresh clone, or local
dev), it falls back to `analytics.sqlite` inside this directory — zero setup
needed locally.

**First-time setup on a new host:**

```bash
mkdir -p ../analytics-data
mv analytics.sqlite ../analytics-data/analytics.sqlite   # if one already exists
```

After that, every future push is safe — the database is never in the path a
deploy resets.
