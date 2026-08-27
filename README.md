# Score

Health department inspection scores for restaurants near you, as a phone-sized
list. Covers **Cobb, Cherokee and Fulton** counties in Georgia.

The places closest to you right now, what they scored, and — if you tap through
— exactly what the inspector wrote down. There is a map when you want one, and
just the list when you don't.

## How it works

Georgia publishes every food service inspection through a single statewide
system, [ga.healthinspections.us](https://ga.healthinspections.us/georgia/).
There is no API, so this project drives its public search form.

```
GitHub Actions (nightly)          Cloudflare Pages (free)
┌──────────────────────┐          ┌───────────────────────────┐
│ crawler/crawl.py     │  commit  │ public/    static app     │
│  · scrape listings   │ ───────► │  places.json  the dataset │
│  · geocode addresses │          │  vendor/      Leaflet     │
│  · diff vs. last run │  notify  │ functions/ Pages Functions│
└──────────────────────┘ ───────► │  /api/report  live proxy  │
                                  │  /api/notify  push alerts │
                                  └───────────────────────────┘
                                             │ tiles
                                             ▼
                                   tile.openstreetmap.org
```

**The bulk data is a static file.** All ~13,000 establishments with their full
score history is a couple of megabytes, which the phone downloads once and then
sorts locally. That is why there is no "search server" and no database of
restaurants: distance sorting happens on the device, instantly, offline.

**Inspection reports are fetched on demand.** There are tens of thousands of
individual reports and almost none will ever be opened, so `/api/report` proxies
and parses one when you tap it, rather than crawling them all up front.

### Caching

The data barely moves — a given restaurant is inspected a few times a year, and
a *past* inspection never changes at all. The caching is aggressive to match:

| What | Policy | Why |
|---|---|---|
| `places.json?v=<stamp>` | cached forever by the service worker | the URL only changes when the crawler publishes new data |
| `version.json` | never cached, checked at most every 6h | a few bytes; the freshness probe |
| `/api/report` | `max-age=1y, immutable`, edge + service worker | a completed inspection is a historical fact |
| app shell | cache-first, refreshed in background | instant launch, works offline |
| map tiles | cache-first, capped at 900 | a tile is a picture of a place, and places don't move |

Opening the app costs one small `version.json` request on a cold start, and
nothing at all if it was checked recently.

### Locating things

The inspection source publishes addresses but no coordinates. The crawler
geocodes them through the US Census batch geocoder (free, no key) and caches the
results in `data/geocache.json`, so each address is only ever looked up once.

About 10% of addresses don't match a street range — mall food courts, new
construction, suite-only addresses. Those fall back to a centroid computed from
the addresses that *did* match in the same ZIP, and the app marks their distance
approximate with a `~`. Nothing is ever dropped from the list.

### The map

The list is the app; the map is a second view of the same rows. Whatever the
filters and the sort have decided, both draw it — turn on "B or worse" and the
map thins out to match.

On a phone the two swap, via the pill at the bottom of the screen. From 980px
wide there is room for both, so the pill disappears and they sit side by side.

**Your location is a pin you can drag.** Dropping it somewhere else re-sorts the
whole app from there, exactly as typing a ZIP code does — useful for looking up
where you are going rather than where you are.

**Tiles come from OpenStreetMap** — no key, no account, no build step. Leaflet
is vendored into `web/public/vendor/` rather than pulled from a CDN, so the app
stays installable, and the service worker precaches it: the first time you open
a map is exactly when you are least likely to have signal to spare.

Two things the map does *not* do. It draws at most 280 pins at once, because a
county-wide view can contain thousands and a marker each will jam a phone; the
caption says how many were left out rather than dropping them quietly. And it
has no offline basemap — tiles you have already looked at are kept, but new
ground needs a connection. The list keeps working either way.

## Running it locally

```bash
python3 crawler/crawl.py --since-days 45     # or --full for everything on record
python3 scripts/dev_server.py                # http://localhost:8110
```

The dev server serves the static app and implements `/api/report` locally, so
you can click all the way through to a report without deploying.

The crawler needs no dependencies — it is stdlib-only Python 3, on purpose, so
CI has nothing to install and nothing to break.

```
crawler/source.py    fetch + parse the DPH pages
crawler/geocode.py   Census batch geocoding with a persistent cache
crawler/crawl.py     orchestration, merging, payload building
web/public/          the app itself
web/public/vendor/   Leaflet 1.9.4, vendored (no CDN, no build step)
web/functions/api/   Cloudflare Pages Functions
scripts/             dev server, icon generation, VAPID keygen
```

## Deploying to Cloudflare

Everything fits the free plan. The live deployment is
**[healthmap.acklenx.com](https://healthmap.acklenx.com)**.

Deployment is Cloudflare's **Pages Git integration**: the project watches this
repository and publishes on every push to `main`. There is no build step for it
to run — Leaflet is vendored and the dataset is a committed file — so a deploy
is really just Cloudflare copying `web/public/` to the edge and compiling
`web/functions/` into Pages Functions.

The useful consequence is that **no Cloudflare credentials exist anywhere in
this repository.** CI never authenticates to Cloudflare, because CI never talks
to Cloudflare. The nightly job commits refreshed data and the push does the
rest.

**1. Create the Pages project**

Workers & Pages → Create → Pages → Connect to Git, and pick this repository.

| Setting | Value |
|---|---|
| Project name | `healthmap` — must match `name` in `web/wrangler.toml` |
| Production branch | `main` |
| Framework preset | None |
| Build command | *(empty)* |
| Root directory | `web` |

The root directory is the setting that matters. Pointing it at `web` is what
lets Cloudflare find `wrangler.toml`, serve `public/` as the output directory,
and pick up the sibling `functions/` folder. Point it at the repository root
instead and the API routes silently never deploy — the list and the map still
work, so the failure only shows up when you tap through to a report.

**2. Point the subdomain at it**

In the Pages project: **Custom domains → Set up a custom domain →**
`healthmap.acklenx.com`.

Because `acklenx.com` is already on Cloudflare nameservers, Cloudflare writes
the proxied CNAME into the zone itself and provisions the certificate; there is
no DNS record to add by hand. It is usually serving within a minute.

Nothing in the app is aware of its own hostname — every URL in `public/` is
relative and the manifest scopes to `/` — so the custom domain needs no code
change, and the `.pages.dev` address keeps working alongside it.

**3. The nightly refresh**

`.github/workflows/refresh.yml` runs an incremental crawl nightly and a full
crawl on Sundays, verifies the payload, and commits it. That commit is what
triggers the next deploy.

It needs no secrets, but it does need write access to the repository: check
**Settings → Actions → General → Workflow permissions** is set to *Read and
write*, or the crawl succeeds and the `git push` at the end fails.

**4. Optional — push alerts for saved places**

Alerts are off by default. The D1 binding in `web/wrangler.toml` is commented
out, and `/api/subscribe`, `/api/notify` and `/api/pending` return 503 while it
is — a deploy carrying a placeholder `database_id` would be rejected outright.

This is the one part that needs `wrangler` locally:

```bash
npx wrangler login
npx wrangler d1 create healthmap             # uncomment the binding, paste the id
npx wrangler d1 execute healthmap --remote --file=web/schema.sql
node scripts/gen_vapid.mjs                   # generates the key pair
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `NOTIFY_SECRET` on the Pages
project (Settings → Environment variables), point `VAPID_SUBJECT` in
`wrangler.toml` at a real mailbox, and add to the GitHub repository secrets:

| Secret | Value |
|---|---|
| `NOTIFY_SECRET` | same value as on the Pages project |
| `APP_ORIGIN` | `https://healthmap.acklenx.com` |

Alerts use payload-less Web Push: the notification body is fetched by the
service worker from `/api/pending`, which avoids implementing RFC 8291 payload
encryption and means an alert queued while the phone was offline still arrives
with the right text. On iOS, web push only works once the app has been added to
the home screen.

### A note on repository size

The nightly job commits `data/store.json` whenever scores move. It is ~6 MB and
git stores a fresh blob each time, so the history grows by a few megabytes a
week. It cannot simply be ignored — the crawler diffs against the previous
`store.json` to work out what changed and who to alert. If it ever gets
uncomfortable, squash the data history or move the store to an R2 bucket.

## Reading the scores fairly

A score is one inspector's snapshot of one visit, not a running verdict — a 71
often means a bad morning rather than a bad restaurant, and the next visit
frequently swings back into the 90s. That's why the app leads with history
rather than a single number, and why tapping a score shows the actual findings:
"cold holding temperature" and "no soap at the handwash sink" are worth knowing
about, while "wiping cloths improperly stored" mostly isn't.

Violations the state designates as **foodborne-illness risk factors** are called
out in red and sorted to the top.

Grades follow Georgia DPH Chapter 511-6-1: **A** 90–100, **B** 80–89,
**C** 70–79, **U** below 70.

## Data

Everything comes from the Georgia Department of Public Health. This project is
not affiliated with any health department. If a listing looks wrong, the
authoritative record is the original report, linked from every inspection.
