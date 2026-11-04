#!/usr/bin/env python3
"""Things that must be true of the published data, together.

    python3 tests/test_data.py

verify_data.py checks that a crawl produced sane numbers. This checks the
files against each other and against the app that reads them -- the class of
failure where every file is individually fine and the app is still broken.

The one that bit: the crawl went statewide on 28 August and the payload
crossed WHOLE_DATASET_PLACES, which flips the app into "load nothing until
somebody says where they are". The branch had been there for a day and had
never been taken. It turned out its only escape hatch -- typing a ZIP code --
needed the places that had deliberately not been loaded, so the front door's
own suggestion answered "still loading restaurants" for two months. Nothing
was wrong with any single file. The dataset simply grew past what the client
could do with it.

So: no dependencies, runs in CI, and asserts the relationships.
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "web", "public")
sys.path.insert(0, os.path.join(ROOT, "crawler"))

import geocode  # noqa: E402

failures = []
checks = [0]


def check(label, ok, detail=""):
    checks[0] += 1
    if not ok:
        failures.append(label + (("\n      " + detail) if detail else ""))


def load(name):
    with open(os.path.join(PUBLIC, name), encoding="utf-8") as fh:
        return json.load(fh)


def app_constant(name):
    """Read a numeric constant out of app.js, so the test tracks the app."""
    src = open(os.path.join(PUBLIC, "app.js"), encoding="utf-8").read()
    m = re.search(r"^const %s = (\d+)" % re.escape(name), src, re.M)
    if not m:
        raise SystemExit("could not find %s in app.js" % name)
    return int(m.group(1))


def shard_places():
    places = []
    directory = os.path.join(PUBLIC, "places")
    for name in sorted(os.listdir(directory)):
        if name.endswith(".json"):
            with open(os.path.join(directory, name), encoding="utf-8") as fh:
                places += json.load(fh)
    return places


# ------------------------------------------------------------------ tests ---


def test_cold_start_is_answerable():
    """With too much data to load blind, the app must still be able to start.

    Past WHOLE_DATASET_PLACES the app downloads nothing until it has a
    position, and the only way to give it one by hand is a ZIP code or a city.
    Neither can be resolved from the places (there are none yet) or from the
    Census geocoder (it answers nothing for a bare ZIP), so locations.json is
    what makes the question answerable. If the payload is that big and the
    file is missing, the app has no front door.
    """
    manifest = load("counties.json")
    threshold = app_constant("WHOLE_DATASET_PLACES")
    needs_index = manifest["places"] > threshold
    print("  payload %s places, app loads it blind below %s -> cold-start index %s"
          % (f"{manifest['places']:,}", f"{threshold:,}",
             "required" if needs_index else "optional"))
    if not needs_index:
        return

    path = os.path.join(PUBLIC, "locations.json")
    check("locations.json is missing, so a cold start cannot resolve a ZIP",
          os.path.exists(path))
    if not os.path.exists(path):
        return

    index = load("locations.json")
    check("locations.json has no ZIPs", bool(index.get("z")))
    check("locations.json has no cities", bool(index.get("c")))


def test_every_zip_and_city_is_resolvable():
    """Anything the list can show, the location box can find."""
    if not os.path.exists(os.path.join(PUBLIC, "locations.json")):
        return
    index = load("locations.json")
    places = shard_places()

    zips = {p["z"] for p in places if p.get("z")}
    cities = {(p.get("c") or "").lower() for p in places if p.get("c")}
    missing_zips = sorted(zips - set(index.get("z", {})))
    missing_cities = sorted(cities - set(index.get("c", {})))

    print("  %d places -> %d ZIPs, %d cities; index has %d and %d"
          % (len(places), len(zips), len(cities),
             len(index.get("z", {})), len(index.get("c", {}))))
    check("ZIPs in the list that the location box cannot resolve",
          not missing_zips, ", ".join(missing_zips[:8]))
    check("cities in the list that the location box cannot resolve",
          not missing_cities, ", ".join(missing_cities[:8]))


def test_centroids_are_in_georgia():
    """A centroid in the Atlantic would send somebody's home pin there."""
    if not os.path.exists(os.path.join(PUBLIC, "locations.json")):
        return
    index = load("locations.json")
    bad = []
    for group in ("z", "c"):
        for key, row in index.get(group, {}).items():
            if len(row) != 3 or not geocode.in_georgia(row[0], row[1]) or row[2] < 1:
                bad.append("%s=%s" % (key, row))
    check("centroids outside Georgia, or malformed", not bad, ", ".join(bad[:6]))


def test_one_generation_everywhere():
    """Every published file belongs to the same crawl.

    The app asks for `?v=<version.json's stamp>`, so a file left behind by an
    earlier run is served under this run's URL and cached as if it were
    current -- which is exactly the failure the stamping scheme exists to
    prevent, arriving through the back door.
    """
    stamp = load("version.json")["generated"]
    for name in ("counties.json", "chains.json", "trend.json", "changes.json",
                 "locations.json"):
        path = os.path.join(PUBLIC, name)
        if not os.path.exists(path):
            continue
        check("%s belongs to a different crawl than version.json" % name,
              load(name).get("generated") == stamp,
              "%s vs %s" % (load(name).get("generated"), stamp))


def test_manifest_matches_the_shards():
    """Every county the manifest offers has a file behind it."""
    manifest = load("counties.json")
    missing, wrong = [], []
    total = 0
    for county in manifest["counties"]:
        path = os.path.join(PUBLIC, "places", "%s.json" % county["s"])
        if not os.path.exists(path):
            missing.append(county["s"])
            continue
        with open(path, encoding="utf-8") as fh:
            rows = json.load(fh)
        total += len(rows)
        if len(rows) != county["n"]:
            wrong.append("%s says %d, has %d" % (county["s"], county["n"], len(rows)))
    check("counties the manifest offers but has no shard for", not missing,
          ", ".join(missing[:8]))
    check("counties whose count disagrees with their shard", not wrong,
          "; ".join(wrong[:5]))
    check("the manifest's total disagrees with the shards",
          total == manifest["places"], "%d vs %d" % (total, manifest["places"]))


def test_history_shards_cover_the_list():
    """Opening a place fetches history/<its ZIP>.json, so that must exist."""
    places = shard_places()
    have = {n[:-5] for n in os.listdir(os.path.join(PUBLIC, "history"))
            if n.endswith(".json")}
    want = {p["z"] for p in places if p.get("z") and p.get("hn")}
    missing = sorted(want - have)
    check("places whose history shard is not published", not missing,
          "%d ZIPs, e.g. %s" % (len(missing), ", ".join(missing[:8])))


def main():
    print("published data")
    for test in (test_cold_start_is_answerable,
                 test_every_zip_and_city_is_resolvable,
                 test_centroids_are_in_georgia,
                 test_one_generation_everywhere,
                 test_manifest_matches_the_shards,
                 test_history_shards_cover_the_list):
        test()

    if failures:
        print("\nFAILED %d of %d checks:\n" % (len(failures), checks[0]))
        for f in failures:
            print("  - %s" % f)
        return 1
    print("%d checks passed." % checks[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
