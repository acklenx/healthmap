#!/usr/bin/env python3
"""Crawl Georgia DPH restaurant inspections and build the web app's data file.

Two modes:

  --full             Every inspection on record (~5 years). Slow (~2k page
                     fetches); run it weekly to catch corrections and closures.
  --since-days N     Only inspections in the last N days. Fast (~50 fetches);
                     run it nightly. Results are merged into the existing store.

Outputs:
  data/store.json     full-fidelity merged record, the crawler's own state
  data/geocache.json  address -> coordinate cache
  web/public/places.json  compact payload the app downloads
  data/changes.json   inspections new since the previous run (drives alerts)
"""

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import geocode  # noqa: E402
import source  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Overridable so a preview crawl can run alongside the real one.
DATA = os.environ.get("SCORE_DATA_DIR", os.path.join(ROOT, "data"))
WEB_PUBLIC = os.environ.get("SCORE_WEB_DIR", os.path.join(ROOT, "web", "public"))
# Every county in Georgia. Hardcoded rather than scraped: the list has not
# changed since 1924, and a static tuple has no per-county maintenance cost --
# which is the property that matters, since the whole point of sharding by
# county is that adding one should be a data change and nothing else.
GEORGIA = [
    "Appling", "Atkinson", "Bacon", "Baker", "Baldwin", "Banks", "Barrow",
    "Bartow", "Ben Hill", "Berrien", "Bibb", "Bleckley", "Brantley", "Brooks",
    "Bryan", "Bulloch", "Burke", "Butts", "Calhoun", "Camden", "Candler",
    "Carroll", "Catoosa", "Charlton", "Chatham", "Chattahoochee", "Chattooga",
    "Cherokee", "Clarke", "Clay", "Clayton", "Clinch", "Cobb", "Coffee",
    "Colquitt", "Columbia", "Cook", "Coweta", "Crawford", "Crisp", "Dade",
    "Dawson", "Decatur", "DeKalb", "Dodge", "Dooly", "Dougherty", "Douglas",
    "Early", "Echols", "Effingham", "Elbert", "Emanuel", "Evans", "Fannin",
    "Fayette", "Floyd", "Forsyth", "Franklin", "Fulton", "Gilmer", "Glascock",
    "Glynn", "Gordon", "Grady", "Greene", "Gwinnett", "Habersham", "Hall",
    "Hancock", "Haralson", "Harris", "Hart", "Heard", "Henry", "Houston",
    "Irwin", "Jackson", "Jasper", "Jeff Davis", "Jefferson", "Jenkins",
    "Johnson", "Jones", "Lamar", "Lanier", "Laurens", "Lee", "Liberty",
    "Lincoln", "Long", "Lowndes", "Lumpkin", "Macon", "Madison", "Marion",
    "McDuffie", "McIntosh", "Meriwether", "Miller", "Mitchell", "Monroe",
    "Montgomery", "Morgan", "Murray", "Muscogee", "Newton", "Oconee",
    "Oglethorpe", "Paulding", "Peach", "Pickens", "Pierce", "Pike", "Polk",
    "Pulaski", "Putnam", "Quitman", "Rabun", "Randolph", "Richmond",
    "Rockdale", "Schley", "Screven", "Seminole", "Spalding", "Stephens",
    "Stewart", "Sumter", "Talbot", "Taliaferro", "Tattnall", "Taylor",
    "Telfair", "Terrell", "Thomas", "Tift", "Toombs", "Towns", "Treutlen",
    "Troup", "Turner", "Twiggs", "Union", "Upson", "Walker", "Walton", "Ware",
    "Warren", "Washington", "Wayne", "Webster", "Wheeler", "White",
    "Whitfield", "Wilcox", "Wilkes", "Wilkinson", "Worth",
]

# What a run crawls by default. Widen with --counties, or --counties all.
COUNTIES = ["Cobb", "Cherokee", "Fulton"]
PAYLOAD_VERSION = 1


def log(*a):
    print(*a, flush=True)


def crawl_county(county, since, until, workers, log=log):
    """Page through one county's results, returning establishments merged by id."""
    first = source.fetch(source.search_url(county, 1, since, until))
    total_rows = source.result_count(first)
    pages = max(1, math.ceil(total_rows / source.PAGE_SIZE))
    log("  %s: %d inspection rows across %d pages" % (county, total_rows, pages))

    merged = {}

    def absorb(page_html):
        for est in source.parse_listing(page_html, county):
            cur = merged.get(est["id"])
            if cur is None:
                merged[est["id"]] = est
            else:
                # Establishments straddle page boundaries; union the inspections.
                seen = {i["insp_id"] for i in cur["inspections"]}
                cur["inspections"].extend(
                    i for i in est["inspections"] if i["insp_id"] not in seen
                )

    absorb(first)
    if pages == 1:
        return merged

    starts = [n * source.PAGE_SIZE + 1 for n in range(1, pages)]

    def sweep(targets, concurrency, pause):
        """Fetch a set of page offsets; return the ones that failed."""
        failed = []
        done = [0]

        def work(start):
            try:
                html = source.fetch(source.search_url(county, start, since, until))
            except source.FetchError:
                return start, None
            time.sleep(pause)  # a county health server is not a CDN; pace ourselves
            return start, html

        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            for start, html in pool.map(work, targets):
                done[0] += 1
                if html is None:
                    failed.append(start)
                else:
                    absorb(html)
                if done[0] % 50 == 0:
                    log("    %s: %d/%d pages" % (county, done[0] + 1, pages))
        return failed

    failed = sweep(starts, workers, 0.2)
    # The server sheds load with 503s under concurrency. Anything that fell over
    # gets a second, slower, single-threaded pass rather than silently leaving a
    # hole in the data -- a missing page is 20 restaurants absent from the app.
    if failed:
        log("    %s: retrying %d failed pages serially" % (county, len(failed)))
        failed = sweep(failed, 1, 1.0)
    if failed:
        log("    !! %s: %d pages unrecoverable: %s" % (county, len(failed), failed[:10]))

    return merged


def load_store():
    """Rebuild the previous run's state from what it published.

    There used to be a data/store.json holding a second copy of all of this. It
    was the largest thing in the repository, it was rewritten in full on every
    run whether or not anything changed, and it could drift out of agreement
    with the payload it was supposed to be the source of. Everything in it is
    recoverable from the shards, so it is gone.

    Establishments that never made it into the payload -- no coordinates yet,
    or no inspections on record -- are kept in data/pending.json, because those
    are exactly the ones an incremental crawl would not rediscover.
    """
    store = {}

    manifest_path = os.path.join(WEB_PUBLIC, "counties.json")
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as fh:
            counties = [c["c"] for c in json.load(fh)["counties"]]
    else:
        counties = []

    history = {}
    hist_dir = os.path.join(WEB_PUBLIC, "history")
    if os.path.isdir(hist_dir):
        for name in os.listdir(hist_dir):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(hist_dir, name), encoding="utf-8") as fh:
                history.update(json.load(fh))

    for county in counties:
        path = os.path.join(WEB_PUBLIC, "places", "%s.json" % slug(county))
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for p in json.load(fh):
                store[p["i"]] = {
                    "id": p["i"], "name": p["n"], "street": p["a"],
                    "city": p["c"], "zip": p["z"], "county": p["o"],
                    "lat": p["y"], "lon": p["x"], "precision": p["p"],
                    "inspections": [
                        {"date": d, "score": sc, "insp_id": ii}
                        for d, sc, ii in history.get(str(p["i"]), [])
                    ],
                }

    # One-time migration off the old single-file store. Harmless once it is
    # gone, which is the point: nothing has to remember to remove this.
    legacy = os.path.join(DATA, "store.json")
    if not store and os.path.exists(legacy):
        with open(legacy, encoding="utf-8") as fh:
            store = {int(k): v for k, v in json.load(fh).get("places", {}).items()}
        log("Migrated %d establishments from the legacy store." % len(store))

    pending_path = os.path.join(DATA, "pending.json")
    if os.path.exists(pending_path):
        with open(pending_path, encoding="utf-8") as fh:
            for k, v in json.load(fh).get("places", {}).items():
                store.setdefault(int(k), v)

    return store


def slug(county):
    """A county name as a filename: lowercase, spaces to hyphens."""
    return county.lower().replace(" ", "-")


def write_shards(directory, shards):
    """Write every shard, and delete any file that is no longer one.

    A county that loses its last establishment, or a ZIP that empties out, has
    to take its file with it -- otherwise the directory keeps serving something
    the manifest no longer points at.
    """
    os.makedirs(directory, exist_ok=True)
    for key, body in shards.items():
        save_json(os.path.join(directory, "%s.json" % key), body, compact=True)
    for stale in os.listdir(directory):
        if stale.endswith(".json") and stale[:-5] not in shards:
            os.remove(os.path.join(directory, stale))


def save_json(path, obj, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        if compact:
            json.dump(obj, fh, separators=(",", ":"))
        else:
            json.dump(obj, fh, indent=1, sort_keys=True)
    os.replace(tmp, path)


def merge(store, fresh):
    """Fold a crawl's results into the store. Returns newly-seen inspections."""
    changes = []
    for eid, est in fresh.items():
        cur = store.get(eid)
        if cur is None:
            store[eid] = est
            # A brand new establishment is not an "alert" -- only report new
            # inspections at places we already knew about, so the first full
            # crawl doesn't notify about all 13,000 restaurants at once.
            continue
        known = {i["insp_id"] for i in cur["inspections"]}
        added = [i for i in est["inspections"] if i["insp_id"] not in known]
        if added:
            cur["inspections"].extend(added)
            for i in added:
                changes.append(
                    {
                        "id": eid,
                        "name": est["name"],
                        "date": i["date"],
                        "score": i["score"],
                        "grade": source.grade_for(i["score"]),
                    }
                )
        # Refresh mutable descriptive fields (renames, address corrections).
        for field in ("name", "street", "city", "zip", "county", "kind"):
            if est.get(field):
                cur[field] = est[field]
    return changes


def build_payload(store):
    """Compact structure for the client. Short keys: this ships over cell data.

    Grades are omitted -- they're a pure function of the score, so the client
    derives them and we save ~13k redundant strings.

    Full inspection history is *not* in here. It was half the wire size and the
    list needs none of it -- only the latest score, to draw the badge and to
    sort by. It ships separately, one file per ZIP, fetched when a sheet is
    opened. See build_history().
    """
    places = []
    for eid, est in sorted(store.items()):
        if "lat" not in est:
            continue  # unplaceable; distance sort would be meaningless
        history = sorted(est["inspections"], key=lambda i: i["date"], reverse=True)
        if not history:
            continue
        latest = history[0]
        places.append(
            {
                "i": eid,
                "n": est["name"],
                "a": est["street"],
                "c": est["city"],
                "z": est["zip"],
                "o": est["county"],
                "y": est["lat"],
                "x": est["lon"],
                "p": est.get("precision", 0),
                "l": [latest["date"], latest["score"], latest["insp_id"]],
                "hn": len(history),
            }
        )
    return places


def build_shards(places):
    """Group the payload by county, and describe each group in a manifest.

    The client loads the county it is standing in, draws the list from that,
    and pulls neighbouring counties outwards while you read -- so the manifest
    carries what it needs to rank them without downloading any of them: a
    centroid to measure from and a bounding box to measure to.

    Sharding also makes a run's commit a delta. The payload used to be one file
    rewritten in full every time, so git stored a new copy of all of it whether
    or not a single score had moved. Now only the counties that actually
    changed get written.
    """
    by_county = {}
    for p in places:
        by_county.setdefault(p["o"], []).append(p)

    manifest = []
    for county, rows in sorted(by_county.items()):
        lats = [r["y"] for r in rows]
        lons = [r["x"] for r in rows]
        manifest.append({
            "c": county,
            "s": slug(county),
            "n": len(rows),
            # Inspections and ZIPs are here so the coverage page can report on a
            # county without downloading it. They cost a few bytes each.
            "i": sum(r["hn"] for r in rows),
            "z": len({r["z"] for r in rows}),
            "y": round(sum(lats) / len(lats), 5),
            "x": round(sum(lons) / len(lons), 5),
            "b": [round(min(lats), 5), round(min(lons), 5),
                  round(max(lats), 5), round(max(lons), 5)],
        })
    return by_county, manifest


def build_history(store):
    """Inspection history, keyed by establishment id, split one file per ZIP.

    ZIP rather than a hash of the id, because the access pattern is
    geographic: you open two or three places near you, and near each other, so
    they land in the same file and the second and third opens cost nothing. An
    id-based shard would scatter the same three across three requests.

    They are small. The whole history set is ~320 KB gzipped across 9k places,
    so a median ZIP of 80 places is a few KB -- less than one map tile.
    """
    shards = {}
    for eid, est in sorted(store.items()):
        if "lat" not in est:
            continue
        history = sorted(est["inspections"], key=lambda i: i["date"], reverse=True)
        if not history:
            continue
        zipcode = est["zip"] or "00000"
        shards.setdefault(zipcode, {})[str(eid)] = [
            [i["date"], i["score"], i["insp_id"]] for i in history
        ]
    return shards


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--full", action="store_true", help="crawl all available history")
    g.add_argument("--since-days", type=int, default=45, help="crawl the last N days")
    ap.add_argument("--counties", default=",".join(COUNTIES),
                    help="comma-separated county names, or 'all' for Georgia")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--delay", type=float, default=0.5,
                    help="minimum seconds between requests, across all workers")
    ap.add_argument("--sub", default="",
                    help="within the selected counties, crawl the kth of n "
                         "parts. Used to split one job into several steps so "
                         "progress is visible while it runs.")
    ap.add_argument("--chunk", default="",
                    help="crawl the Nth of M slices of the county list, e.g. 2/4. "
                         "Because the store is rebuilt from what was published, "
                         "a slice merges into the existing data rather than "
                         "replacing it -- so a statewide crawl can be split "
                         "across several runs without losing anything.")
    ap.add_argument("--limit-pages", type=int, default=0, help="debug: stop early")
    ap.add_argument("--skip-geocode", action="store_true")
    ap.add_argument("--rebuild", action="store_true",
                    help="skip the crawl; re-geocode and rebuild the payload from store.json")
    args = ap.parse_args()

    counties = (GEORGIA if args.counties.strip().lower() == "all"
                else [c.strip() for c in args.counties.split(",") if c.strip()])
    unknown = [c for c in counties if c not in GEORGIA]
    if unknown:
        sys.exit("unknown counties: %s" % ", ".join(unknown))

    if args.chunk:
        try:
            index, parts = (int(x) for x in args.chunk.split("/", 1))
        except ValueError:
            sys.exit("--chunk wants N/M, e.g. 2/4")
        if not 1 <= index <= parts:
            sys.exit("--chunk %s is out of range" % args.chunk)
        size = math.ceil(len(counties) / parts)
        counties = counties[(index - 1) * size: index * size]
        log("Chunk %d of %d: %d counties" % (index, parts, len(counties)))

    if args.sub:
        try:
            k, n = (int(x) for x in args.sub.split("/", 1))
        except ValueError:
            sys.exit("--sub wants K/N, e.g. 3/8")
        if not 1 <= k <= n:
            sys.exit("--sub %s is out of range" % args.sub)
        size = math.ceil(len(counties) / n) or 1
        counties = counties[(k - 1) * size: k * size]
        log("  part %d of %d: %s" % (k, n, ", ".join(counties) or "(none)"))

    source.set_delay(args.delay)
    until = date.today() + timedelta(days=1)
    since = date(2010, 1, 1) if args.full else until - timedelta(days=args.since_days)
    log("Crawling %s from %s to %s"
        % (", ".join(counties) if len(counties) <= 6
           else "%d counties" % len(counties), since, until))
    log("  politeness: %d workers, >=%.2fs between requests" % (args.workers, args.delay))

    started = time.time()
    store = load_store()
    log("Store has %d establishments" % len(store))

    all_changes = []
    for county in counties if not args.rebuild else []:
        if args.limit_pages:
            source_pages = source.search_url(county, 1, since, until)
            fresh = {}
            for n in range(args.limit_pages):
                html = source.fetch(source.search_url(county, n * 20 + 1, since, until))
                for est in source.parse_listing(html, county):
                    fresh.setdefault(est["id"], est)
            log("  %s: %d establishments (limited)" % (county, len(fresh)))
        else:
            fresh = crawl_county(county, since, until, args.workers)
        log("  %s: %d establishments parsed" % (county, len(fresh)))
        all_changes.extend(merge(store, fresh))

    if not args.skip_geocode:
        cache = geocode.GeocodeCache(os.path.join(DATA, "geocache.json"))
        geocode.resolve(list(store.values()), cache, log=log)
        cache.save()

    places = build_payload(store)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Anything the payload cannot carry -- no coordinates yet, or no
    # inspections on record. Small, and kept because an incremental crawl would
    # not rediscover it.
    published = {p["i"] for p in places}
    pending = {str(k): v for k, v in store.items() if k not in published}
    save_json(os.path.join(DATA, "pending.json"), {"places": pending})

    by_county, manifest = build_shards(places)
    save_json(
        os.path.join(WEB_PUBLIC, "counties.json"),
        {"v": PAYLOAD_VERSION, "generated": generated,
         "places": len(places),
         "inspections": sum(p["hn"] for p in places),
         # Every county in the state, so the coverage page can show what is
         # missing as well as what is here.
         "all_counties": len(GEORGIA),
         "counties": manifest},
        compact=True,
    )
    write_shards(os.path.join(WEB_PUBLIC, "places"),
                 {slug(c): rows for c, rows in by_county.items()})
    write_shards(os.path.join(WEB_PUBLIC, "history"), build_history(store))
    save_json(
        os.path.join(DATA, "changes.json"),
        {"generated": generated, "changes": all_changes},
    )
    # The client polls this tiny file to decide whether to re-download the
    # dataset, and requests places.json?v=<generated> so the payload URL only
    # changes when the data does. That is what makes permanent caching safe.
    save_json(
        os.path.join(WEB_PUBLIC, "version.json"),
        {"generated": generated, "places": len(places)},
    )

    size = sum(
        os.path.getsize(os.path.join(WEB_PUBLIC, "places", f))
        for f in os.listdir(os.path.join(WEB_PUBLIC, "places"))
    )
    placed = len(places)
    exact = sum(1 for p in places if p["p"] == 2)
    log(
        "Done in %.0fs: %d establishments (%d placed, %d exact), "
        "%d new inspections, payload %.1f KB"
        % (time.time() - started, len(store), placed, exact, len(all_changes), size / 1024)
    )


if __name__ == "__main__":
    main()
