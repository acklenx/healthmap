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
MANIFEST = os.path.join(ROOT, "web", "public", "counties.json")

# Chains large enough that their absence means the crawl broke, not that they closed.
CANARIES = ["WAFFLE HOUSE", "CHICK-FIL-A", "MCDONALD'S", "CHUY'S"]
# What a county is allowed to lose between runs before it counts as a broken
# scrape rather than a few closures. Establishments close, but a fifth of a
# county does not close in a week.
MAX_COUNTY_DROP = 0.20
MAX_TOTAL_DROP = 0.10
BASELINE = os.path.join(ROOT, "data", "coverage.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--expect", action="append", default=[],
                    help="a name that must appear (repeatable)")
    args = ap.parse_args()

    with open(args.manifest, encoding="utf-8") as fh:
        data = json.load(fh)

    # The list is one file per county now, so read them back through the
    # manifest -- which also checks the manifest actually points at real files.
    pub = os.path.dirname(args.manifest)
    places = []
    failures = []
    for entry in data["counties"]:
        shard = os.path.join(pub, "places", "%s.json" % entry["s"])
        if not os.path.exists(shard):
            failures.append("manifest lists %s but %s is missing" % (entry["c"], shard))
            continue
        with open(shard, encoding="utf-8") as fh:
            rows = json.load(fh)
        if len(rows) != entry["n"]:
            failures.append("%s: manifest says %d places, shard holds %d"
                            % (entry["c"], entry["n"], len(rows)))
        places.extend(rows)

    if len(places) != data["places"]:
        failures.append("manifest totals %d places, shards hold %d"
                        % (data["places"], len(places)))
    names = [p["n"].upper() for p in places]
    counties = Counter(p["o"] for p in places)

    print("payload   %s" % data["generated"])
    print("places    %d" % len(places))
    # Counts are checked against the previous run rather than against numbers
    # written down by hand. Hand-set floors do not survive 159 counties: they
    # would all need choosing, they would all need maintaining, and any county
    # nobody thought about would have no floor at all -- which is exactly the
    # one that fails quietly.
    baseline = {}
    if os.path.exists(BASELINE):
        with open(BASELINE, encoding="utf-8") as fh:
            baseline = json.load(fh).get("counties", {})

    for county, n in sorted(counties.items()):
        was = baseline.get(county)
        if was is None:
            note = "  (new)"
        else:
            delta = n - was
            note = "  %+d" % delta if delta else ""
            if delta < 0 and abs(delta) > was * MAX_COUNTY_DROP:
                failures.append("%s fell from %d to %d establishments (-%.0f%%)"
                                % (county, was, n, 100 * abs(delta) / was))
                note += "  << DROP"
        print("  %-14s %5d%s" % (county, n, note))

    for county, was in sorted(baseline.items()):
        if county not in counties and was:
            failures.append("%s was crawled before (%d places) and is missing now"
                            % (county, was))

    total_was = sum(baseline.values())
    if total_was and len(places) < total_was * (1 - MAX_TOTAL_DROP):
        failures.append("total fell from %d to %d places" % (total_was, len(places)))

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

    # Coordinates must actually be in Georgia. This was the metro Atlanta box,
    # which is correct until the crawl leaves Atlanta and then fails every run.
    strays = [p for p in places
              if not (30.30 <= p["y"] <= 35.05 and -85.65 <= p["x"] <= -80.75)]
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
    # Only advance the baseline once everything else agreed, so a bad run cannot
    # quietly become the new normal for the next one to measure against.
    with open(BASELINE, "w", encoding="utf-8") as fh:
        json.dump({"generated": data["generated"], "counties": counties}, fh,
                  indent=1, sort_keys=True)

    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
