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
    path = os.path.join(DATA, "store.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return {int(k): v for k, v in json.load(fh).get("places", {}).items()}


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
    """
    places = []
    for eid, est in sorted(store.items()):
        if "lat" not in est:
            continue  # unplaceable; distance sort would be meaningless
        history = sorted(est["inspections"], key=lambda i: i["date"], reverse=True)
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
                "h": [[i["date"], i["score"], i["insp_id"]] for i in history],
            }
        )
    return {
        "v": PAYLOAD_VERSION,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "counties": COUNTIES,
        "places": places,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--full", action="store_true", help="crawl all available history")
    g.add_argument("--since-days", type=int, default=45, help="crawl the last N days")
    ap.add_argument("--counties", default=",".join(COUNTIES))
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit-pages", type=int, default=0, help="debug: stop early")
    ap.add_argument("--skip-geocode", action="store_true")
    ap.add_argument("--rebuild", action="store_true",
                    help="skip the crawl; re-geocode and rebuild the payload from store.json")
    args = ap.parse_args()

    counties = [c.strip() for c in args.counties.split(",") if c.strip()]
    until = date.today() + timedelta(days=1)
    since = date(2010, 1, 1) if args.full else until - timedelta(days=args.since_days)
    log("Crawling %s from %s to %s" % (", ".join(counties), since, until))

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

    save_json(os.path.join(DATA, "store.json"), {"places": {str(k): v for k, v in store.items()}})
    payload = build_payload(store)
    save_json(os.path.join(WEB_PUBLIC, "places.json"), payload, compact=True)
    save_json(
        os.path.join(DATA, "changes.json"),
        {"generated": payload["generated"], "changes": all_changes},
    )
    # The client polls this tiny file to decide whether to re-download the
    # dataset, and requests places.json?v=<generated> so the payload URL only
    # changes when the data does. That is what makes permanent caching safe.
    save_json(
        os.path.join(WEB_PUBLIC, "version.json"),
        {"generated": payload["generated"], "places": len(payload["places"])},
    )

    size = os.path.getsize(os.path.join(WEB_PUBLIC, "places.json"))
    placed = len(payload["places"])
    exact = sum(1 for p in payload["places"] if p["p"] == 2)
    log(
        "Done in %.0fs: %d establishments (%d placed, %d exact), "
        "%d new inspections, payload %.1f KB"
        % (time.time() - started, len(store), placed, exact, len(all_changes), size / 1024)
    )


if __name__ == "__main__":
    main()
