#!/usr/bin/env python3
"""Canary for the US Census geocoder.

`verify_data.py` cannot detect a geocoder outage. Its geocode check is on the
*aggregate* share of placed addresses, and that number is dominated by the
thousands of coordinates already sitting in geocache.json -- so the service
could be returning nothing at all for weeks and the payload would still report
88% placed while new establishments quietly piled up without coordinates.

Nor can a match-rate alarm work. The addresses the crawler asks about are, by
construction, the ones that have not matched before: mall food courts, airport
concourses, suite-only addresses. A low match rate there is normal, so a
threshold on it would cry wolf every night.

So ask a question with a known answer instead. These five are ordinary metro
Atlanta street addresses that a healthy geocoder matches every time. If most of
them fail, the service is broken -- not the addresses.

Run as the last step of the refresh workflow, after the data has been committed
and deployed: a sick geocoder is worth shouting about, but it is not a reason
to withhold a set of perfectly good inspection scores.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "crawler"))

import geocode  # noqa: E402

# Spread across the state, not clustered in one metro. A geocoder that has
# quietly lost one region should not be able to pass on the strength of another.
CONTROLS = [
    ("191 PEACHTREE ST NE", "ATLANTA", "30303"),
    ("100 CHEROKEE ST", "MARIETTA", "30060"),
    ("2 E BAY ST", "SAVANNAH", "31401"),
    ("1400 COLEMAN AVE", "MACON", "31207"),
    ("1000 BROADWAY", "COLUMBUS", "31901"),
    ("100 CHERRY ST", "ATHENS", "30601"),
]
NEEDED = 3


def main():
    rows = [(str(i), st, city, "GA", z) for i, (st, city, z) in enumerate(CONTROLS)]
    found = geocode._post_batch(rows)

    if found is None:
        print("::error title=Geocoder unreachable::The Census batch geocoder did "
              "not answer. New addresses cannot be placed until it recovers.")
        return 1

    ok = 0
    for i, (st, city, z) in enumerate(CONTROLS):
        hit = found.get(str(i))
        sane = hit and geocode.in_georgia(*hit)
        if sane:
            ok += 1
        print("  %-4s %s, %s %s%s" % (
            "ok" if sane else "FAIL", st, city, z,
            "" if not hit or sane else "   <- matched outside Georgia: %s" % (hit,),
        ))

    print("\n%d/%d control addresses matched (need %d)" % (ok, len(CONTROLS), NEEDED))
    if ok < NEEDED:
        print("::error title=Geocoder degraded::Only %d of %d known-good addresses "
              "matched. New establishments will fall back to ZIP centroids until "
              "this recovers." % (ok, len(CONTROLS)))
        return 1
    print("Geocoder healthy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
