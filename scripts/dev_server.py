#!/usr/bin/env python3
"""Local preview server for the Score web app.

Serves web/public as static files and implements the handful of API routes that
run as Cloudflare Pages Functions in production, so the app can be exercised
end to end -- including tapping into an inspection's violations -- without
deploying anything.

    python3 scripts/dev_server.py [--port 8110]
"""

import argparse
import json
import os
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "web", "public")
sys.path.insert(0, os.path.join(ROOT, "crawler"))

import source  # noqa: E402

COUNTIES = {"Cobb", "Cherokee", "Fulton"}
_report_cache = {}
_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=PUBLIC, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("  %s\n" % (fmt % args))

    def _json(self, obj, status=200, cache="no-store"):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/report"):
            return self._report()
        if self.path.startswith("/api/geocode"):
            return self._geocode()
        if self.path.startswith("/api/vapid"):
            # Alerts need real VAPID keys and D1; not wired up locally.
            return self._json({"error": "alerts not configured in dev"}, 503)
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._json({"ok": True, "dev": True})
        self.send_error(404)

    def _report(self):
        from urllib.parse import parse_qs, urlparse

        q = parse_qs(urlparse(self.path).query)
        eid = (q.get("id") or [""])[0]
        insp = (q.get("insp") or [""])[0]
        county = (q.get("county") or [""])[0]
        if not re.fullmatch(r"\d{1,12}", eid) or not re.fullmatch(r"\d{1,12}", insp) \
                or county not in COUNTIES:
            return self._json({"error": "bad request"}, 400)

        key = (eid, insp, county)
        with _lock:
            hit = _report_cache.get(key)
        if hit:
            return self._json(hit, cache="public, max-age=31536000, immutable")

        try:
            page = source.fetch(source.report_url(int(eid), int(insp), county))
        except source.FetchError as exc:
            return self._json({"error": "upstream: %s" % exc}, 502)

        report = source.parse_report(page)
        report.update({"id": int(eid), "insp": int(insp), "county": county})
        with _lock:
            _report_cache[key] = report
        return self._json(report, cache="public, max-age=31536000, immutable")

    def _geocode(self):
        """Mirrors functions/api/geocode.js — one-line address lookup."""
        import json as _json
        import urllib.parse
        import urllib.request
        from urllib.parse import parse_qs, urlparse

        q = (parse_qs(urlparse(self.path).query).get("q") or [""])[0].strip()
        if not q or len(q) > 200:
            return self._json({"error": "bad request"}, 400)

        address = q if re.search(r"\b(GA|GEORGIA)\b", q, re.I) else q + ", GA"
        url = (
            "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?"
            + urllib.parse.urlencode(
                {"address": address, "benchmark": "Public_AR_Current", "format": "json"}
            )
        )
        try:
            req = urllib.request.Request(url, headers={"User-Agent": source.UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = _json.loads(resp.read().decode("utf-8", errors="replace"))
        except Exception as exc:  # noqa: BLE001 - dev convenience
            return self._json({"error": "geocoder: %s" % exc}, 502)

        matches = (data.get("result") or {}).get("addressMatches") or []
        if not matches:
            return self._json({"lat": None, "lon": None})
        m = matches[0]
        parts = [p.strip() for p in str(m.get("matchedAddress", "")).split(",")]
        label = parts[1].title() if len(parts) > 1 else q
        return self._json(
            {"lat": m["coordinates"]["y"], "lon": m["coordinates"]["x"], "label": label}
        )

    def end_headers(self):
        # Never let the browser cache app code during development.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8110)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    if not os.path.exists(os.path.join(PUBLIC, "counties.json")):
        print("! web/public/counties.json is missing -- run crawler/crawl.py first")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("Score dev server -> http://localhost:%d" % args.port)
    print("Serving %s (api/report proxies the live DPH site)" % PUBLIC)
    server.serve_forever()


if __name__ == "__main__":
    main()
