# Zero-order apps report

Generates a boss-readable `.docx` on every **published** app that recorded **zero
orders** in a given calendar month on a given platform (iOS by default), with the
user drop-off for each app judged against what the apps that *did* sell that month
actually do — and a first-pass verdict on whether the cause looks **app /
technical**, **business / menu / pricing**, or **demand / marketing**.

## Run it

```bash
# needs a populated copy of the production database
node scripts/zero-order-report/generate.js --db /path/to/analytics.sqlite

# explicit month + output + raw JSON
node scripts/zero-order-report/generate.js \
  --db ~/Downloads/analytics-recovered.sqlite \
  --month 2026-08 \
  --out reports/zero-order-ios-2026-08.docx \
  --json reports/zero-order-ios-2026-08.json
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--db <path>` | walk up for `analytics-data/analytics.sqlite`, else `./analytics.sqlite` | SQLite file, opened read-only |
| `--month <YYYY-MM>` | last month | calendar month to report on |
| `--platform <p>` | `ios` | matched case-insensitively against `events.platform` |
| `--out <path>` | `./zero-order-<platform>-<month>.docx` | output document |
| `--json <path>` | — | also dump the full analysis as JSON |
| `--top <n>` | `25` | apps that get a full detail section; the rest go in an appendix table |

Only dependency is `better-sqlite3` (already in the project) and the system `zip`.
Runs in ~90s against the full production DB.

## Getting the data here

The repo's `analytics.sqlite` is empty on a fresh clone — the real history lives
only on the production host, outside the deploy path (see the root README).
`scp` a copy of `analytics-data/analytics.sqlite` off the host and point `--db`
at it. If the copy is corrupt (`database disk image is malformed`), rebuild it:

```bash
sqlite3 bad.sqlite ".recover" | sqlite3 analytics-recovered.sqlite
sqlite3 analytics-recovered.sqlite "PRAGMA integrity_check;"   # expect: ok
```

`generate.js` auto-detects a recovered DB (it has a `lost_and_found` table) and
notes it in the report.

## How the diagnosis works

1. **Baseline.** For the month, compute the funnel for every app that took at
   least one order: `Opened app -> Opened the menu (view_item_list) -> Viewed an
   item (view_item) -> Added to cart -> Started checkout -> Placed order`.
   `browse_menu` is *not* used — it fires on nearly every session regardless.
2. **Per zero-order app**, rule out in order: no traffic (< 5 users), explicit
   `order_place_failed`, crash rate >= 2% (platform is ~0%).
3. Then **walk the funnel and stop at the earliest transition that retains below
   50% of the platform norm** — the earliest break is the root cause; later steps
   are small only because of it. Below 15% of norm reads as "looks broken" (bug)
   rather than a soft business factor, which flips the verdict from business to
   app for that step.
4. Thin funnels aren't read: < 20 sessions total, < 50 for the noisy
   opened->menu step, and every transition needs a >= 12 absolute drop to count.

Verdicts map to buckets: `App / *` -> engineering, `Business / *` -> ops &
merchant success, `Demand / *` -> marketing. All thresholds are in `THRESHOLDS`
at the top of `analyze.js` and are printed in the report's method section.

## What the report contains

1. **Executive summary** — the app/business/demand split by app count *and*
   user-weighted (they differ a lot), the regressions, and the single
   highest-value fix.
2. **Platform context** vs the previous month, and a "what normal looks like"
   table (the baseline rates).
3. **Category roll-up** — every zero-order app bucketed by likely cause.
4. **Combined drop-off** across all zero-order apps with the platform norm beside
   each transition.
5. **At-a-glance table** — one row per app: users, new users, sessions, funnel
   reach, order failures, crashes, prior-month / all-time orders, verdict.
6. **App-by-app detail** for the top N: funnel vs norm, errors, app versions,
   top screens, written diagnosis.
7. **Recommended next steps** grouped for engineering / ops / marketing, with a
   "do these first" regressions list.
8. **Appendix** — remaining apps, apps that were dark this month, the full
   platform universe, and the exact method / definitions.

## Files

- `analyze.js` — all SQL + the diagnosis logic; returns the analysis as a plain object.
- `generate.js` — CLI + `.docx` rendering.
- `docx.js` — tiny dependency-free OOXML writer (headings, paragraphs, bullets, tables).
- `make-fixture.js` — builds a synthetic test database; **test only**, never run against production.
