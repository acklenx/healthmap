#!/usr/bin/env python3
"""Check a crawl's assumptions before it spends an hour disproving them.

    python3 scripts/preflight.py --counties all --chunk 1/4

The failure this exists for: a full crawl of 40 counties ran for 27 minutes,
crawled correctly, and would have been thrown away by a payload check that
still had a metro-Atlanta bounding box in it. Nothing was wrong with the crawl.
Everything was knowable in advance.

So: everything that can be checked without crawling, checked first, in seconds.
Anything here that fails would have failed the run anyway -- just later, and
after the expensive part.
"""

import argparse
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "crawler"))

import crawl      # noqa: E402
import geocode    # noqa: E402
import source     # noqa: E402

GEOGRAPHY = os.path.join(ROOT, "web", "public", "georgia.json")


def selected(args):
    names = (crawl.GEORGIA if args.counties.strip().lower() == "all"
             else [c.strip() for c in args.counties.split(",") if c.strip()])
    if args.chunk:
        i, n = (int(x) for x in args.chunk.split("/", 1))
        size = math.ceil(len(names) / n)
        names = names[(i - 1) * size: i * size]
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--counties", default=",".join(crawl.COUNTIES))
    ap.add_argument("--chunk", default="")
    args = ap.parse_args()

    failures = []
    counties = selected(args)
    print("plan      %d counties: %s" % (
        len(counties),
        ", ".join(counties) if len(counties) <= 8
        else "%s … %s" % (counties[0], counties[-1])))

    if not counties:
        failures.append("the plan is empty -- nothing would be crawled")

    unknown = [c for c in counties if c not in crawl.GEORGIA]
    if unknown:
        failures.append("not Georgia counties: %s" % ", ".join(unknown))

    # The one that bit. Every county the run intends to crawl has to fit inside
    # the box the payload check will later measure it against.
    with open(GEOGRAPHY, encoding="utf-8") as fh:
        geo = {c["c"]: c for c in json.load(fh)["counties"]}
    outside = [c for c in counties
               if c in geo and not geocode.in_georgia(geo[c]["y"], geo[c]["x"])]
    print("bbox      lat %.2f..%.2f  lon %.2f..%.2f"
          % (geocode.BBOX_LAT[0], geocode.BBOX_LAT[1],
             geocode.BBOX_LON[0], geocode.BBOX_LON[1]))
    if outside:
        failures.append(
            "%d planned counties fall outside the coordinate bounds, so their "
            "places would be rejected after crawling: %s"
            % (len(outside), ", ".join(outside[:6])))
    else:
        print("          all %d planned counties fit inside it" % len(counties))

    missing_geo = [c for c in counties if c not in geo]
    if missing_geo:
        failures.append("no geography for: %s" % ", ".join(missing_geo[:6]))

    # The source, on a county this run actually intends to crawl.
    probe = counties[0] if counties else None
    if probe:
        try:
            from datetime import date, timedelta
            until = date.today() + timedelta(days=1)
            page = source.fetch(source.search_url(probe, 1, until - timedelta(days=30), until))
            rows = source.result_count(page)
            print("source    %s answered, %d inspection rows in the last 30 days" % (probe, rows))
            if "<html" not in page.lower():
                failures.append("the source returned something that is not a page")
        except Exception as exc:
            failures.append("could not reach the source for %s: %s" % (probe, exc))

    # The geocoder, before thousands of new addresses depend on it.
    rows = [(str(i), st, city, "GA", z)
            for i, (st, city, z) in enumerate(__import__("check_geocoder").CONTROLS)]
    found = source and geocode._post_batch(rows)
    ok = sum(1 for i in range(len(rows))
             if found and found.get(str(i)) and geocode.in_georgia(*found[str(i)]))
    print("geocoder  %d of %d control addresses matched" % (ok, len(rows)))
    if ok < 3:
        failures.append("geocoder answered %d of %d controls" % (ok, len(rows)))

    if failures:
        print("\nPREFLIGHT FAILED:")
        for f in failures:
            print("  - %s" % f)
        print("\nNothing was crawled. Fix these and dispatch again.")
        return 1

    print("\nPreflight passed. Safe to crawl.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
