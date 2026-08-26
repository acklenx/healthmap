"""Turn street addresses into coordinates using the US Census batch geocoder.

The inspection source publishes addresses but no coordinates, and "sort by
nearest" needs coordinates. The Census geocoder is free, has no API key, and
permits batches of up to 10k addresses -- but it only knows street ranges, so a
slice of addresses never match (new construction, mall food courts, suite-only
addresses). Rather than drop those, we fall back to a ZIP centroid computed from
the addresses that *did* match, and mark the precision so the UI can say
"approximate". Every establishment therefore gets a position and appears in the
list; only its distance is fuzzier.

Precision levels, highest to lowest:
    2  exact rooftop/street-range match
    1  match after stripping a suite/unit designator
    0  ZIP centroid fallback
"""

import csv
import io
import json
import os
import re
import time
import urllib.error
import urllib.request

ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
BENCHMARK = "Public_AR_Current"
BATCH = 4000          # well under the 10k ceiling; keeps requests responsive
MAX_ATTEMPTS = 3

# Suite/unit designators confuse the street-range matcher more often than they
# help, so we retry without them.
_UNIT_RE = re.compile(
    r"\s+(?:STE|SUITE|SPC|UNIT|APT|BLDG|BUILDING|RM|ROOM|FL|FLOOR|#)\s*[\w-]*\s*$",
    re.I,
)
_TRAILING_HASH_RE = re.compile(r"\s*#\s*[\w-]+\s*$")


def strip_unit(street):
    prev = None
    out = street.strip()
    while out != prev:
        prev = out
        out = _UNIT_RE.sub("", out).strip()
        out = _TRAILING_HASH_RE.sub("", out).strip()
    return out or street.strip()


def _multipart(rows):
    """Encode the address CSV as multipart/form-data (stdlib only)."""
    boundary = "----geocode-boundary-7f3a9c"
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    for key, street, city, state, zipcode in rows:
        writer.writerow([key, street, city, state, zipcode])

    parts = []
    for name, value in (("benchmark", BENCHMARK),):
        parts.append(
            '--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'
            % (boundary, name, value)
        )
    parts.append(
        '--%s\r\nContent-Disposition: form-data; name="addressFile"; '
        'filename="addresses.csv"\r\nContent-Type: text/csv\r\n\r\n%s\r\n'
        % (boundary, buf.getvalue())
    )
    parts.append("--%s--\r\n" % boundary)
    body = "".join(parts).encode("utf-8")
    return body, "multipart/form-data; boundary=%s" % boundary


def _post_batch(rows, log=print):
    body, content_type = _multipart(rows)
    last = None
    for attempt in range(MAX_ATTEMPTS):
        req = urllib.request.Request(
            ENDPOINT, data=body, headers={"Content-Type": content_type}
        )
        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            break
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            last = exc
            log("    geocoder retry %d/%d: %s" % (attempt + 1, MAX_ATTEMPTS, exc))
            time.sleep(5 * (attempt + 1))
    else:
        log("    geocoder batch failed permanently: %s" % last)
        return {}

    found = {}
    for row in csv.reader(io.StringIO(text)):
        # id, input, status, matchtype, matched-address, "lon,lat", tigerid, side
        if len(row) < 6 or row[2] != "Match" or "," not in row[5]:
            continue
        try:
            lon, lat = (float(v) for v in row[5].split(",", 1))
        except ValueError:
            continue
        found[row[0]] = (round(lat, 6), round(lon, 6))
    return found


class GeocodeCache:
    """Address -> coordinate cache, persisted between crawls.

    Keyed by normalized address text rather than establishment id, so a
    renamed or re-permitted business at a known address costs nothing.
    """

    def __init__(self, path):
        self.path = path
        self.entries = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                self.entries = json.load(fh).get("entries", {})

    @staticmethod
    def key(street, city, zipcode):
        return re.sub(r"\s+", " ", ("%s|%s|%s" % (street, city, zipcode)).upper()).strip()

    def get(self, street, city, zipcode):
        return self.entries.get(self.key(street, city, zipcode))

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"entries": self.entries}, fh, sort_keys=True, separators=(",", ":"))
        os.replace(tmp, self.path)


def _zip_centroids(cache):
    """Average the precisely-geocoded points in each ZIP to get a centroid."""
    acc = {}
    for key, val in cache.entries.items():
        if val.get("q", 0) < 1:
            continue
        zipcode = key.rsplit("|", 1)[-1].strip()
        if len(zipcode) != 5 or not zipcode.isdigit():
            continue
        bucket = acc.setdefault(zipcode, [0.0, 0.0, 0])
        bucket[0] += val["lat"]
        bucket[1] += val["lon"]
        bucket[2] += 1
    return {
        z: (round(la / n, 6), round(lo / n, 6)) for z, (la, lo, n) in acc.items() if n
    }


def resolve(places, cache, log=print):
    """Fill in lat/lon/precision on each place, geocoding whatever is missing.

    Note that several establishments routinely share one address -- food courts,
    strip malls, and airport terminals especially -- so addresses are geocoded
    once and the result applied to every establishment at that address.
    """
    pending = {}
    for p in places:
        hit = cache.get(p["street"], p["city"], p["zip"])
        if hit:
            p["lat"], p["lon"], p["precision"] = hit["lat"], hit["lon"], hit["q"]
            continue
        if p["street"] and p["city"]:
            pending.setdefault(cache.key(p["street"], p["city"], p["zip"]), []).append(p)

    if pending:
        log("  geocoding %d new addresses (%d establishments)"
            % (len(pending), sum(len(v) for v in pending.values())))
        items = list(pending.items())

        # Pass 1: the address exactly as published.
        got = _run_pass(items, cache, precision=2, transform=lambda s: s, log=log)

        # Pass 2: retry the misses without suite/unit designators.
        # Track what *this run* resolved rather than testing for a "lat" key --
        # a place can be carrying coordinates from an earlier run (a ZIP
        # centroid, or a since-changed address) and still need another attempt.
        misses = [(k, p) for k, p in items if k not in got]
        if misses:
            log("  retrying %d without suite/unit designators" % len(misses))
            _run_pass(misses, cache, precision=1, transform=strip_unit, log=log)

    # Pass 3: anything still unplaced falls back to its ZIP centroid.
    centroids = _zip_centroids(cache)
    unplaced = [p for p in places if "lat" not in p]
    for p in unplaced:
        c = centroids.get(p["zip"])
        if c:
            p["lat"], p["lon"], p["precision"] = c[0], c[1], 0
    still = [p for p in places if "lat" not in p]
    if unplaced:
        log(
            "  %d fell back to ZIP centroid, %d could not be placed at all"
            % (len(unplaced) - len(still), len(still))
        )
    return places


def _run_pass(items, cache, precision, transform, log):
    """Geocode a batch of (cache-key, [places]) pairs. Returns the keys resolved."""
    resolved = set()
    for start in range(0, len(items), BATCH):
        chunk = items[start : start + BATCH]
        rows = []
        for n, (_, group) in enumerate(chunk):
            p = group[0]  # every place in the group has the same address
            rows.append((str(n), transform(p["street"]), p["city"], "GA", p["zip"]))
        found = _post_batch(rows, log=log)
        for n, (key, group) in enumerate(chunk):
            hit = found.get(str(n))
            if not hit:
                continue
            for p in group:
                p["lat"], p["lon"], p["precision"] = hit[0], hit[1], precision
            cache.entries[key] = {"lat": hit[0], "lon": hit[1], "q": precision}
            resolved.add(key)
        log(
            "    batch %d-%d: %d/%d matched"
            % (start + 1, start + len(chunk), len(found), len(chunk))
        )
        cache.save()
    return resolved
