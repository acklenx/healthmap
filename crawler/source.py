"""Fetch and parse Georgia DPH health inspection listings.

Source: https://ga.healthinspections.us/georgia/ (Tyler Technologies Environmental
Health). There is no API, so we drive the public search form. Two useful modes:

  * date-range search -- every inspection in a window, paginated 20 rows/page.
    A wide window (2010..today) is a full history crawl; a narrow one (last N
    days) is a cheap nightly incremental.
  * detail page       -- history.cfm?id=&inspID= gives the itemized violations.

Pagination counts *inspection rows*, not establishments: one establishment with
five inspections occupies five of the twenty slots on a page.
"""

import gzip
import html
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime

BASE = "https://ga.healthinspections.us/georgia/"
UA = "restaurant-scores/1.0 (personal health-score lookup)"
PAGE_SIZE = 20

# Georgia maps scores to letter grades by fixed cutoffs (DPH Chapter 511-6-1).
GRADE_CUTOFFS = ((90, "A"), (80, "B"), (70, "C"))


def grade_for(score):
    for floor, letter in GRADE_CUTOFFS:
        if score >= floor:
            return letter
    return "U"


class FetchError(Exception):
    pass


def fetch(url, retries=4, timeout=45):
    """GET with exponential backoff. Returns decoded HTML."""
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept-Encoding": "gzip", "Accept": "text/html"}
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw.decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            last = exc
            time.sleep(1.5 * (2 ** attempt))
    raise FetchError("%s: %s" % (url, last))


def _stamp(d):
    """The form's hidden date fields want 'MM/DD/YYYY 00:00 AM'."""
    return d.strftime("%m/%d/%Y") + " 00:00 AM"


def search_url(county, start=1, since=None, until=None, food_only=True):
    params = {
        "1": "1",
        "f": "s",
        "r": "ANY",
        "s": "",
        "inspectionType": "Food" if food_only else "",
        "useDate": "YES",
        "sd": _stamp(since or date(2010, 1, 1)),
        "ed": _stamp(until or date.today()),
        "county": county,
    }
    if start > 1:
        params["start"] = str(start)
    return BASE + "search.cfm?" + urllib.parse.urlencode(params)


def report_url(eid, insp_id, county):
    return BASE + "history.cfm?" + urllib.parse.urlencode(
        {"id": eid, "inspID": insp_id, "county": county}
    )


def _clean(s):
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s).replace("\xa0", " ")).strip()


# ---------------------------------------------------------------- listing ----

_COUNT_RE = re.compile(r"([\d,]+)\s+Establishments matched", re.I)
# Each establishment is a <strong>NAME (Type)</strong> header, an address line,
# then one <a href="history.cfm...">DATE Score: N, Grade: X</a> per inspection.
_BLOCK_RE = re.compile(
    r"<strong>(?P<name>.*?)\s*\((?P<kind>[^()]*?)\)</strong>\s*<br>\s*"
    r"(?P<addr>.*?)<br>\s*View inspections:",
    re.S | re.I,
)
_INSP_RE = re.compile(
    r'<a href="history\.cfm\?id=(?P<eid>\d+)&(?:amp;)?inspID=(?P<iid>\d+)[^"]*"\s*>'
    r"(?P<date>[A-Z][a-z]+ \d{1,2}, \d{4}) Score:\s*(?P<score>\d+),\s*Grade:\s*(?P<grade>[A-Z])",
    re.I,
)
# "3460 SANDY PLAINS RD STE 110 \nMARIETTA, GA 30062-4702"
_ADDR_RE = re.compile(
    r"^(?P<street>.*?)\s*\n\s*(?P<city>[^,]+),\s*(?P<state>[A-Z]{2})\s*(?P<zip>\d{5})(?:-\d{4})?\s*$",
    re.S,
)
# A minority of records put the whole address on one line, with no newline
# before the city: "1465 CHATTAHOOCHEE AVE ATLANTA, GA 30318". Split on the
# last whitespace run before the comma and treat the tail as the city.
_ADDR_FLAT_RE = re.compile(
    r"^(?P<street>.*\S)\s+(?P<city>[A-Z][A-Za-z.'\- ]*),\s*(?P<state>[A-Z]{2})"
    r"\s*(?P<zip>\d{5})(?:-\d{4})?\s*$"
)


def result_count(page):
    m = _COUNT_RE.search(page)
    return int(m.group(1).replace(",", "")) if m else 0


def parse_listing(page, county):
    """Yield establishment dicts with the inspections shown on this page.

    An establishment can straddle a page boundary, so callers merge by `id`.
    """
    out = []
    blocks = list(_BLOCK_RE.finditer(page))
    for n, m in enumerate(blocks):
        # This block's inspections run until the next block begins.
        end = blocks[n + 1].start() if n + 1 < len(blocks) else len(page)
        inspections, eid = [], None
        for i in _INSP_RE.finditer(page, m.end(), end):
            eid = int(i.group("eid"))
            try:
                when = datetime.strptime(i.group("date"), "%B %d, %Y").date()
            except ValueError:
                continue
            inspections.append(
                {
                    "date": when.isoformat(),
                    "score": int(i.group("score")),
                    "insp_id": int(i.group("iid")),
                }
            )
        if eid is None or not inspections:
            continue

        raw_addr = html.unescape(re.sub(r"<[^>]+>", "", m.group("addr"))).strip()
        a = _ADDR_RE.match(raw_addr) or _ADDR_FLAT_RE.match(re.sub(r"\s+", " ", raw_addr))
        if a:
            street = _clean(a.group("street"))
            city = _clean(a.group("city"))
            zipcode = a.group("zip")
        else:  # keep the record anyway; geocoding degrades gracefully
            street, city, zipcode = _clean(raw_addr), "", ""

        out.append(
            {
                "id": eid,
                "name": _clean(m.group("name")),
                "kind": _clean(m.group("kind")),
                "street": street,
                "city": city,
                "zip": zipcode,
                "county": county,
                "inspections": inspections,
            }
        )
    return out


# ----------------------------------------------------------------- report ----

_SCRIPT_RE = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)
_ROW_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.S | re.I)
_CELL_RE = re.compile(r"<td\b[^>]*>(.*?)</td>", re.S | re.I)
_RED_RE = re.compile(r"color\s*:\s*red|color\s*=\s*[\"']?red|<font[^>]*red", re.I)
_CODE_RE = re.compile(r"^\d{1,2}(?:-\d{1,2})?[A-Z]{0,2}$")


def parse_report(page):
    """Extract the itemized violations from a history.cfm detail page.

    Violations rendered in red are DPH-designated foodborne-illness risk factors
    (temperature control, handwashing, cross-contamination); the rest are "good
    retail practices". The page encodes that distinction only as colour, so we
    detect the styling.
    """
    # The reusable search form is appended below the report; cut it off so its
    # markup cannot be mistaken for violation rows.
    cut = page.find("Establishment Search")
    body = _SCRIPT_RE.sub(" ", page[:cut] if cut > 0 else page)

    violations = []
    for row in _ROW_RE.findall(body):
        cells = _CELL_RE.findall(row)
        if len(cells) != 3:
            continue
        code, occ = _clean(cells[0]), _clean(cells[2])
        if not _CODE_RE.match(code) or not occ.isdigit():
            continue  # skips the "No. / Description / Occur" header row
        violations.append(
            {
                "code": code,
                "description": _clean(cells[1]),
                "occurrences": int(occ),
                "risk_factor": bool(_RED_RE.search(row)),
            }
        )

    def grab(pattern):
        m = re.search(pattern, body, re.I)
        return m.group(1).strip() if m else ""

    form = re.search(r'href="([^"]*_report_full\.cfm[^"]*)"', body, re.I)
    return {
        "name": _clean(grab(r"<h3>(.*?)</h3>")),
        "date": grab(r"Date:\s*([\d/]{8,10})"),
        "grade": grab(r"Grade:\s*([A-U])\b"),
        "violations": violations,
        "form_url": urllib.parse.urljoin(BASE, html.unescape(form.group(1))) if form else None,
    }
