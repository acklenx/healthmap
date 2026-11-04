#!/usr/bin/env python3
"""Hold both parsers to the same real pages.

    python3 tests/test_parsers.py

The inspection source has no API, so this project reads its HTML -- twice. The
nightly crawl reads it in Python (crawler/source.py) and the edge reads it in
JavaScript (web/functions/api/report.js, web/functions/api/place.js), because
one of them runs in GitHub Actions and the other runs in a Cloudflare worker
and neither can call the other.

Two implementations of one parser can quietly disagree, and the disagreement is
invisible: the crawl keeps publishing, the endpoint keeps answering, and only
the numbers differ. So every fixture is parsed by both and the results must
match field for field. The fixtures themselves are real pages (see
scripts/make_fixtures.py), which is also what makes the "expected" values below
worth asserting: they are what the health department actually published.
"""

import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
sys.path.insert(0, os.path.join(ROOT, "crawler"))

import source  # noqa: E402

failures = []
checks = [0]


def check(label, got, want):
    checks[0] += 1
    if got != want:
        failures.append("%s\n      expected: %r\n      got:      %r" % (label, want, got))


def check_that(label, ok):
    checks[0] += 1
    if not ok:
        failures.append(label)


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        return fh.read()


def from_js(mode, name):
    """What the edge parsers see in the same file."""
    out = subprocess.run(
        [node(), os.path.join(ROOT, "tests", "parsers.mjs"), mode,
         os.path.join(FIXTURES, name)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise SystemExit("node failed on %s:\n%s" % (name, out.stderr.strip()))
    return json.loads(out.stdout)


def node():
    return os.environ.get("NODE", "node")


# ---------------------------------------------------------------- listings ---
#
# One establishment, its whole history, and the search form appended below it.

LISTINGS = {
    "search-single.html": {
        "rows": 5,
        "establishments": [(3161473, "JERUSALEM BAKERY AND GRILL", 5)],
        # Newest last on the page; the endpoint sorts, the parser does not.
        "inspections": [("2022-12-20", 86, 57329607), ("2023-07-06", 96, 57357596),
                        ("2024-06-25", 91, 57412788), ("2025-11-24", 95, 57499021),
                        ("2026-05-19", 100, 57530780)],
    },
    # Page two of a chain-name search: four establishments, one inspection
    # each, reached with the &start=21 offset. 24 rows across two pages is
    # what makes /api/place page at all.
    "search-chain-page2.html": {
        "rows": 24,
        "establishments": [(9486187, "Subway #58984", 1), (3135040, "Subway #63473", 1),
                           (2490796, "Subway #7931", 1), (12772724, "Subway 45710", 1)],
    },
    # A window with no inspections in it -- the answer almost every freshness
    # check gets, and the one that must not be mistaken for a parse failure.
    "search-empty.html": {"rows": 0, "establishments": []},
}


def python_listing(page):
    """parse_listing's output, reduced to what both parsers claim to know."""
    return [
        {
            "id": est["id"],
            "name": est["name"],
            "kind": est["kind"],
            "inspections": [
                {"date": i["date"], "score": i["score"], "inspId": i["insp_id"]}
                for i in est["inspections"]
            ],
        }
        for est in parse_listing_in_page_order(page)
    ]


def parse_listing_in_page_order(page):
    # parse_listing already yields page order; county only labels the rows.
    return source.parse_listing(page, "Cobb")


def test_listings():
    for name, want in LISTINGS.items():
        page = fixture(name)
        py = python_listing(page)
        js = from_js("listing", name)

        check("%s: result count" % name, source.result_count(page), want["rows"])
        check("%s: result count agrees (js)" % name, js["rows"], want["rows"])
        check("%s: establishments" % name,
              [(e["id"], e["name"], len(e["inspections"])) for e in py],
              want["establishments"])
        if "inspections" in want:
            check("%s: inspections" % name,
                  [(i["date"], i["score"], i["inspId"]) for i in py[0]["inspections"]],
                  want["inspections"])

        # The fixtures carry a decoy establishment inside every <script>: a
        # parser that does not throw script content away reports it as real,
        # with id 999999999 and a score of 1 in the year 2099.
        check_that("%s: the script decoy leaked into parse_listing" % name,
                   not any(e["id"] == 999999999 for e in py))
        check_that("%s: the script decoy leaked into parseListing (js)" % name,
                   not any(e["id"] == 999999999 for e in js["establishments"]))

        check("%s: python and javascript agree" % name, js["establishments"], py)


# ----------------------------------------------------------------- reports ---

REPORTS = {
    "report-violations.html": {
        "name": "JERUSALEM BAKERY AND GRILL", "date": "12/20/2022", "grade": "B",
        "violations": 2, "risk_factors": 0,
        "codes": ["4-1A", "11A"],
    },
    # The one that matters: the page marks a foodborne-illness risk factor by
    # colouring the row red and in no other way.
    "report-risk-factors.html": {
        "name": "CARIBBEAN SPICE", "date": "06/11/2026", "grade": "C",
        "violations": 10, "risk_factors": 4,
    },
    # A clean inspection. An empty list, not a missing table.
    "report-clean.html": {
        "name": "WHITE WATER - WAVE POOL SLURPEE", "date": "06/11/2026", "grade": "A",
        "violations": 0, "risk_factors": 0,
    },
}


def test_reports():
    for name, want in REPORTS.items():
        page = fixture(name)
        py = source.parse_report(page)
        js = from_js("report", name)

        check("%s: name" % name, py["name"], want["name"])
        check("%s: date" % name, py["date"], want["date"])
        check("%s: grade" % name, py["grade"], want["grade"])
        check("%s: violations" % name, len(py["violations"]), want["violations"])
        check("%s: risk factors" % name,
              sum(1 for v in py["violations"] if v["risk_factor"]), want["risk_factors"])
        if "codes" in want:
            check("%s: codes" % name, [v["code"] for v in py["violations"]], want["codes"])
        check_that("%s: no link to the official form" % name,
                   bool(py["form_url"]) and py["form_url"].startswith("https://"))

        check_that("%s: the script decoy leaked into parse_report" % name,
                   not any("DECOY" in v["description"] for v in py["violations"]))
        check_that("%s: the script decoy leaked into parseReport (js)" % name,
                   not any("DECOY" in v["description"] for v in js["violations"]))

        check("%s: python and javascript agree" % name, js, py)


# ------------------------------------------------------------------ shapes ---


def test_shapes():
    """Nothing published should be able to produce a malformed inspection."""
    for name in LISTINGS:
        for est in source.parse_listing(fixture(name), "Cobb"):
            for insp in est["inspections"]:
                check_that("%s: %r is not an ISO date" % (name, insp["date"]),
                           bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", insp["date"])))
                check_that("%s: score %r out of range" % (name, insp["score"]),
                           0 <= insp["score"] <= 100)
                check_that("%s: inspection id %r" % (name, insp["insp_id"]),
                           insp["insp_id"] > 0)


def main():
    missing = [n for n in list(LISTINGS) + list(REPORTS)
               if not os.path.exists(os.path.join(FIXTURES, n))]
    if missing:
        print("! missing fixtures: %s" % ", ".join(missing))
        print("  run: python3 scripts/make_fixtures.py")
        return 1

    test_listings()
    test_reports()
    test_shapes()

    if failures:
        print("FAILED %d of %d checks:\n" % (len(failures), checks[0]))
        for f in failures:
            print("  - %s" % f)
        return 1
    print("%d checks passed across %d fixtures."
          % (checks[0], len(LISTINGS) + len(REPORTS)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
