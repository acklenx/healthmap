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
    1  matched after stripping a suite/unit, or by the one-line parser
    0  ZIP centroid fallback

Misses are cached too. The batch endpoint is strict about locality -- it will
reject an otherwise valid row because DPH filed it under "SANDY SPRINGS" where
the Census street range is recorded against Atlanta -- so a slice of addresses
never matches no matter how often it is asked. Without a negative cache those
accumulate and get resubmitted on every crawl forever. They are recorded with a
miss count and an escalating retry delay instead, because the answer *can*
change: the reference data gains new construction a couple of times a year.
"""

import csv
import hashlib
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
ONELINE = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
BENCHMARK = "Public_AR_Current"
BATCH = 4000          # well under the 10k ceiling; keeps requests responsive
MAX_ATTEMPTS = 3

# How long to wait before asking about an address that missed, by how many
# times it has now missed. The reference data only changes a couple of times a
# year, so retrying monthly is a dozen futile round trips for two real chances.
MISS_BACKOFF_DAYS = (90, 180, 365)

# The one-line pass costs a request per address, so bound it. Anything over the
# cap simply waits for the next run -- it is logged, never dropped silently.
MAX_ONELINE = 400

# Georgia, with a little margin. A geocoder should not return anything outside
# this for an address a Georgia health department collected; if it does, the
# match is wrong, not precise -- which is the failure the one-line pass exists
# to guard against, since it drops the locality to get a hit.
#
# This was the metro Atlanta box while only three counties were crawled. That
# is a fine box right up until the crawl leaves Atlanta, at which point it
# starts throwing away every correct answer instead of the wrong ones.
BBOX_LAT = (30.30, 35.05)
BBOX_LON = (-85.65, -80.75)


def in_georgia(lat, lon):
    return BBOX_LAT[0] <= lat <= BBOX_LAT[1] and BBOX_LON[0] <= lon <= BBOX_LON[1]

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
        # None, not {} -- callers must not read "the service never answered"
        # as "none of these addresses exist", or an outage poisons the cache
        # with negative entries for every address in the batch.
        log("    geocoder batch failed permanently: %s" % last)
        return None

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


def _oneline(street, city, zipcode, log=print):
    """Geocode a single address through the one-line endpoint.

    The batch endpoint matches on parsed fields and rejects the row outright
    when the locality disagrees with its street file. The one-line endpoint
    parses the whole string and is markedly more forgiving: on the addresses
    batch has already rejected it recovers roughly one in five. The city and
    ZIP are still sent, so a hit is confirmed by its own locality rather than
    inferred, which is what makes it trustworthy enough to treat as precise.

    One request per address, so callers should bound how many they attempt.
    """
    addr = "%s, %s, GA %s" % (street, city, zipcode)
    query = urllib.parse.urlencode(
        {"address": addr, "benchmark": BENCHMARK, "format": "json"}
    )
    try:
        with urllib.request.urlopen("%s?%s" % (ONELINE, query), timeout=20) as resp:
            matches = json.load(resp)["result"]["addressMatches"]
    except (urllib.error.URLError, urllib.error.HTTPError, OSError,
            ValueError, KeyError) as exc:
        log("    one-line lookup failed for %s: %s" % (addr, exc))
        return None
    if not matches:
        return None
    coords = matches[0]["coordinates"]
    lat, lon = round(coords["y"], 6), round(coords["x"], 6)
    if not in_georgia(lat, lon):
        # A street of the same name in another state entirely.
        return None
    return lat, lon


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
        """Return a coordinate entry, or None. Negative entries are not hits."""
        entry = self.entries.get(self.key(street, city, zipcode))
        return entry if entry and "lat" in entry else None

    def miss_is_fresh(self, key, now=None):
        """True while a recorded miss is still within its backoff window.

        The delay is spread by a hash of the address so that a batch of misses
        recorded on the same night does not all come due on the same night
        months later -- otherwise the retries arrive as one herd and the "new
        addresses" line in the log becomes noise once a quarter.
        """
        entry = self.entries.get(key)
        if not entry or "lat" in entry:
            return False
        now = time.time() if now is None else now
        step = min(max(entry.get("miss", 1), 1), len(MISS_BACKOFF_DAYS)) - 1
        base = MISS_BACKOFF_DAYS[step]
        spread = max(base // 4, 1)
        jitter = int(hashlib.sha1(key.encode("utf-8")).hexdigest()[:8], 16) % spread
        return now < entry.get("t", 0) + (base + jitter) * 86400

    def record_miss(self, key, now=None):
        """Note that an address did not match, escalating its retry delay."""
        prev = self.entries.get(key) or {}
        if "lat" in prev:
            return
        self.entries[key] = {
            "miss": prev.get("miss", 0) + 1,
            "t": int(time.time() if now is None else now),
        }

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
    now = time.time()
    pending, deferred = {}, 0
    for p in places:
        hit = cache.get(p["street"], p["city"], p["zip"])
        if hit:
            p["lat"], p["lon"], p["precision"] = hit["lat"], hit["lon"], hit["q"]
            continue
        if not (p["street"] and p["city"]):
            continue
        key = cache.key(p["street"], p["city"], p["zip"])
        if cache.miss_is_fresh(key, now):
            deferred += 1
            continue
        pending.setdefault(key, []).append(p)

    if deferred:
        log("  %d establishments held back: address missed before, not due yet"
            % deferred)

    healthy = True
    if pending:
        log("  geocoding %d addresses (%d establishments)"
            % (len(pending), sum(len(v) for v in pending.values())))
        items = list(pending.items())

        # Pass 1: the address exactly as published.
        got, healthy = _run_pass(items, cache, 2, lambda s: s, log)

        # Pass 2: retry the misses without suite/unit designators.
        # Track what *this run* resolved rather than testing for a "lat" key --
        # a place can be carrying coordinates from an earlier run (a ZIP
        # centroid, or a since-changed address) and still need another attempt.
        misses = [(k, g) for k, g in items if k not in got]
        if misses and healthy:
            log("  retrying %d without suite/unit designators" % len(misses))
            got2, healthy = _run_pass(misses, cache, 1, strip_unit, log)
            misses = [(k, g) for k, g in misses if k not in got2]

        # Pass 3: the one-line endpoint, which tolerates the locality
        # disagreements that make the batch endpoint reject a whole row.
        if misses and healthy:
            misses = _oneline_pass(misses, cache, log)

        # Record what genuinely did not match, so it is not asked about nightly
        # forever. Never do this on the back of a failed request: an outage
        # would otherwise silence every address for a quarter.
        if healthy:
            for key, _ in misses:
                cache.record_miss(key, now)
            if misses:
                cache.save()
        elif misses:
            log("  geocoder unhealthy -- not recording %d misses" % len(misses))

    # Pass 4: anything still unplaced falls back to its ZIP centroid.
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


def _oneline_pass(items, cache, log=print):
    """One request per address. Returns the entries that were tried and missed.

    Anything beyond MAX_ONELINE is left untouched -- not tried, and so not
    recorded as a miss either -- and simply comes round again next run.
    """
    attempt, overflow = items[:MAX_ONELINE], items[MAX_ONELINE:]
    if overflow:
        log("  one-line pass: %d addresses, capped at %d (%d wait for next run)"
            % (len(items), MAX_ONELINE, len(overflow)))
    else:
        log("  one-line pass: %d addresses" % len(attempt))

    missed, hits = [], 0
    for key, group in attempt:
        p = group[0]
        found = _oneline(p["street"], p["city"], p["zip"], log=log)
        if not found:
            missed.append((key, group))
            continue
        lat, lon = found
        for q in group:
            q["lat"], q["lon"], q["precision"] = lat, lon, 1
        cache.entries[key] = {"lat": lat, "lon": lon, "q": 1}
        hits += 1
    log("    one-line: %d/%d matched" % (hits, len(attempt)))
    if hits:
        cache.save()
    return missed


def _run_pass(items, cache, precision, transform, log):
    """Geocode a batch of (cache-key, [places]) pairs.

    Returns (keys resolved, whether the endpoint actually answered).
    """
    resolved, healthy = set(), True
    for start in range(0, len(items), BATCH):
        chunk = items[start : start + BATCH]
        rows = []
        for n, (_, group) in enumerate(chunk):
            p = group[0]  # every place in the group has the same address
            rows.append((str(n), transform(p["street"]), p["city"], "GA", p["zip"]))
        found = _post_batch(rows, log=log)
        if found is None:
            healthy = False
            break
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
    return resolved, healthy
