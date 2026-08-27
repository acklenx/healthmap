#!/usr/bin/env python3
"""Build web/public/georgia.json from the Census county gazetteer.

The coverage map needs to draw counties that have *not* been crawled — that is
the whole point of it, since an uncrawled county is otherwise indistinguishable
from an empty one. The crawler only knows about counties it has visited, so the
geography has to come from somewhere else.

The US Census gazetteer is the same source the geocoder already uses, it is
public domain, and county boundaries do not move. Run once; commit the result.

    python3 scripts/make_counties.py
"""

import json
import math
import os
import sys
import urllib.request

URL = ("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
       "2023_Gazetteer/2023_gaz_counties_13.txt")          # 13 = Georgia
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "web", "public", "georgia.json")


def slug(name):
    return name.lower().replace(" ", "-")


def main():
    with urllib.request.urlopen(URL, timeout=60) as resp:
        rows = resp.read().decode("utf-8").splitlines()

    header = [h.strip() for h in rows[0].split("\t")]
    idx = {name: i for i, name in enumerate(header)}

    counties = []
    for line in rows[1:]:
        if not line.strip():
            continue
        f = [c.strip() for c in line.split("\t")]
        name = f[idx["NAME"]].removesuffix(" County")
        # A radius that makes a county's marker roughly its own size on the
        # map, so the shape of the state reads without carrying boundary
        # polygons -- which would be two orders of magnitude more data for a
        # picture this small.
        sq_mi = float(f[idx["ALAND_SQMI"]])
        counties.append({
            "c": name,
            "s": slug(name),
            "y": round(float(f[idx["INTPTLAT"]]), 5),
            "x": round(float(f[idx["INTPTLONG"]]), 5),
            "r": round(math.sqrt(sq_mi / math.pi), 1),      # miles
        })

    counties.sort(key=lambda c: c["c"])
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump({"counties": counties}, fh, separators=(",", ":"))

    print("%d counties -> %s (%.1f KB)"
          % (len(counties), OUT, os.path.getsize(OUT) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
