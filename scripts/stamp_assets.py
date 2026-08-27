#!/usr/bin/env python3
"""Stamp cache-busting ids onto the static assets.

    python3 scripts/stamp_assets.py            rewrite the stamps
    python3 scripts/stamp_assets.py --check    exit 1 if any are stale

Why buckets rather than one id
------------------------------
One id for everything is simpler, and it means every release re-downloads
Leaflet -- 192 KB, vendored at 1.9.4, and unchanged since the day it landed --
along with 28 KB of icons that have also never changed. Editing one line of CSS
should not cost a phone a quarter of a megabyte.

So assets are grouped by what changes together:

    app     app.js, styles.css, qr.js       ~120 KB, changes most commits
    vendor  Leaflet, its CSS and images     ~192 KB, changes when Leaflet does
    icons   the app icons                    ~28 KB, changes ~never

The ids are content hashes, not counters. A hand-set number is a thing you can
forget to bump -- which is the failure this exists to prevent, and it is silent.
A hash also means an unchanged bucket keeps its id across a release, which is
the whole point of splitting them up.

index.html, sw.js and version.json are deliberately not stamped: they are the
entry points, and something has to be fetched by a stable URL for any of the
rest to be discovered. They are served no-cache instead, via public/_headers.

places.json is already stamped by the crawler, as ?v=<generated>.
"""

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUB = ROOT / "web" / "public"

BUCKETS = {
    "app": ["app.js", "styles.css", "qr.js"],
    "vendor": [
        "vendor/leaflet/leaflet.js",
        "vendor/leaflet/leaflet.css",
        "vendor/leaflet/images/layers.png",
        "vendor/leaflet/images/layers-2x.png",
        "vendor/leaflet/images/marker-icon.png",
        "vendor/leaflet/images/marker-icon-2x.png",
        "vendor/leaflet/images/marker-shadow.png",
    ],
    "icons": [
        "icons/icon.svg",
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/icon-maskable-512.png",
    ],
}

# app.js carries the stamps it is hashed with, so the line is normalised out
# before hashing -- otherwise writing the hash changes the hash.
STAMP_LINE = re.compile(r'^const CACHE_ID = \{.*?\};$', re.M)
STAMP_PLACEHOLDER = 'const CACHE_ID = {};'


def digest(bucket):
    h = hashlib.sha256()
    for rel in BUCKETS[bucket]:
        path = PUB / rel
        if not path.exists():
            sys.exit("stamp_assets: missing %s" % rel)
        blob = path.read_bytes()
        if rel == "app.js":
            blob = STAMP_LINE.sub(STAMP_PLACEHOLDER, blob.decode("utf-8")).encode("utf-8")
        h.update(rel.encode("utf-8"))
        h.update(blob)
    return h.hexdigest()[:8]


def stamp(text, path_pattern, ident):
    """Point every reference to `path_pattern` at ?cache-id=<ident>."""
    return re.sub(
        r'(%s)(\?cache-id=[0-9a-f]+)?' % path_pattern,
        lambda m: "%s?cache-id=%s" % (m.group(1), ident),
        text,
    )


def build(ids):
    out = {}

    html = (PUB / "index.html").read_text()
    html = stamp(html, r'/styles\.css', ids["app"])
    html = stamp(html, r'/app\.js', ids["app"])
    html = stamp(html, r'/manifest\.webmanifest', ids["app"])
    html = stamp(html, r'/icons/icon\.svg', ids["icons"])
    html = stamp(html, r'/icons/icon-192\.png', ids["icons"])
    out["index.html"] = html

    manifest = (PUB / "manifest.webmanifest").read_text()
    manifest = stamp(manifest, r'/icons/icon[a-z0-9.-]*\.(?:png|svg)', ids["icons"])
    out["manifest.webmanifest"] = manifest

    app = (PUB / "app.js").read_text()
    app = STAMP_LINE.sub(
        'const CACHE_ID = { app: "%s", vendor: "%s", icons: "%s" };'
        % (ids["app"], ids["vendor"], ids["icons"]),
        app,
    )
    out["app.js"] = app

    sw = (PUB / "sw.js").read_text()
    # The shell cache is named for the app bucket, so a release that changes
    # nothing does not evict a cache that was already correct.
    sw = re.sub(r'const SHELL_VERSION = "[^"]*";',
                'const SHELL_VERSION = "%s";' % ids["app"], sw)
    for pattern, key in (
        (r'/app\.js', "app"), (r'/styles\.css', "app"), (r'/qr\.js', "app"),
        (r'/manifest\.webmanifest', "app"),
        (r'/vendor/leaflet/leaflet\.js', "vendor"),
        (r'/vendor/leaflet/leaflet\.css', "vendor"),
        (r'/icons/icon\.svg', "icons"),
        (r'/icons/icon-192\.png', "icons"),
        (r'/icons/icon-512\.png', "icons"),
    ):
        sw = stamp(sw, pattern, ids[key])
    out["sw.js"] = sw
    return out


def main():
    check = "--check" in sys.argv
    ids = {b: digest(b) for b in BUCKETS}
    wanted = build(ids)

    stale = []
    for name, text in wanted.items():
        if (PUB / name).read_text() != text:
            stale.append(name)

    for bucket, ident in sorted(ids.items()):
        size = sum((PUB / f).stat().st_size for f in BUCKETS[bucket])
        print("  %-7s %s  %5.0f KB  %d files" % (bucket, ident, size / 1024, len(BUCKETS[bucket])))

    if check:
        if stale:
            print("\nstale: %s" % ", ".join(stale))
            print("run: python3 scripts/stamp_assets.py")
            return 1
        print("\nStamps are current.")
        return 0

    for name in stale:
        (PUB / name).write_text(wanted[name])
    print("\n%s" % ("Rewrote " + ", ".join(stale) if stale else "Already current."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
