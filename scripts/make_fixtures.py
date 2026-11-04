#!/usr/bin/env python3
"""Refetch the parser test fixtures from the live DPH site.

    python3 scripts/make_fixtures.py

The inspection source is somebody else's ColdFusion application and its markup
is the only contract this project has with it. Two parsers read that markup --
crawler/source.py for the nightly crawl, and web/functions/api/*.js at the edge
-- so the fixtures exist to hold both of them to the same real pages, and this
script exists so that "the site changed" is a two-minute refresh rather than an
afternoon of saving pages by hand.

Pages are stored with their <script> and <style> bodies replaced by a decoy
that both parsers must throw away: a page is 165 KB, 98 KB of which is inline
JavaScript nobody reads, and a fixture nobody will open is a fixture nobody
will check. What is kept is everything the parsers actually look at, including
the search form appended below every result -- which is exactly the part they
have to be careful to ignore.
"""

import os
import re
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "crawler"))

import source  # noqa: E402

OUT = os.path.join(ROOT, "tests", "fixtures")

# Anything inside a <script> or <style> that both parsers must drop. Shaped
# like the markup each one is hunting for: a three-cell table row that
# parse_report would read as violation 12, and an establishment header that
# parse_listing would read as a restaurant inspected in 2099. The site's own
# date picker writes markup with document.write(), so this is not a contrived
# shape -- it is the shape of the thing that is actually in there.
DECOY = (
    "/* fixture decoy -- see scripts/make_fixtures.py */\n"
    "document.write('<tr><td>12</td><td>DECOY: script content was parsed"
    "</td><td>1</td></tr>');\n"
    "document.write('<strong>DECOY ESTABLISHMENT (Food Service)</strong><br>"
    "1 DECOY ST<br>View inspections: "
    "<a href=\"history.cfm?id=999999999&inspID=999999999&county=Cobb\">"
    "January 1, 2099 Score: 1, Grade: U</a>');\n"
)

# Fixed windows rather than "the last 30 days", so that refetching this a year
# from now produces the same shape of page: the same establishments, inspected
# on the same days, listed by a site that only appends to the past.
FIXTURES = [
    # One establishment with its whole history. The ordinary case.
    ("search-single.html",
     dict(kind="search", county="Cobb", s="JERUSALEM BAKERY", use_date=False)),
    # A chain name in a big county, second page. Several establishments per
    # page, one inspection each, and the pagination offset the crawler uses.
    ("search-chain-page2.html",
     dict(kind="search", county="Fulton", s="SUBWAY", use_date=True,
          sd=date(2026, 8, 1), ed=date(2026, 11, 5), start=21)),
    # A window with nothing in it: what "no new inspections" looks like, and
    # the answer /api/place gives for almost every restaurant that asks.
    ("search-empty.html",
     dict(kind="search", county="Cobb", s="JERUSALEM BAKERY", use_date=True,
          sd=date(2026, 10, 1), ed=date(2026, 11, 5))),
    # A report with violations, none of them risk factors.
    ("report-violations.html",
     dict(kind="report", county="Cobb", eid=3161473, insp=57329607)),
    # A report with risk factors in it. The page marks those -- the
    # temperature, handwashing and cross-contamination items the state ties to
    # foodborne illness -- by colouring the row red and in no other way, so
    # this is the fixture that holds both parsers to reading the styling.
    ("report-risk-factors.html",
     dict(kind="report", county="Cobb", eid=9487487, insp=57535206)),
    # A report with none. The parser has to return an empty list rather than
    # failing to find the table.
    ("report-clean.html",
     dict(kind="report", county="Cobb", eid=3163712, insp=57535027)),
    # A report the state has not published. The score reaches its inspection
    # list before the findings do, so this is the usual state of a brand-new
    # inspection -- and it comes back as the establishment header and nothing
    # else: no date, no grade, no form link, no rows. Indistinguishable from a
    # clean inspection if you only count violations, which is exactly the
    # mistake the sheet used to make.
    ("report-unpublished.html",
     dict(kind="report", county="Cobb", eid=3163712, insp=999000111)),
]


def url_for(spec):
    """The same URLs the crawler and /api/place ask for, from one builder."""
    if spec["kind"] == "search":
        return source.search_url(
            spec["county"], start=spec.get("start", 0), name=spec["s"],
            use_date=spec["use_date"], since=spec.get("sd"), until=spec.get("ed"),
        )
    return source.report_url(spec["eid"], spec["insp"], spec["county"])


def shrink(page, url):
    """Strip the inline code, leave every byte the parsers read."""
    page = re.sub(
        r"(<(script|style)\b[^>]*>)(.*?)(</\2>)",
        lambda m: m.group(1) + DECOY + m.group(4),
        page, flags=re.S | re.I,
    )
    header = (
        "<!-- Test fixture, not a web page.\n"
        "     Fetched %s from\n"
        "     %s\n"
        "     Script and style bodies were replaced with a decoy that both\n"
        "     parsers must discard; everything else is byte-for-byte as served.\n"
        "     Refresh with: python3 scripts/make_fixtures.py -->\n"
    ) % (date.today().isoformat(), url)
    return header + page


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, spec in FIXTURES:
        url = url_for(spec)
        print("fetching %-26s %s" % (name, url))
        page = source.fetch(url)
        if "<html" not in page.lower():
            print("  ! that is not a page; leaving %s alone" % name)
            return 1
        body = shrink(page, url)
        with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
            fh.write(body)
        print("  wrote %d KB" % (len(body) // 1024))
    print("\n%d fixtures in tests/fixtures. Now run: python3 tests/test_parsers.py"
          % len(FIXTURES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
