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

**The list is static files, one per county.** A manifest names every county
with a place count, a centroid and a bounding box — a few KB, enough to decide
what to download without downloading any of it. The county you are standing in
loads first and the list is usable immediately, because the nearest twenty
places are almost certainly in it; the rest arrive outwards while you read, and
everything re-sorts as they land. There is no "search server" and no database:
distance sorting happens on the device, instantly, offline.

Sharding is as much about the repository as the wire. A single payload file was
rewritten in full on every run, so git stored a fresh copy of all of it whether
or not one score had moved. Per county, only the counties that actually changed
get written — and at 0–40 new inspections a run, that is a handful.

Coverage stops at 20 miles once there are enough places to be useful. Beyond
that the shards are bytes nobody reads, and the manifest means anything further
is one request away the moment a search or a moved home pin needs it — an empty
search offers to load the rest of the state.

**Inspection history ships separately, one file per ZIP.** It was half the wire
size of the payload and the list needs none of it — only the latest score, to
draw the badge and to sort by. Opening a place fetches its ZIP's shard, a few
kilobytes, and fills in every other place in that ZIP at the same time. Sharded
geographically rather than by id because that is how it gets read: you look at
two or three places near you, which are near each other, so the second and third
cost nothing.

| | Gzipped |
|---|---|
| one file, everything | 0.62 MB |
| `counties.json` | 0.2 KB (three counties; ~5 KB statewide) |
| `places/<county>.json` | Cherokee 26 KB · Cobb 88 KB · Fulton 241 KB |
| `history/<zip>.json` | 3.1 KB median, 13.7 KB largest |

Standing in Woodstock that is a 26 KB first paint instead of 620 KB.

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
| `*?cache-id=<hash>` | `immutable`, a year | a stamped URL's bytes never change |
| app shell | cache-first, refreshed in background | instant launch, works offline |
| map tiles | cache-first, capped at 900 | a tile is a picture of a place, and places don't move |

**Assets are stamped by content, in groups.** `scripts/stamp_assets.py` hashes
each group and rewrites every reference to it as `?cache-id=<hash>`:

| Bucket | Files | Size | Changes |
|---|---|---|---|
| `app` | `app.js`, `styles.css`, `qr.js` | ~118 KB | most commits |
| `vendor` | Leaflet, its CSS and images | ~165 KB | when Leaflet does |
| `icons` | the app icons | ~12 KB | ~never |

One id for everything would be simpler and would re-download Leaflet — vendored
at 1.9.4 and untouched since — every time a line of CSS moved. Separate ids mean
an edit to the app costs 118 KB rather than 295 KB.

They are hashes rather than numbers you set, because a number is a thing you can
forget to change, and that failure is silent: the files change, the URLs don't,
and every warm cache keeps serving the old app. `stamp_assets.py --check` runs in
CI so a stale stamp fails the push instead.

`index.html`, `sw.js` and `version.json` are deliberately unstamped — something
has to be fetched by a stable URL for the rest to be discovered — so those are
served `no-cache` via `web/public/_headers`. That file exists because Cloudflare
Pages defaults every static asset to `max-age=14400`, and four hours of that on
`sw.js` is four hours in which a release cannot reach a device that already has
the app open.

Opening the app costs one small `version.json` request on a cold start, and
nothing at all if it was checked recently.

### Locating things

The inspection source publishes addresses but no coordinates. The crawler
geocodes them through the US Census geocoder (free, no key) and caches the
results in `data/geocache.json`, so each address is only ever looked up once.

Three passes, cheapest first. The batch endpoint takes thousands of addresses in
one request but matches on parsed fields, so it rejects a row outright when the
locality disagrees with its street file — DPH writes `SANDY SPRINGS` where the
Census range is recorded against Atlanta, and the whole address is thrown out.
Pass two retries the misses without suite and unit designators. Pass three sends
what is left to the one-line endpoint, one request each, which parses the
address as a whole and is far more forgiving; it recovers about a fifth of them.
Sending city and ZIP even there matters — it is what confirms a match is the
right street rather than a same-named one elsewhere in Georgia.

**Misses are cached too.** Roughly 5% of addresses will never match: airport
concourses, food courts inside malls, suite-only addresses in buildings the
street file doesn't carry. Recording only successes meant re-asking about every
one of them on every crawl, forever, and the set could only grow. They are
stored with a miss count and an escalating retry delay — 90 days, then 180, then
a year — because the answer *can* change when the reference data gains new
construction, just not monthly. The delay is spread by a hash of the address so
a night's worth of misses doesn't all come due on the same night a quarter
later. A failed *request* is never recorded as a miss; an outage would otherwise
silence thousands of addresses for months.

About 11% of addresses still end up without a street-range match. Those fall
back to a centroid computed from the addresses that *did* match in the same ZIP.
Nothing is ever dropped from the list — but the app is emphatic about which
rows those are, because a distance you can't trust is worse than no distance at
all. The old treatment was a `~` after the number, which nobody ever noticed.

**A guessed position is marked wherever it can be acted on.** A dashed pin with
a question mark sits next to the distance in the list, and again in the detail
sheet above a plain-language note naming the ZIP the pin actually points at.
The Directions button takes the same mark, because the moment that matters is
the one just before you set off, not the one after you arrive. Dashed is
already this app's word for "not confirmed" — the map pins, the saved-place
stars and the halo around a centroid all use it.

The note is careful about what it claims: Directions search by name and address
text rather than by our coordinates, so that link often does find the place. It
is the *distance* and the *pin* that are guesses, and that is what it says.

`scripts/check_geocoder.py` guards all of this. `verify_data.py` can only see
the *aggregate* share of placed addresses, which the cache dominates — the
geocoder could return nothing for a month and every check would still pass while
new establishments quietly went unplaced. So the canary asks five ordinary metro
addresses with known answers, and the refresh workflow goes red if most of them
fail. It runs last, after the deploy: a sick geocoder is worth shouting about,
but it is not a reason to withhold good inspection scores.

### The map

The list is the app; the map is a second view of the same rows. Whatever the
filters and the sort have decided, both draw it — turn on "B or worse" and the
map thins out to match.

On a phone the two swap, from the dock at the bottom of the screen. From 980px
wide there is room for both, so they sit side by side and the switch goes away.

**Your location is a pin you can drag.** Dropping it somewhere else re-sorts the
whole app from there, exactly as typing a ZIP code does — useful for looking up
where you are going rather than where you are.

**Pins that land within 52px of each other are drawn as one.** A county view can
put thousands of places on screen, and downtown Marietta alone stacks a dozen
markers into a pile where the ones underneath cannot be tapped at all. The
clustering is a grid in screen space rather than a plugin — Leaflet is vendored
here deliberately, and forty lines keeps step with that better than another
library would. A cluster is a count and nothing else: colour means a grade
everywhere else in the app, and writing the worst score in a group onto its
marker would read as a verdict on all of them.

**Tiles come from OpenStreetMap** — no key, no account, no build step. Leaflet
is vendored into `web/public/vendor/` rather than pulled from a CDN, so the app
stays installable, and the service worker precaches it: the first time you open
a map is exactly when you are least likely to have signal to spare.

Two things the map does *not* do. It draws at most 280 pins at once, because a
county-wide view can contain thousands and a marker each will jam a phone; the
caption says how many were left out rather than dropping them quietly. And it
has no offline basemap — tiles you have already looked at are kept, but new
ground needs a connection. The list keeps working either way.

### Reaching it one-handed

The app is used standing up, one-handed, outside somewhere. So the controls are
at the bottom, in a dock: search, filter and sort, and the list/map switch. The
header above it is identity rather than chrome and scrolls away with the
content.

That is the reverse of where this started. Search, seven filter chips and the
locate button used to live in a sticky header 150px tall — 22% of a 375×667
screen, held forever, in the hardest part of the screen for a thumb to reach.
The chip row was also 189px wider than the screen, which hid every sort option
past the right edge with nothing to say they were there. They are labelled
sections in a sheet now, and each control gets the full 44px target this
stylesheet had been asking for in `--tap` all along.

The grades became a toggle set at the same time. "A only" and "B or worse" were
the only two ways to filter by score, and neither could express "just show me
the U's" — which is, reliably, the first thing anyone wants to do here. A, B, C
and U are independent now; at least one stays on, because an empty list reads as
a broken app rather than as a filter.

On the map view the header hides entirely and the map runs to the edges, since
the map is the whole point of that view.

### The rest of it

**More** holds what isn't a filter, a search or a view, because those features
were otherwise things you had to already know about.

*Scores in this area* summarises whatever the list is currently showing —
average, median, standard deviation, the count at each grade, and the same cut
by city and by ZIP. Areas with fewer than 12 scored places are left out: an
average over a handful of restaurants is noise, and ranking on it invites a
conclusion the data cannot support.

*Share* builds a link that reopens what is on screen — a restaurant becomes
`?p=<id>`, otherwise the link carries where the list is sorted from and what is
filtered — and draws it as a QR code. `web/public/qr.js` is a QR encoder written
for this, byte mode at error-correction level M, versions 1 to 10. A library
would have been a CDN request the content policy blocks or another vendored
dependency; this is about two hundred lines, and every version round-trips
through an independent decoder in testing.

*Look up* on a restaurant is honestly a web search, not a link. The health
department publishes a name and an address and nothing else — no website, no
menu, no phone — so promising a homepage the data does not contain is how you
end up on somebody else's.

**Sort from here** appears on the map only once the map has been moved away from
wherever the list is currently sorted from. It used to sit there permanently
with a crosshair aiming it, which reads as an instruction on a screen you opened
to look at pins.

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

## Installing it

It is a PWA: `manifest.webmanifest` plus the service worker, so a browser will
offer to add it to the home screen and it launches standalone and works offline
from there. The manifest carries screenshots and long-press shortcuts — saved
places, straight to the map, worst scores first — so the install prompt has
something to show and the icon has somewhere to go.

## What Lighthouse says

Accessibility, best practices and SEO are 100. Three things had to change to get
there, and each was a real defect rather than a score to game:

**The score inside a grade badge failed contrast.** White at `.92` opacity on
the A green was 3.06:1 against a 4.5 requirement for 10px text — and even at
full opacity that green only reached 3.35. `--grade-a` is darker now. The letter
alone would have passed; the number underneath it is what set the floor.

**The footer was the entire cumulative layout shift.** It rendered just below
the header while the list was empty, then the first batch of rows arrived and
shoved it a screen and a half down the page. `#list:empty { min-height: 100dvh }`
holds the space until there are rows to hold it, and stops applying by itself.

**Geolocation was requested on load.** That is a permission prompt with no
context behind it, shown before the app has had a chance to say why it wants
one. It now checks `navigator.permissions` first and only calls the API where
the answer is already yes; everyone else gets the nudge in the status line and
taps *Near you* when they are ready.

`robots.txt` was also missing, so the SPA fallback was answering that request
with `index.html` — 342 parse errors, and a straight fail on the SEO audit.

The remaining best-practices findings are Cloudflare's, not the app's: the bot
challenge script at `/cdn-cgi/challenge-platform/` uses three deprecated APIs
and ships with a four-hour cache lifetime. Turning off Bot Fight Mode removes
them.

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
