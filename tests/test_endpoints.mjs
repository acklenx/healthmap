/* Unit tests for the Pages Functions, with the edge stubbed out.
 *
 *     node tests/test_endpoints.mjs
 *
 * These call the real onRequestGet() handlers. The only things faked are the
 * two bits of Cloudflare they stand on -- `caches.default` and the outbound
 * `fetch` -- so what is under test is the handler's own logic: what it
 * validates, how many times it asks the health department anything, what it
 * says when it cannot tell, and what it puts in Cache-Control.
 *
 * Every bug these were written for was live in production:
 *
 *   - /api/report checked its county against the three the crawl started
 *     with, so inspections in the other 156 answered "bad request".
 *   - a search page that reports rows but parses into nothing answered a
 *     confident "nothing new" rather than admitting it could not read it.
 *   - an inspection found live updated the score only for whoever opened that
 *     restaurant; everybody else waited for the nightly crawl.
 *
 * Modules are loaded as source rather than imported, for the reason given in
 * tests/parsers.mjs: they are ES modules named .js in a tree with no
 * package.json, and adding one would tell Cloudflare Pages this project has a
 * build step.
 */

import { readFileSync } from "node:fs";

const HERE = new URL(".", import.meta.url);
const read = (p) => readFileSync(new URL(p, HERE), "utf8");
const fixture = (name) => read(`fixtures/${name}`);

let failures = 0;
let checks = 0;
let group = "";

const section = (name) => { group = name; console.log(`\n${name}`); };

function ok(label, cond, extra = "") {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
}

const eq = (label, got, want) =>
  ok(label, Object.is(got, want), Object.is(got, want) ? "" : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ---- the edge, as much of it as these handlers touch -------------------- */

/** A caches.default that actually stores, so cache hits can be tested. */
function stubCaches() {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        store.set(request.url, response.clone());
      },
    },
  };
  return store;
}

/** Replaces outbound fetch. `reply` gets the URL and returns HTML, or a
 *  {status, body} for the failure paths. Records every call. */
function stubFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const out = await reply(String(url), calls.length);
    const { status = 200, body = out } = typeof out === "object" && out !== null ? out : {};
    return new Response(body, { status, headers: { "Content-Type": "text/html" } });
  };
  return calls;
}

/** A module as a data: URL, with its own relative imports inlined the same
 *  way -- a data: URL has no directory for "./_found.js" to be relative to. */
function moduleUrl(url) {
  const src = readFileSync(url, "utf8").replace(
    /from\s+"(\.\/[^"]+)"/g, (_, rel) => `from "${moduleUrl(new URL(rel, url))}"`);
  return "data:text/javascript;base64," + Buffer.from(src).toString("base64");
}

async function load(path) {
  return import(moduleUrl(new URL(path, HERE)));
}

/** D1, as much of it as these handlers use, over node's own SQLite and the
 *  real schema -- so the SQL is tested, not just that it was sent. */
async function stubD1() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(read("../web/schema.sql"));
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
  });
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    batch: async (list) => { for (const st of list) await st.run(); return []; },
  };
}

const call = async (mod, url, env = {}) => {
  const waits = [];
  const res = await mod.onRequestGet({
    request: new Request(url),
    env,
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);          // so cache writes land before the next call
  return res;
};

const place = await load("../web/functions/api/place.js");
const report = await load("../web/functions/api/report.js");
const found = await load("../web/functions/api/found.js");
const foundLib = await load("../web/functions/api/_found.js");

const ORIGIN = "https://example.test";
const placeUrl = (q) => `${ORIGIN}/api/place?${new URLSearchParams(q)}`;
const reportUrl = (q) => `${ORIGIN}/api/report?${new URLSearchParams(q)}`;

/** Today and a date safely inside the endpoint's accepted window. */
const today = new Date();
const daysAgo = (n) =>
  new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);

/* ---- every Georgia county, as crawl.py lists them ----------------------- */

function georgiaCounties() {
  const src = read("../crawler/crawl.py");
  const block = src.match(/^GEORGIA = \[([\s\S]*?)^\]/m);
  if (!block) throw new Error("could not find GEORGIA in crawler/crawl.py");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/* ------------------------------------------------------------------------ */

section("county validation — the dataset is statewide, so the endpoints must be");

{
  const counties = georgiaCounties();
  eq("crawl.py still lists 159 counties", counties.length, 159);

  stubCaches();
  stubFetch(() => fixture("search-empty.html"));
  const rejected = [];
  for (const county of counties) {
    const res = await call(place, placeUrl({
      id: "3161473", county, name: "Jerusalem Bakery", since: daysAgo(30),
    }));
    if (res.status === 400) rejected.push(county);
  }
  ok("/api/place accepts every Georgia county", rejected.length === 0,
     rejected.length ? `rejected ${rejected.length}: ${rejected.slice(0, 5).join(", ")}…` : "159/159");

  stubCaches();
  stubFetch(() => fixture("report-clean.html"));
  const rejectedReports = [];
  for (const county of counties) {
    const res = await call(report, reportUrl({ id: "3163712", insp: "57535027", county }));
    if (res.status === 400) rejectedReports.push(county);
  }
  ok("/api/report accepts every Georgia county", rejectedReports.length === 0,
     rejectedReports.length
       ? `rejected ${rejectedReports.length}: ${rejectedReports.slice(0, 5).join(", ")}…`
       : "159/159");
  // The regression, named: these are the ones the old three-county set broke.
  ok("…including the 156 outside the original three",
     !rejectedReports.includes("Chatham") && !rejectedReports.includes("Ben Hill") &&
     !rejectedReports.includes("DeKalb"));
}

section("county validation — and nothing else");

{
  stubCaches();
  const calls = stubFetch(() => fixture("search-empty.html"));
  const junk = ["", "../etc/passwd", "Cobb/../Fulton", "Cobb&county=Fulton",
                "A".repeat(40), "Cobb\nFulton", "<script>", "123"];
  const accepted = [];
  for (const county of junk) {
    const res = await call(place, placeUrl({
      id: "1", county, name: "X", since: daysAgo(30),
    }));
    if (res.status !== 400) accepted.push(JSON.stringify(county));
  }
  ok("junk counties are refused", accepted.length === 0, accepted.join(", "));
  ok("and nothing reached the health department", calls.length === 0,
     `${calls.length} upstream requests`);
}

section("/api/place — bad input never reaches upstream");

{
  const bad = [
    ["no id", { county: "Cobb", name: "X", since: daysAgo(30) }],
    ["id not a number", { id: "abc", county: "Cobb", name: "X", since: daysAgo(30) }],
    ["no name", { id: "1", county: "Cobb", name: "", since: daysAgo(30) }],
    ["name too long", { id: "1", county: "Cobb", name: "x".repeat(81), since: daysAgo(30) }],
    ["date not a date", { id: "1", county: "Cobb", name: "X", since: "yesterday" }],
    ["date malformed", { id: "1", county: "Cobb", name: "X", since: "2026-13-45" }],
  ];
  for (const [label, params] of bad) {
    stubCaches();
    const calls = stubFetch(() => fixture("search-empty.html"));
    const res = await call(place, placeUrl(params));
    ok(`400 for ${label}`, res.status === 400 && calls.length === 0,
       `status ${res.status}, ${calls.length} upstream calls`);
  }
}

section("/api/place — the ordinary answer costs one request");

{
  stubCaches();
  const calls = stubFetch(() => fixture("search-empty.html"));
  const res = await call(place, placeUrl({
    id: "3161473", county: "Cobb", name: "Jerusalem Bakery", since: daysAgo(30),
  }));
  const body = await res.json();
  eq("status", res.status, 200);
  eq("rows", body.rows, 0);
  eq("found", body.found, false);
  eq("partial", body.partial, false);
  eq("inspections", body.inspections.length, 0);
  eq("exactly one upstream request", calls.length, 1);
  ok("it searched by establishment name", calls[0].includes("r=name"), calls[0].slice(-120));
  ok("…for food inspections only", calls[0].includes("inspectionType=Food"));
  ok("…inside a date window", calls[0].includes("useDate=YES"));
  eq("cached for an hour, not a year", res.headers.get("cache-control"),
     "public, max-age=3600");
}

section("/api/place — finds the inspection when there is one");

{
  stubCaches();
  stubFetch(() => fixture("search-single.html"));
  const res = await call(place, placeUrl({
    id: "3161473", county: "Cobb", name: "Jerusalem Bakery", since: daysAgo(900),
  }));
  const body = await res.json();
  eq("found", body.found, true);
  eq("it is the establishment asked about", body.id, 3161473);
  eq("newest first", body.inspections[0].date, "2026-05-19");
  eq("with its score", body.inspections[0].score, 100);
  eq("and its inspection id", body.inspections[0].inspId, 57530780);
  eq("the whole history on that page", body.inspections.length, 5);
  eq("not partial", body.partial, false);
  eq("the name it is listed under", body.listedAs, "JERUSALEM BAKERY AND GRILL");
}

section("/api/place — a page it cannot read is 'unsure', not 'nothing new'");

{
  // The failure this exists for: the site changes its markup, every search
  // parses into nothing, and the endpoint cheerfully reports "no new
  // inspections" to every restaurant, forever.
  stubCaches();
  const calls = stubFetch(() =>
    "<html><body>24 Establishments matched<p>but not in any shape we know</p></body></html>");
  const res = await call(place, placeUrl({
    id: "3161473", county: "Cobb", name: "Jerusalem Bakery", since: daysAgo(30),
  }));
  const body = await res.json();
  eq("rows were reported", body.rows, 24);
  eq("found", body.found, false);
  eq("partial", body.partial, true);
  eq("reason", body.reason, "unreadable");
  ok("it did not keep asking", calls.length <= 3, `${calls.length} requests`);
}

section("/api/place — a name too crowded to single out");

{
  // Rows on more pages than the endpoint is willing to read, and the
  // establishment on none of the ones it read.
  stubCaches();
  const calls = stubFetch(() => fixture("search-chain-page2.html").replace(
    "24 Establishments matched", "400 Establishments matched"));
  const res = await call(place, placeUrl({
    id: "999999", county: "Fulton", name: "Subway", since: daysAgo(90),
  }));
  const body = await res.json();
  eq("found", body.found, false);
  eq("partial", body.partial, true);
  eq("reason", body.reason, "crowded");
  eq("pages it would have needed", body.pages, 20);
  eq("pages it actually read", calls.length, 3);
}

section("/api/place — pagination, and an establishment that straddles a page");

{
  // Each inspection needs its own inspID: the handler keys them by it, so
  // reusing one across the page boundary would look like the same visit --
  // which is exactly what it does for a genuinely duplicated row.
  const block = (id, insp, name, date) =>
    `<strong>${name} (Food Service Inspections)</strong><br>1 TEST ST<br>` +
    `View inspections: <a href="history.cfm?id=${id}&amp;inspID=${insp}">` +
    `${date} Score: 90, Grade: A</a>`;

  // The target is the LAST block on page one, so its rows may continue onto
  // page two -- which is the whole reason the handler keeps going.
  const pageOne = `<html>40 Establishments matched` +
    block(111, 11101, "OTHER PLACE", "January 5, 2026") +
    block(222, 22201, "TARGET", "February 6, 2026") + "</html>";
  const pageTwo = `<html>40 Establishments matched` +
    block(222, 22202, "TARGET", "March 7, 2026") +
    block(333, 33301, "LATER PLACE", "April 8, 2026") + "</html>";

  stubCaches();
  const calls = stubFetch((url) => (url.includes("start=21") ? pageTwo : pageOne));
  const res = await call(place, placeUrl({
    id: "222", county: "Cobb", name: "Target", since: daysAgo(400),
  }));
  const body = await res.json();
  eq("it read a second page", calls.length, 2);
  ok("the second request carried the offset", calls[1].includes("start=21"));
  eq("found", body.found, true);
  eq("both halves of the straddled establishment", body.inspections.length, 2);
  eq("newest first", body.inspections[0].date, "2026-03-07");
  ok("and nobody else's rows", body.inspections.every((i) => String(i.inspId).startsWith("222")));
  // The flip side: a row genuinely repeated across the boundary is one visit.
  stubCaches();
  stubFetch((url) => (url.includes("start=21") ? pageOne : pageOne));
  const dup = await (await call(place, placeUrl({
    id: "222", county: "Cobb", name: "Target", since: daysAgo(400),
  }))).json();
  eq("a repeated row is not counted twice", dup.inspections.length, 1);
}

section("/api/place — a settled answer is not re-asked");

{
  stubCaches();
  const calls = stubFetch(() => fixture("search-empty.html"));
  const params = {
    id: "3161473", county: "Cobb", name: "Jerusalem Bakery", since: daysAgo(30),
  };
  await call(place, placeUrl(params));
  await call(place, placeUrl(params));
  eq("the second caller got the cached answer", calls.length, 1);

  // fresh=1 is a human asking again, and is refused while the answer is new.
  const res = await call(place, placeUrl({ ...params, fresh: "1" }));
  const body = await res.json();
  eq("still one upstream request", calls.length, 1);
  eq("and it says why", body.throttled, true);
}

section("/api/report — the parser's own contract");

{
  for (const [label, name, expect] of [
    ["a clean inspection", "report-clean.html",
     { violations: 0, risk: 0, date: "06/11/2026", grade: "A", form: true }],
    ["one with violations", "report-violations.html",
     { violations: 2, risk: 0, date: "12/20/2022", grade: "B", form: true }],
    ["one with risk factors", "report-risk-factors.html",
     { violations: 10, risk: 4, date: "06/11/2026", grade: "C", form: true }],
    // The distinction the sheet used to get wrong: a visit whose findings the
    // state has not published is not a visit with no findings.
    ["one not published yet", "report-unpublished.html",
     { violations: 0, risk: 0, date: "", grade: "", form: false }],
  ]) {
    stubCaches();
    stubFetch(() => fixture(name));
    const res = await call(report, reportUrl({ id: "1", insp: "2", county: "Cobb" }));
    const body = await res.json();
    const got = {
      violations: body.violations.length,
      risk: body.violations.filter((v) => v.risk_factor).length,
      date: body.date,
      grade: body.grade,
      form: Boolean(body.form_url),
    };
    ok(`${label}: ${JSON.stringify(expect)}`,
       JSON.stringify(got) === JSON.stringify(expect), JSON.stringify(got));
  }

  // The one that matters for the sheet: these two are only distinguishable by
  // the date, so nothing may treat "no violations" as "clean" on its own.
  stubCaches();
  stubFetch(() => fixture("report-unpublished.html"));
  const unpublished = await (await call(report, reportUrl({ id: "1", insp: "2", county: "Cobb" }))).json();
  stubCaches();
  stubFetch(() => fixture("report-clean.html"));
  const clean = await (await call(report, reportUrl({ id: "1", insp: "2", county: "Cobb" }))).json();
  ok("both have no violations",
     unpublished.violations.length === 0 && clean.violations.length === 0);
  ok("but only the published one has a date", !unpublished.date && Boolean(clean.date),
     `unpublished ${JSON.stringify(unpublished.date)}, clean ${JSON.stringify(clean.date)}`);
}

section("/api/report — a completed inspection is a historical fact");

{
  stubCaches();
  const calls = stubFetch(() => fixture("report-clean.html"));
  const url = reportUrl({ id: "3163712", insp: "57535027", county: "Cobb" });
  const res = await call(report, url);
  eq("cached for a year, immutably", res.headers.get("cache-control"),
     "public, max-age=31536000, immutable");
  await call(report, url);
  eq("so it is fetched once", calls.length, 1);
}

section("upstream failure is reported, not papered over");

{
  stubCaches();
  stubFetch(() => ({ status: 503, body: "down" }));
  const res = await call(place, placeUrl({
    id: "1", county: "Cobb", name: "X", since: daysAgo(30),
  }));
  eq("/api/place says 502", res.status, 502);
  eq("and is not cached", res.headers.get("cache-control"), "no-store");

  stubCaches();
  stubFetch(() => ({ status: 503, body: "down" }));
  const r = await call(report, reportUrl({ id: "1", insp: "2", county: "Cobb" }));
  eq("/api/report says 502", r.status, 502);
  eq("and is not cached", r.headers.get("cache-control"), "no-store");
}

section("/api/found — one visit's finding is everyone's");

{
  // The fixture's newest inspection, moved to last week so it is news.
  const recent = new Date(today.getTime() - 7 * 86400000);
  const month = recent.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const shown = `${month} ${recent.getUTCDate()}, ${recent.getUTCFullYear()}`;
  const page = fixture("search-single.html").replace("May 19, 2026", shown);

  const DB = await stubD1();
  stubCaches();
  stubFetch(() => page);
  await call(place, placeUrl({
    id: "3161473", county: "Cobb", name: "Jerusalem Bakery", since: daysAgo(900),
  }), { DB });
  const stored = DB.raw.prepare("SELECT * FROM found").all();
  eq("a check that finds a new inspection stores it", stored.length, 1);
  eq("…only the recent one, not the history around it", stored[0]?.date, daysAgo(7));
  eq("…against the place that was asked about", stored[0]?.place_id, 3161473);

  stubCaches();
  const res = await call(found, `${ORIGIN}/api/found`, { DB });
  const body = await res.json();
  eq("and /api/found hands it to everyone", JSON.stringify(body.rows),
     JSON.stringify([[3161473, daysAgo(7), 100, 57530780]]));
  eq("cached for five minutes", res.headers.get("cache-control"), "public, max-age=300");

  // Asked again: the same inspection is one row, not two.
  stubCaches();
  await call(place, placeUrl({
    id: "3161473", county: "Cobb", name: "Jerusalem Bakery", since: daysAgo(900),
  }), { DB });
  eq("finding it twice stores it once",
     DB.raw.prepare("SELECT COUNT(*) AS n FROM found").get().n, 1);

  // Nothing found: nothing written.
  stubCaches();
  stubFetch(() => fixture("search-empty.html"));
  await call(place, placeUrl({ id: "9", county: "Cobb", name: "Nobody", since: daysAgo(30) }), { DB });
  eq("an empty answer writes nothing",
     DB.raw.prepare("SELECT COUNT(*) AS n FROM found").get().n, 1);

  // Old enough that the crawl has long since caught up: pruned on the next write.
  const later = Date.now() + (foundLib.FOUND_KEEP_DAYS + 1) * 86400000;
  await foundLib.recordFound(DB, 1, [{ date: new Date(later).toISOString().slice(0, 10),
                                       score: 90, inspId: 1 }], later);
  eq("rows past the keep window are pruned",
     DB.raw.prepare("SELECT COUNT(*) AS n FROM found WHERE place_id = 3161473").get().n, 0);

  stubCaches();
  const none = await call(found, `${ORIGIN}/api/found`, {});
  eq("without a database it answers with nothing, not an error",
     JSON.stringify(await none.json()), JSON.stringify({ rows: [] }));
  stubCaches();
  stubFetch(() => page);
  const plain = await call(place, placeUrl({
    id: "3161473", county: "Cobb", name: "Jerusalem Bakery", since: daysAgo(900),
  }), {});
  eq("and /api/place still answers", plain.status, 200);
}

console.log(failures
  ? `\nFAILED ${failures} of ${checks} checks\n`
  : `\n${checks} checks passed.\n`);
process.exit(failures ? 1 : 0);
