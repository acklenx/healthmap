#!/usr/bin/env python3
"""Sanity-check a built payload before it goes live.

Scraped data fails quietly: a markup change upstream turns into an empty list
or a county silently missing, and the app still "works". These are the checks
that would have caught that.

    python3 scripts/verify_data.py [--expect "CHUY'S" --expect "WAFFLE HOUSE"]
"""

import argparse
import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAYLOAD = os.path.join(ROOT, "web", "public", "places.json")

# Chains large enough that their absence means the crawl broke, not that they closed.
CANARIES = ["WAFFLE HOUSE", "CHICK-FIL-A", "MCDONALD'S", "CHUY'S"]
MIN_PER_COUNTY = {"Cobb": 1500, "Fulton": 3000, "Cherokee": 400}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", default=PAYLOAD)
    ap.add_argument("--expect", action="append", default=[],
                    help="a name that must appear (repeatable)")
    args = ap.parse_args()

    with open(args.payload, encoding="utf-8") as fh:
        data = json.load(fh)

    places = data["places"]
    failures = []
    names = [p["n"].upper() for p in places]
    counties = Counter(p["o"] for p in places)

    print("payload   %s" % data["generated"])
    print("places    %d" % len(places))
    for county, n in sorted(counties.items()):
        floor = MIN_PER_COUNTY.get(county, 0)
        flag = "" if n >= floor else "  << LOW (expected >= %d)" % floor
        print("  %-10s %5d%s" % (county, n, flag))
        if n < floor:
            failures.append("%s has only %d establishments" % (county, n))

    for county in MIN_PER_COUNTY:
        if county not in counties:
            failures.append("county missing entirely: %s" % county)

    # Every place must be positioned, or it can't be sorted by distance.
    unplaced = [p for p in places if p.get("y") is None or p.get("x") is None]
    if unplaced:
        failures.append("%d places have no coordinates" % len(unplaced))

    precision = Counter(p["p"] for p in places)
    exact = precision.get(2, 0) + precision.get(1, 0)
    pct = 100.0 * exact / len(places) if places else 0
    print("geocoded  %.1f%% to a street address, %d via ZIP centroid"
          % (pct, precision.get(0, 0)))
    if pct < 70:
        failures.append("only %.1f%% geocoded precisely" % pct)

    # Coordinates must actually be in metro Atlanta.
    strays = [p for p in places
              if not (33.4 <= p["y"] <= 34.6 and -85.2 <= p["x"] <= -84.0)]
    if strays:
        failures.append("%d places outside the expected bounding box (e.g. %s)"
                        % (len(strays), strays[0]["n"]))

    no_history = [p for p in places if not p.get("l")]
    if no_history:
        failures.append("%d places have no inspections" % len(no_history))

    # History lives in web/public/history/<zip>.json now, not in the payload.
    # Check it here too: the payload can look perfect while the shards it
    # points at are missing, and that only shows up when a sheet is opened.
    hist_dir = os.path.join(ROOT, "web", "public", "history")
    shards = {}
    if os.path.isdir(hist_dir):
        for name in os.listdir(hist_dir):
            if name.endswith(".json"):
                with open(os.path.join(hist_dir, name), encoding="utf-8") as fh:
                    shards[name[:-5]] = json.load(fh)

    missing_shards = sorted({p["z"] for p in places if p["z"] not in shards})
    if missing_shards:
        failures.append("%d ZIPs have no history shard (e.g. %s)"
                        % (len(missing_shards), missing_shards[0]))

    orphans = [p for p in places
               if p["z"] in shards and str(p["i"]) not in shards[p["z"]]]
    if orphans:
        failures.append("%d places have no history in their shard (e.g. %s)"
                        % (len(orphans), orphans[0]["n"]))

    scores = [h[1] for entries in shards.values() for rows in entries.values() for h in rows]
    bad = [s for s in scores if not 0 <= s <= 100]
    shard_bytes = sum(os.path.getsize(os.path.join(hist_dir, "%s.json" % z)) for z in shards) if shards else 0
    print("inspections %d across %d ZIP shards (%.0f KB), score range %d-%d"
          % (len(scores), len(shards), shard_bytes / 1024, min(scores), max(scores)))
    if bad:
        failures.append("%d scores outside 0-100" % len(bad))

    counted = sum(p.get("hn", 0) for p in places)
    if counted != len(scores):
        failures.append("payload claims %d inspections, shards hold %d" % (counted, len(scores)))

    for expected in CANARIES + args.expect:
        hits = [n for n in names if expected.upper() in n]
        print("  %-16s %s" % (expected, "%d found" % len(hits) if hits else "NOT FOUND"))
        if not hits:
            failures.append("expected establishment missing: %s" % expected)

    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  - %s" % f)
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
