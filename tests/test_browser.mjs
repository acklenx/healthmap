/* The app, in a real browser.
 *
 *     node tests/test_browser.mjs
 *
 * Skips, loudly but successfully, when there is no browser to drive -- which
 * is how it stays in CI without putting a 150 MB download in it. To run it
 * locally:
 *
 *     npm install --prefix ~/.local/pptr puppeteer
 *
 * It starts scripts/dev_server.py itself and stubs both API routes, so a test
 * run never sends a request to the health department.
 *
 * app.js is three thousand lines of DOM, with no seam to unit-test through;
 * these are the behaviours that only exist once it is all assembled. Each one
 * is here because it was broken in production:
 *
 *   - a fresh browser could not get past "Where are you?": the dataset grew
 *     past what the app will load blind, and resolving the ZIP code it asks
 *     for needed the places it had deliberately not loaded.
 *   - a visit whose findings the state had not published yet was rendered as
 *     "No violations recorded on this visit."
 *   - an inspection found live had to survive a reload, and be re-checked at
 *     most once a day.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const HERE = new URL(".", import.meta.url);
const ROOT = new URL("..", HERE);
const PORT = Number(process.env.PORT || 8112);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = { lat: 33.9526, lon: -84.5499, label: "Marietta", pinned: true };

/* ---- find a browser, or bow out ---------------------------------------- */

const PPTR = process.env.PUPPETEER_PATH ||
  `${process.env.HOME}/.local/pptr/node_modules/puppeteer/lib/puppeteer/puppeteer.js`;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = `${process.env.HOME}/.cache/puppeteer/chrome-headless-shell`;
  if (!existsSync(cache)) return null;
  const { readdirSync } = require("node:fs");
  for (const dir of readdirSync(cache)) {
    const exe = `${cache}/${dir}/chrome-headless-shell-linux64/chrome-headless-shell`;
    if (existsSync(exe)) return exe;
  }
  return null;
}

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

if (!existsSync(PPTR)) {
  console.log("\nSKIPPED — no puppeteer. Install it with:");
  console.log("  npm install --prefix ~/.local/pptr puppeteer\n");
  process.exit(0);
}
const chrome = findChrome();
if (!chrome) {
  console.log("\nSKIPPED — puppeteer is installed but no browser was downloaded.\n");
  process.exit(0);
}

const puppeteer = (await import(PPTR)).default;

/* ---- harness ------------------------------------------------------------ */

let failures = 0;
let checks = 0;
const ok = (label, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
};
const section = (name) => console.log(`\n${name}`);
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition in this process (a request count, say) rather than
 *  sleeping and hoping. A fixed sleep here is a test that passes until the
 *  machine is busy. */
async function until(what, cond, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await settle(50);
  }
  console.log(`    [timed out waiting for ${what}]`);
  return false;
}

/** Wait for the open report panel to have actually loaded. */
const detailLoaded = (page) => page.waitForFunction(() => {
  const panel = document.querySelector(".detail:not([hidden])");
  return panel && !/Loading the inspector/.test(panel.textContent);
}, { timeout: 20000 });

/* What the stubbed endpoints answer with, and what they were asked. */
let placeAnswer = null;
let reportAnswer = { violations: [], date: "06/11/2026", grade: "A", form_url: null };
const asked = [];

const server = spawn("python3", ["scripts/dev_server.py", "--port", String(PORT)],
                     { cwd: ROOT.pathname, stdio: "ignore" });
const stop = () => { try { server.kill("SIGKILL"); } catch {} };
process.on("exit", stop);

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${BASE}/counties.json`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await settle(250);
  }
  return false;
}

if (!(await waitForServer())) {
  console.log("\nSKIPPED — the dev server did not start.\n");
  stop();
  process.exit(0);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function freshPage({ seed = {} } = {}) {
  const context = await browser.createBrowserContext?.() ?? browser.defaultBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 414, height: 900 });
  page.on("pageerror", (e) => { console.log("    [PAGE ERROR]", e.message); failures++; });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.endsWith("/sw.js")) return req.abort();
    if (url.includes("tile.openstreetmap.org")) return req.abort();
    if (url.includes("/api/place")) {
      asked.push(url);
      if (!placeAnswer) return req.abort();
      return req.respond({ status: 200, contentType: "application/json",
                           headers: { "Cache-Control": "no-store" },
                           body: JSON.stringify(placeAnswer) });
    }
    if (url.includes("/api/report")) {
      // Never let a test reach the health department.
      return req.respond({ status: 200, contentType: "application/json",
                           body: JSON.stringify(reportAnswer) });
    }
    req.continue();
  });

  await page.evaluateOnNewDocument((entries) => {
    for (const [k, v] of entries) localStorage.setItem(k, v);
  }, Object.entries(seed));
  return page;
}

const waitForList = (page) =>
  page.waitForFunction("document.querySelectorAll('#list .card').length > 0",
                       { timeout: 25000 });

const sheetState = (page) => page.evaluate(() => ({
  note: document.querySelector("#live-note")?.textContent.replace(/\s+/g, " ").trim() || null,
  noteClass: document.querySelector("#live-note")?.className || null,
  rows: [...document.querySelectorAll(".insp-row")].map((r) => ({
    live: r.classList.contains("is-live"),
    text: r.textContent.replace(/\s+/g, " ").trim(),
  })),
  detail: document.querySelector(".detail:not([hidden])")?.textContent
    .replace(/\s+/g, " ").trim() || null,
  stateLink: document.querySelector(".state-link")?.getAttribute("href") || null,
}));

const firstCard = (page) => page.evaluate(() => {
  const card = document.querySelector("#list .card");
  return card && {
    id: Number(card.dataset.id),
    badge: card.querySelector(".badge").textContent.trim(),
    age: card.querySelector(".card-age").textContent.trim(),
  };
});

async function openFirst(page) {
  await page.click("#list .card");
  await page.waitForSelector("#sheet .insp-row", { timeout: 20000 });
  await settle(500);
}

/* ======================================================================== */

try {

section("a fresh browser, with nothing stored");

{
  // The regression: too much data to load blind, so the app asks where you
  // are -- and then has to be able to accept the answer.
  placeAnswer = { rows: 0, pages: 0, partial: false, found: false, inspections: [] };
  const page = await freshPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 40000 });
  await settle(1200);

  const cold = await page.evaluate(() => ({
    status: document.querySelector("#status")?.textContent.replace(/\s+/g, " ").trim(),
    cards: document.querySelectorAll("#list .card").length,
  }));
  ok("it asks where you are", /Where are you\?/.test(cold.status || ""),
     (cold.status || "").slice(0, 60));
  ok("and has loaded nothing yet", cold.cards === 0, `${cold.cards} cards`);
  ok("it offers a ZIP code as the way in", /enter a ZIP code/.test(cold.status || ""));

  await page.evaluate(() => document.querySelector("#status-zip").click());
  await settle(300);
  await page.type("#loc-input", "30060");
  await page.evaluate(() => document.querySelector("#loc-form").requestSubmit());
  await waitForList(page);

  const after = await page.evaluate(() => ({
    cards: document.querySelectorAll("#list .card").length,
    message: document.querySelector("#loc-msg")?.textContent.trim(),
    sheetOpen: !document.querySelector("#locsheet").hidden,
    home: JSON.parse(localStorage.getItem("score.lastPosition") || "null"),
  }));
  ok("typing a ZIP loads the list", after.cards > 0, `${after.cards} cards`);
  ok("it does not say it is still loading",
     !/Still loading/i.test(after.message || ""), after.message || "(no message)");
  ok("the sheet closes", !after.sheetOpen);
  ok("and home lands in Cobb", after.home && Math.abs(after.home.lat - 33.94) < 0.2 &&
     Math.abs(after.home.lon + 84.54) < 0.2, JSON.stringify(after.home));
  await page.close();
}

section("a city, and a ZIP with nothing in it");

{
  const page = await freshPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 40000 });
  await settle(1000);
  await page.evaluate(() => document.querySelector("#status-zip").click());
  await settle(300);
  await page.type("#loc-input", "Savannah");
  await page.evaluate(() => document.querySelector("#loc-form").requestSubmit());
  await waitForList(page);
  const city = await page.evaluate(() => ({
    cards: document.querySelectorAll("#list .card").length,
    home: JSON.parse(localStorage.getItem("score.lastPosition") || "null"),
  }));
  ok("a city name works too", city.cards > 0 && city.home?.lat < 33,
     `${city.cards} cards at ${city.home?.lat?.toFixed(2)}`);

  await page.evaluate(() => { document.querySelector("#locsheet").hidden = false; });
  await page.evaluate(() => { document.querySelector("#loc-input").value = ""; });
  await page.type("#loc-input", "99999");
  await page.evaluate(() => document.querySelector("#loc-form").requestSubmit());
  await settle(900);
  const unknown = await page.evaluate(() =>
    document.querySelector("#loc-msg")?.textContent.replace(/\s+/g, " ").trim());
  ok("an unknown ZIP says so and suggests a real one",
     /No inspections on file for 99999/.test(unknown || "") && /Try \d{5}/.test(unknown || ""),
     unknown);
  ok("…and does not blame three counties any more",
     !/Cobb, Cherokee and Fulton/.test(unknown || ""), unknown);
  await page.close();
}

section("opening a restaurant checks it, once a day");

{
  placeAnswer = { rows: 0, pages: 0, partial: false, found: false, inspections: [] };
  asked.length = 0;
  const page = await freshPage({ seed: { "score.lastPosition": JSON.stringify(HOME) } });
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 40000 });
  await waitForList(page);
  const card = await firstCard(page);
  await openFirst(page);

  ok("it asked once", asked.length === 1, `${asked.length} requests`);
  ok("about the open restaurant", (asked[0] || "").includes(`id=${card.id}`));
  ok("from the day after its latest inspection", /since=\d{4}-\d{2}-\d{2}/.test(asked[0] || ""),
     (asked[0] || "").match(/since=[\d-]+/)?.[0]);

  let st = await sheetState(page);
  ok("the sheet says when it was checked", /Checked against the state's site/.test(st.note || ""),
     st.note);
  ok("there is a link to the state's own record", /search\.cfm\?/.test(st.stateLink || ""));

  await page.keyboard.press("Escape");
  await settle(400);
  await openFirst(page);
  ok("reopening does not ask again", asked.length === 1, `${asked.length} requests`);

  await page.click("#live-note [data-recheck]");
  await until("the manual re-check", () => asked.length === 2);
  ok("but 'Check again' does", asked.length === 2, `${asked.length} requests`);
  ok("and says it is a deliberate re-ask", (asked[1] || "").includes("fresh=1"));
  await page.close();
}

section("a newer inspection than the nightly refresh");

{
  asked.length = 0;
  const page = await freshPage({ seed: { "score.lastPosition": JSON.stringify(HOME) } });
  placeAnswer = { rows: 0, pages: 0, partial: false, found: false, inspections: [] };
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 40000 });
  await waitForList(page);
  const card = await firstCard(page);
  await openFirst(page);
  await detailLoaded(page);
  const before = (await sheetState(page)).rows.length;

  // The state publishes the score before it publishes the findings, so this
  // is what a brand-new inspection actually looks like.
  reportAnswer = { violations: [], date: "", grade: "", form_url: null };
  placeAnswer = {
    rows: 1, pages: 1, partial: false, found: true,
    inspections: [{ date: "2026-11-02", score: 73, inspId: 999000111 }],
  };
  await page.click("#live-note [data-recheck]");
  await page.waitForFunction("document.querySelector('.insp-row.is-live') !== null",
                             { timeout: 15000 });
  await detailLoaded(page);

  const st = await sheetState(page);
  ok("the new inspection is listed and marked", st.rows[0].live, st.rows[0].text);
  ok("one more than before", st.rows.length === before + 1, `${before} -> ${st.rows.length}`);
  ok("the note announces it", /newer inspection/i.test(st.note || ""));
  ok("the note is the loud kind", (st.noteClass || "").includes("is-found"));
  // The bug: this used to read "No violations recorded on this visit."
  ok("an unpublished report is not reported as a clean one",
     /hasn't published this visit's findings/.test(st.detail || ""), st.detail);
  ok("…and it does not claim there were no violations",
     !/No violations recorded/.test(st.detail || ""));

  await page.keyboard.press("Escape");
  await settle(400);
  const after = await firstCard(page);
  ok("the list badge carries the new score", after.badge.includes("73"), after.badge);
  ok("and the row reads as current", /this month/.test(after.age), after.age);

  const stored = await page.evaluate(() => localStorage.getItem("score.live"));
  ok("the finding is written down", /999000111/.test(stored || ""));

  placeAnswer = null;                       // the endpoint disappears entirely
  asked.length = 0;
  await page.reload({ waitUntil: "networkidle2", timeout: 40000 });
  await waitForList(page);
  const reloaded = await firstCard(page);
  ok("it survives a reload", reloaded.badge.includes("73"), reloaded.badge);
  ok("without asking again the same day", asked.length === 0, `${asked.length} requests`);
  await page.close();
}

section("when the check cannot answer");

{
  const page = await freshPage({ seed: { "score.lastPosition": JSON.stringify(HOME) } });
  reportAnswer = { violations: [], date: "06/11/2026", grade: "A", form_url: null };
  placeAnswer = { rows: 400, pages: 20, partial: true, reason: "crowded",
                  found: false, inspections: [] };
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 40000 });
  await waitForList(page);
  await openFirst(page);
  let st = await sheetState(page);
  ok("a crowded name says it could not pick this one out",
     /couldn't pick this restaurant out/i.test(st.note || ""), st.note);

  placeAnswer = { rows: 24, pages: 2, partial: true, reason: "unreadable",
                  found: false, inspections: [] };
  await page.click("#live-note [data-recheck]");
  await page.waitForFunction(
    () => /couldn't read/i.test(document.querySelector("#live-note")?.textContent || ""),
    { timeout: 15000 }).catch(() => {});
  st = await sheetState(page);
  ok("an unreadable page says that instead",
     /couldn't read/i.test(st.note || ""), st.note);

  placeAnswer = null;                        // requests now fail outright
  await page.click("#live-note [data-recheck]");
  await page.waitForFunction(
    () => /couldn't be reached/i.test(document.querySelector("#live-note")?.textContent || ""),
    { timeout: 15000 }).catch(() => {});
  st = await sheetState(page);
  ok("and a failure says the site could not be reached",
     /couldn't be reached/i.test(st.note || ""), st.note);
  ok("none of which claims there is nothing new",
     !/nothing newer/i.test(st.note || ""), st.note);
  await page.close();
}

} finally {
  await browser.close();
  stop();
}

console.log(failures
  ? `\nFAILED ${failures} of ${checks} checks\n`
  : `\n${checks} checks passed.\n`);
process.exit(failures ? 1 : 0);
