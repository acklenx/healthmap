/* Unit tests for the service worker's routing.
 *
 *     node tests/test_sw.mjs
 *
 * sw.js is a classic worker script, not a module, so it is run in a sandbox
 * with `self`, `caches` and `fetch` supplied. Its fetch listener is then
 * called with synthetic events, and what the test watches is which cache each
 * request lands in -- or whether it is left alone.
 *
 * The bug this was written for: the handler at the bottom is the last resort
 * for same-origin GETs and it matches with `ignoreSearch`, so any API route no
 * branch above claimed was cached under its path with the query string thrown
 * away. /api/geocode is such a route. The first address anyone looked up
 * became the cached answer for every address looked up afterwards, and the
 * home pin silently moved to wherever that first lookup landed.
 *
 * Which is why most of these assert where a request does NOT go.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

const HERE = new URL(".", import.meta.url);
const ORIGIN = "https://score.test";

let failures = 0;
let checks = 0;

function ok(label, cond, extra = "") {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
}

/* ---- a service-worker environment, in as much detail as sw.js uses ----- */

function loadWorker() {
  const listeners = new Map();
  // cache name -> Map(url -> {url, body}). Enough to tell a hit from a miss
  // and to see which cache a response was filed under.
  const caches = new Map();
  const opened = (name) => {
    if (!caches.has(name)) caches.set(name, new Map());
    return caches.get(name);
  };
  const fetched = [];

  const cacheApi = {
    async open(name) {
      const store = opened(name);
      return {
        async match(request, opts) {
          const url = new URL(request.url);
          if (opts?.ignoreSearch) {
            for (const [key, value] of store) {
              if (new URL(key).pathname === url.pathname) return value;
            }
            return undefined;
          }
          return store.get(request.url);
        },
        async put(request, response) {
          store.set(typeof request === "string" ? request : request.url, response);
        },
        async keys() {
          return [...store.keys()].map((url) => ({ url }));
        },
        async delete(key) {
          return store.delete(typeof key === "string" ? key : key.url);
        },
      };
    },
    async keys() { return [...caches.keys()]; },
    async delete(name) { return caches.delete(name); },
    async match() { return undefined; },
  };

  const sandbox = {
    self: {
      addEventListener: (type, fn) => listeners.set(type, fn),
      location: new URL(ORIGIN + "/sw.js"),
      registration: { showNotification: async () => {} },
      clients: { matchAll: async () => [], claim: async () => {}, openWindow: async () => {} },
      skipWaiting: async () => {},
    },
    caches: cacheApi,
    async fetch(request) {
      const url = typeof request === "string" ? request : request.url;
      fetched.push(url);
      return { ok: true, url, clone: () => ({ ok: true, url }) };
    },
    Request: globalThis.Request,
    Response: globalThis.Response,
    URL: globalThis.URL,
    console,
    setTimeout,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../web/public/sw.js", HERE), "utf8"), sandbox,
                  { filename: "sw.js" });

  return { listeners, caches, fetched };
}

/** Put one GET through the worker. Returns which cache it was filed in, or
 *  null when the worker declined to handle it at all. */
async function route(url, { method = "GET" } = {}) {
  const worker = loadWorker();
  const onFetch = worker.listeners.get("fetch");
  if (!onFetch) throw new Error("sw.js registered no fetch listener");

  let handled = false;
  const event = {
    request: { url, method, mode: "no-cors" },
    respondWith(promise) { handled = true; return Promise.resolve(promise).catch(() => {}); },
    waitUntil() {},
  };
  onFetch(event);
  await new Promise((r) => setTimeout(r, 0));

  const filed = [...worker.caches.entries()]
    .filter(([, store]) => store.size)
    .map(([name]) => name);
  return { handled, cache: filed[0] || null, fetched: worker.fetched };
}

/* ------------------------------------------------------------------------ */

console.log("\nAPI routes are never cached by the service worker");

{
  // The regression. Two different lookups, and the second must not be able to
  // receive the first one's answer.
  const a = await route(`${ORIGIN}/api/geocode?q=1+Main+St`);
  ok("/api/geocode is left to the browser", !a.handled,
     a.handled ? `cached in ${a.cache}` : "");

  const b = await route(`${ORIGIN}/api/place?id=1&county=Cobb&name=X&since=2026-01-01`);
  ok("/api/place is left to the browser", !b.handled,
     b.handled ? `cached in ${b.cache}` : "");

  const c = await route(`${ORIGIN}/api/vapid`);
  ok("/api/vapid is left to the browser", !c.handled, c.handled ? `cached in ${c.cache}` : "");

  const d = await route(`${ORIGIN}/api/anything-added-later`);
  ok("so is any API route added later", !d.handled, d.handled ? `cached in ${d.cache}` : "");
}

console.log("\n…except the one that is genuinely immutable");

{
  const r = await route(`${ORIGIN}/api/report?id=1&insp=2&county=Cobb`);
  ok("/api/report is cached", r.handled && r.cache === "reports-v1", r.cache || "not handled");
}

console.log("\nthe dataset, which is immutable for its stamp");

{
  for (const [path, want] of [
    ["/counties.json?v=2026-11-03", "data-v1"],
    ["/places/cobb.json?v=2026-11-03", "data-v1"],
    ["/locations.json?v=2026-11-03", "data-v1"],
    ["/chains.json?v=2026-11-03", "data-v1"],
    ["/trend.json?v=2026-11-03", "data-v1"],
    ["/changes.json?v=2026-11-03", "data-v1"],
    ["/history/30060.json?v=2026-11-03", "history-v1"],
  ]) {
    const r = await route(ORIGIN + path);
    ok(`${path.split("?")[0]} → ${want}`, r.handled && r.cache === want,
       r.handled ? r.cache : "not handled");
  }
}

console.log("\nthe freshness probe, which is never cached");

{
  const r = await route(`${ORIGIN}/version.json`);
  ok("/version.json is left alone", !r.handled, r.handled ? `cached in ${r.cache}` : "");
}

console.log("\nthe app shell and the map");

{
  const shell = await route(`${ORIGIN}/app.js?cache-id=abc123`);
  ok("app.js is served from the shell cache", shell.handled && shell.cache === "shell-" +
     readFileSync(new URL("../web/public/sw.js", HERE), "utf8").match(/SHELL_VERSION = "([^"]+)"/)[1],
     shell.cache || "not handled");

  const tile = await route("https://tile.openstreetmap.org/12/1100/1600.png");
  ok("tiles go to the tile cache", tile.handled && tile.cache === "tiles-v1",
     tile.cache || "not handled");

  const other = await route("https://example.com/anything.js");
  ok("other origins are left alone", !other.handled, other.handled ? `cached in ${other.cache}` : "");

  const post = await route(`${ORIGIN}/api/subscribe`, { method: "POST" });
  ok("non-GET requests are left alone", !post.handled);
}

console.log("\nthe stamped shell matches what the page asks for");

{
  // stamp_assets.py rewrites both; if they drift, every device installs the
  // previous release's files under the new version and nothing says so.
  const sw = readFileSync(new URL("../web/public/sw.js", HERE), "utf8");
  const html = readFileSync(new URL("../web/public/index.html", HERE), "utf8");
  const version = sw.match(/SHELL_VERSION = "([^"]+)"/)[1];
  const precached = [...sw.matchAll(/"\/(?:app\.js|styles\.css|qr\.js)\?cache-id=([^"]+)"/g)]
    .map((m) => m[1]);
  const requested = [...html.matchAll(/(?:app\.js|styles\.css)\?cache-id=([^"]+)/g)]
    .map((m) => m[1]);
  ok("SHELL_VERSION matches the app bucket it precaches",
     precached.every((id) => id === version), `${version} vs ${[...new Set(precached)]}`);
  ok("and index.html asks for that same bucket",
     requested.every((id) => id === version), `${version} vs ${[...new Set(requested)]}`);
}

console.log(failures
  ? `\nFAILED ${failures} of ${checks} checks\n`
  : `\n${checks} checks passed.\n`);
process.exit(failures ? 1 : 0);
