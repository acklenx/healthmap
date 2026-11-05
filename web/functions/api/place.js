/* GET /api/place?id=<establishment>&county=<name>&name=<establishment>&since=<YYYY-MM-DD>
 *
 * Asks the Georgia DPH site whether one restaurant has been inspected since a
 * date the caller already knows about, and returns whatever is newer.
 *
 * The dataset is published nightly, which means a score can be a day old --
 * and after a failed run, older than that. This is the escape hatch: opening a
 * restaurant checks that one restaurant against the source, so the page you
 * are looking at is right even when the payload behind it is not yet.
 *
 * The site has no per-establishment page, so this drives the same date-range
 * search the crawler does, narrowed to one name. The date window is what makes
 * it cheap: asking "anything since the inspection I already have?" matches
 * nothing at all for almost every restaurant, and that is one upstream request
 * answering with an empty result set.
 *
 * Unlike /api/report, the answer is a *freshness* claim rather than a
 * historical fact, so it is cached for an hour rather than a year -- long
 * enough that a street full of people opening the same restaurant costs the
 * health department one request.
 */

import { recordFound } from "./_found.js";

const UPSTREAM = "https://ga.healthinspections.us/georgia/";

// The listing paginates by inspection row, not by establishment: one place
// with five inspections fills five of the twenty slots on a page.
const PAGE_SIZE = 20;
// A common name ("SUBWAY") in a big county matches rows across several pages.
// Three is enough for any plausible window; past that we say so rather than
// walking a health department's search results indefinitely.
const MAX_PAGES = 3;

const HOUR = 3600;
// How fresh a cached answer has to be for `fresh=1` to be refused. The button
// that sends it is a human asking again, and inspections post daily at best,
// so re-asking upstream inside this window cannot tell them anything new.
const MIN_REFRESH_MS = 2 * 60 * 1000;

// Georgia county names: "Cobb", "Ben Hill", "DeKalb", "Jeff Davis". Validated
// by shape rather than against the list of 159, which would mean shipping that
// list to another place that can disagree with crawl.py about it. The value is
// a filter on the upstream form, not a path, and it is encoded below.
const COUNTY_RE = /^[A-Za-z][A-Za-z'. -]{1,22}$/;
const MAX_NAME = 80;
// How far back a caller may ask us to look. A wide window is a slow search for
// everybody, and anything older than this is the nightly crawl's job.
const MAX_SINCE_DAYS = 1095;

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const county = url.searchParams.get("county") || "";
  const name = (url.searchParams.get("name") || "").trim();
  const since = url.searchParams.get("since") || "";
  const fresh = url.searchParams.get("fresh") === "1";

  // Validate strictly: name and county are interpolated into an upstream query.
  if (!/^\d{1,12}$/.test(id) || !COUNTY_RE.test(county) ||
      !name || name.length > MAX_NAME || /[\x00-\x1f]/.test(name) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return json({ error: "bad request" }, 400, "no-store");
  }

  const today = startOfUTCDay(new Date());
  const floor = new Date(today.getTime() - MAX_SINCE_DAYS * 86400000);
  const asked = new Date(`${since}T00:00:00Z`);
  if (Number.isNaN(asked.getTime())) return json({ error: "bad request" }, 400, "no-store");
  // Clamp rather than reject: a caller whose data predates the window still
  // deserves an answer about the part of it we are willing to look at.
  const start = new Date(Math.min(Math.max(asked.getTime(), floor.getTime()), today.getTime()));

  const cache = caches.default;
  const cacheKey = new Request(
    `${url.origin}/api/place?id=${id}&county=${encodeURIComponent(county)}` +
    `&name=${encodeURIComponent(name)}&since=${isoDay(start)}`
  );
  const hit = await cache.match(cacheKey);
  if (hit) {
    if (!fresh) return hit;
    // A manual re-check, against an answer we only just gave. Hand back the
    // one we have and say why, rather than asking upstream again for it.
    const cached = await hit.clone().json().catch(() => null);
    const age = cached?.checked ? Date.now() - Date.parse(cached.checked) : Infinity;
    if (age < MIN_REFRESH_MS) {
      return json({ ...cached, throttled: true }, 200, `public, max-age=${HOUR}`);
    }
  }

  let result;
  try {
    result = await lookup({ id: Number(id), county, name, start, today });
  } catch (err) {
    return json({ error: String(err.message || err) }, 502, "no-store");
  }

  const response = json(
    {
      id: Number(id),
      county,
      since: isoDay(start),
      checked: new Date().toISOString(),
      ...result,
    },
    200,
    `public, max-age=${HOUR}`,
  );
  waitUntil(cache.put(cacheKey, response.clone()));
  // What was found here is news for everyone, not only for this caller: see
  // /api/found. Only this establishment's own rows, read from the state's page
  // by this function -- nothing the caller sent is stored.
  if (result.found) waitUntil(recordFound(env?.DB, Number(id), result.inspections));
  return response;
}

/** Page through the search until this establishment is accounted for. */
async function lookup({ id, county, name, start, today }) {
  // Through tomorrow, not today: the window's end is a midnight, so "today"
  // would exclude an inspection posted this morning.
  const until = new Date(today.getTime() + 86400000);
  const first = await fetchPage({ county, name, start, until });
  const rows = resultCount(first);
  // Nothing was inspected in the window, by any establishment matching the
  // name. The common answer, and it costs one request.
  if (!rows) return { rows: 0, pages: 0, partial: false, found: false, inspections: [] };

  const pages = Math.max(1, Math.ceil(rows / PAGE_SIZE));
  const limit = Math.min(pages, MAX_PAGES);

  const seen = new Map();          // inspection id -> inspection
  let listedAs = null;
  let hit = false;
  let read = 0;                    // establishments understood, across pages
  let page = first;

  for (let n = 1; n <= limit; n++) {
    if (n > 1) {
      page = await fetchPage({ county, name, start, until, offset: (n - 1) * PAGE_SIZE + 1 });
    }
    const blocks = parseListing(page);
    read += blocks.length;
    const mine = blocks.filter((b) => b.id === id);
    for (const block of mine) {
      hit = true;
      listedAs = block.name || listedAs;
      for (const insp of block.inspections) seen.set(insp.inspId, insp);
    }
    // An establishment straddles a page boundary when its rows run past the
    // twentieth, so finding it as the last block on a page is not the same as
    // having all of it. Anything earlier on the page is complete.
    const straddles = mine.length > 0 && blocks[blocks.length - 1].id === id;
    if (hit && !straddles) break;
  }

  const inspections = [...seen.values()].sort((a, b) => b.date.localeCompare(a.date));

  /* Unsure, rather than "nothing new", in two different ways.
   *
   * Either this establishment was not on any page we were willing to read --
   * a name shared by two hundred Subways, where the caller cannot tell "not
   * inspected" from "not found" -- or the page said it had rows and we
   * understood none of them, which is this parser having been outlived by
   * somebody else's markup. They are told apart because they are worth
   * saying differently, and because a silent "nothing new", forever, is
   * exactly what a broken scraper looks like from the outside. */
  const unreadable = read === 0;
  const crowded = !hit && pages > limit;

  return {
    rows,
    pages,
    partial: unreadable || crowded,
    ...(unreadable || crowded ? { reason: unreadable ? "unreadable" : "crowded" } : {}),
    found: hit,
    ...(listedAs ? { listedAs } : {}),
    inspections,
  };
}

async function fetchPage({ county, name, start, until, offset = 0 }) {
  const params = new URLSearchParams({
    1: "1",
    f: "s",
    r: "name",
    s: name,
    inspectionType: "Food",
    useDate: "YES",
    sd: stamp(start),
    ed: stamp(until),
    county,
  });
  if (offset > 1) params.set("start", String(offset));

  const res = await fetch(`${UPSTREAM}search.cfm?${params}`, {
    headers: { "User-Agent": "restaurant-scores/1.0", Accept: "text/html" },
    // The edge keeps the upstream page for the same hour we keep our answer,
    // so paging through it twice in quick succession costs one fetch.
    cf: { cacheTtl: HOUR, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.text();
}

/** The form's hidden date fields want 'MM/DD/YYYY 00:00 AM'. */
function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} 00:00 AM`;
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const startOfUTCDay = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl },
  });
}

/* ---- parser (mirrors crawler/source.py: parse_listing, result_count) ----- */

const COUNT_RE = /([\d,]+)\s+Establishments matched/i;
// Each establishment is a <strong>NAME (Type)</strong> header, an address
// line, then one <a href="history.cfm...">DATE Score: N, Grade: X</a> per
// inspection. The address is skipped: this endpoint answers "has it been
// inspected since", and the app already knows where the restaurant is.
const BLOCK_SRC =
  "<strong>([\\s\\S]*?)\\s*\\(([^()]*?)\\)</strong>\\s*<br>\\s*[\\s\\S]*?<br>\\s*View inspections:";
const INSP_SRC =
  '<a href="history\\.cfm\\?id=(\\d+)&(?:amp;)?inspID=(\\d+)[^"]*"\\s*>' +
  "([A-Z][a-z]+ \\d{1,2}, \\d{4}) Score:\\s*(\\d+),\\s*Grade:\\s*([A-Z])";

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function resultCount(page) {
  const m = page.match(COUNT_RE);
  return m ? Number(m[1].replace(/,/g, "")) : 0;
}

/** Establishments on one listing page, in the order the page lists them. */
export function parseListing(page) {
  // Only the results are searched for results. The reusable search form is
  // appended below them, and most of the page is a date picker that writes
  // markup with document.write(); neither can hold an establishment, and a
  // phantom one would be shown as a real inspection. Mirrors parse_listing.
  const cut = page.indexOf("Establishment Search");
  const body = (cut > 0 ? page.slice(0, cut) : page)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");

  const blocks = [];
  const header = new RegExp(BLOCK_SRC, "gi");
  for (let m = header.exec(body); m; m = header.exec(body)) {
    blocks.push({ name: clean(m[1]), kind: clean(m[2]), at: m.index, from: header.lastIndex });
  }

  const out = [];
  const insp = new RegExp(INSP_SRC, "gi");
  for (let i = 0; i < blocks.length; i++) {
    // This block's inspections run until the next block begins.
    const end = i + 1 < blocks.length ? blocks[i + 1].at : body.length;
    const inspections = [];
    let id = null;

    insp.lastIndex = blocks[i].from;
    for (let m = insp.exec(body); m && m.index < end; m = insp.exec(body)) {
      const date = isoDate(m[3]);
      if (!date) continue;
      id = Number(m[1]);
      inspections.push({ date, score: Number(m[4]), inspId: Number(m[2]) });
    }
    if (id === null || !inspections.length) continue;
    out.push({ id, name: blocks[i].name, kind: blocks[i].kind, inspections });
  }
  return out;
}

/** "June 11, 2026" -> "2026-06-11". Null for anything else. */
function isoDate(text) {
  const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(text);
  const month = m && MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

function clean(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
