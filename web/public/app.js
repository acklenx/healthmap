/* Score — restaurant health inspections near you.
 *
 * Caching strategy (this data barely moves — inspections land a few times a
 * year per restaurant, and a *past* inspection never changes at all):
 *
 *   places.json   Requested as `places.json?v=<stamp>`. The URL only changes
 *                 when the crawler publishes new data, so the service worker
 *                 can hold it forever and cold starts are instant and offline.
 *   version.json  A few bytes. Checked at most once every CHECK_INTERVAL, and
 *                 never on the critical path -- the app renders from the cached
 *                 payload first and swaps in new data only if the stamp moved.
 *   /api/report   An inspection report for a past date is immutable, so these
 *                 are cached permanently on first view.
 */

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;   // how often to look for new data
const POSITION_MAX_AGE = 10 * 60 * 1000;     // reuse a fix this fresh, silently
const PAGE = 40;                              // rows appended per scroll batch
const MAX_PINS = 280;                         // pins drawn at once (see syncPins)

/* Cache-busting ids, rewritten by scripts/stamp_assets.py. Grouped by what
 * changes together: editing a line of CSS should not re-download 192 KB of
 * Leaflet that has not moved since it was vendored. */
const CACHE_ID = { app: "ac3bf833", vendor: "ff4e6fa7", icons: "2290448a" };
const bust = (path, bucket) => `${path}?cache-id=${CACHE_ID[bucket]}`;

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const KEY = {
  version: "score.dataVersion",
  checked: "score.lastChecked",
  pos: "score.lastPosition",
  favs: "score.favorites",
};

const GRADE_BANDS = [
  { min: 90, letter: "A", color: "var(--grade-a)" },
  { min: 80, letter: "B", color: "var(--grade-b)" },
  { min: 70, letter: "C", color: "var(--grade-c)" },
  { min: 0, letter: "U", color: "var(--grade-u)" },
];

const gradeFor = (score) => GRADE_BANDS.find((b) => score >= b.min).letter;
const colorFor = (score) => GRADE_BANDS.find((b) => score >= b.min).color;

const $ = (sel) => document.querySelector(sel);
const el = {
  list: $("#list"), status: $("#status"), empty: $("#empty"), search: $("#search"),
  locate: $("#locate"), locateLabel: $("#locate-label"), sentinel: $("#sentinel"),
  freshness: $("#freshness"), sheet: $("#sheet"), sheetName: $("#sheet-name"),
  sheetAddr: $("#sheet-addr"), sheetBody: $("#sheet-body"), favBtn: $("#fav-btn"),
  favLabel: $("#fav-label"), dirBtn: $("#dir-btn"),
  topbar: $(".topbar"), paneMap: $("#pane-map"), map: $("#map"), mapNote: $("#map-note"),
  setHome: $("#sethome"), crosshair: $("#crosshair"),
  viewToggle: $("#viewtoggle"), viewToggleLabel: $("#viewtoggle-label"),
  sheetScroll: $("#sheet .sheet-body"),
  sheetMap: $("#sheet-map"), sheetMapCanvas: $("#sheet-map-canvas"),
  sheetMapLink: $("#sheet-map-link"), sheetMapTag: $("#sheet-map-tag"),
  sheetApprox: $("#sheet-approx"), menuBtn: $("#menu-btn"),
  filterSheet: $("#filtersheet"), filterBtn: $("#filter-btn"), filterCount: $("#filter-count"),
  mapLocate: $("#map-locate"),
  dockSearch: $("#dock-search"), searchBtn: $("#search-btn"), searchDone: $("#search-done"),
  searchDot: $("#search-dot"),
  moreSheet: $("#moresheet"), moreBtn: $("#more-btn"), moreFresh: $("#more-fresh"),
  statsSheet: $("#statssheet"), statsBody: $("#stats-body"), statsScope: $("#stats-scope"),
  shareSheet: $("#sharesheet"), shareQr: $("#share-qr"), shareLink: $("#share-link"),
  shareSub: $("#share-sub"), shareCopy: $("#share-copy"), shareCopyLabel: $("#share-copy-label"),
  shareNative: $("#share-native"),
  menuLocSub: $("#menu-loc-sub"),
};

const locEl = {
  sheet: $("#locsheet"), current: $("#loc-current"), input: $("#loc-input"),
  form: $("#loc-form"), msg: $("#loc-msg"), gps: $("#loc-gps"),
};

const state = {
  places: [],
  generated: null,
  // home  = where distances are measured from. Persisted; drives the whole app.
  // gps   = the device's own last fix. Live, never persisted, never sorts.
  // They are separate so that looking somewhere else on the map doesn't lose
  // track of where you actually are. `pinned` means a human chose this home,
  // which stops a background GPS refresh from quietly stealing it back.
  home: readJSON(KEY.pos, null),
  gps: null,
  filter: "all",
  // Which grades to draw. A set rather than one of "A only"/"B or worse",
  // because "just the U's" is a real thing to want to look at and those two
  // canned options could not express it.
  grades: new Set(["A", "B", "C", "U"]),
  sort: "dist",
  query: "",
  shown: PAGE,
  view: [],
  favorites: new Set(readJSON(KEY.favs, [])),
  open: null,
  pane: "list",      // which pane a phone is showing; both are shown from 980px
};

/* ------------------------------------------------------------- helpers --- */

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — the app works without persistence */
  }
}

const escapeHTML = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/** Great-circle distance in miles. */
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatDistance(mi) {
  if (mi == null) return "";
  if (mi < 0.19) return `${Math.round(mi * 5280 / 10) * 10} ft`;
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

/* How old the score is, for the list row.
 *
 * "Jun 9, 2026" answers a question nobody is asking while scrolling. The one
 * they are asking is whether the grade is current, and an age answers it in a
 * third of the width -- which is what lets the distance be the loudest thing
 * in the column when the list is sorted by distance. The exact date is still
 * on every inspection in the sheet. */
function inspectionAge(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = Math.max(0, Math.round((Date.now() - new Date(y, m - 1, d)) / 2.628e9));
  if (months < 1) return "this month";
  if (months === 1) return "1 mo ago";
  if (months < 12) return `${months} mo ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 yr ago" : `${years} yr ago`;
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diff / 3.6e6);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** Source data is ALL CAPS. Note the apostrophe guard: a plain \b rule turns
 *  "DADDY'S" into "Daddy'S". */
/** A maps deep link. maps.google.com/?q= is the one form both iOS and Android
 *  hand off to the installed maps app, falling back to the web on desktop. */
/* The mark for a position we are guessing at.
 *
 * A dashed pin with a question mark in it. Dashed is already this app's word
 * for "not confirmed" -- the map pin border, the saved-place star outline and
 * the halo round a ZIP centroid all use it -- so this reads as the same idea
 * rather than a new one. The question mark is what survives at 13px in a list
 * row, where a dash pattern alone is just texture.
 */
const APPROX_ICON =
  '<svg class="approx-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path class="approx-pin" d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z"/>' +
  '<path d="M10.4 8.5a1.7 1.7 0 1 1 2.4 1.55c-.6.4-.85.78-.85 1.35"/>' +
  '<path d="M12 13.4v.01"/></svg>';

function mapsUrl(p) {
  const q = `${p.name}, ${p.street}, ${p.city}, GA ${p.zip}`;
  return `https://maps.google.com/?q=${encodeURIComponent(q)}`;
}

/* The health department publishes a name and an address and nothing else -- no
 * website, no menu, no phone. So this is a web search, not a link, and the
 * button says "Look up" rather than "Website" because promising a homepage the
 * data does not contain is how you end up on somebody else's. */
function lookupUrl(p) {
  const q = `${p.name} ${p.city} GA restaurant menu`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/(^|[^a-z'])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase())
    .replace(/\bMc([a-z])/g, (_, ch) => "Mc" + ch.toUpperCase())
    .replace(/\b(Llc|Bbq|Ii|Iii|Iv|Kfc|Cfa|Ihop|Dq|Tgi)\b/g, (m) => m.toUpperCase());
}

/* ---------------------------------------------------------------- data --- */

async function loadData() {
  const known = localStorage.getItem(KEY.version);

  if (known) {
    // Fast path: the service worker answers this from cache, offline included.
    // The app is on screen and usable before any network request is made.
    try {
      applyPayload(await fetchPayload(known));
    } catch {
      /* cache miss — the update check below will fetch it */
    }
  }
  await checkForUpdate();
}

/** Look for a newer dataset. Runs on every launch: it's a few bytes, it isn't
 *  on the critical path, and throttling it means a phone can sit on stale data
 *  for hours after a refresh lands. The *payload* is what we cache hard. */
async function checkForUpdate() {
  const known = localStorage.getItem(KEY.version);
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const { generated } = await res.json();
    localStorage.setItem(KEY.checked, String(Date.now()));
    if (generated === known && state.places.length) return;

    applyPayload(await fetchPayload(generated));
    localStorage.setItem(KEY.version, generated);
  } catch {
    if (!state.places.length) {
      el.status.textContent =
        "Couldn't reach the inspection data. Check your connection and reload.";
    }
  }
}

// Coming back to an already-open app checks again, but only occasionally.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  const last = Number(localStorage.getItem(KEY.checked) || 0);
  if (Date.now() - last > CHECK_INTERVAL) checkForUpdate();
});

async function fetchPayload(stamp) {
  const res = await fetch(`/places.json?v=${encodeURIComponent(stamp)}`);
  if (!res.ok) throw new Error(`places.json: ${res.status}`);
  return res.json();
}

function applyPayload(payload) {
  state.places = payload.places.map((p) => ({
    id: p.i,
    name: titleCase(p.n),
    street: titleCase(p.a),
    city: titleCase(p.c),
    zip: p.z,
    county: p.o,
    lat: p.y,
    lon: p.x,
    precision: p.p,
    history: p.h.map(([date, score, inspId]) => ({ date, score, inspId })),
    // Precomputed once so filtering/searching stays cheap across ~13k rows.
    search: `${p.n} ${p.a} ${p.c}`.toLowerCase(),
    latest: p.h[0] ? { date: p.h[0][0], score: p.h[0][1], inspId: p.h[0][2] } : null,
  }));
  state.generated = payload.generated;
  el.freshness.textContent =
    `${state.places.length.toLocaleString()} places in ${payload.counties.join(", ")} · ` +
    `data refreshed ${relativeTime(payload.generated)}`;
  render();
}

/* ------------------------------------------------------------ location --- */

function setLocateState(mode, label) {
  el.locate.dataset.state = mode;
  el.mapLocate.dataset.state = mode;      // the map's copy shows the same state
  el.locateLabel.textContent = label;
}

/** The device's own fix. Marks the map; never touches the sort order. */
function setGps(lat, lon) {
  state.gps = { lat, lon, at: Date.now() };
  syncGpsMarker();
}

/** Move the point everything is measured from. `pinned` records that a human
 *  put it there, so a later background fix leaves it alone. */
function setHome(lat, lon, label, { pinned = true, recenter = false } = {}) {
  state.home = { lat, lon, label, at: Date.now(), pinned };
  writeJSON(KEY.pos, state.home);
  setLocateState("on", label);
  state.shown = PAGE;
  render();
  syncHomeMarker({ recenter });
}

function requestLocation({ silent = false, adopt = false, onFail, onSuccess } = {}) {
  if (!navigator.geolocation) {
    if (!silent) onFail?.("This browser can't provide a location.");
    return;
  }
  if (!silent) setLocateState("busy", "Locating…");

  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      setGps(coords.latitude, coords.longitude);
      // A home someone placed by hand is theirs to keep. Only a home that is
      // simply following the device gets moved by a new fix -- unless they
      // asked for exactly that by tapping "use my current location".
      if (adopt || !state.home?.pinned) {
        setHome(coords.latitude, coords.longitude, "Near you",
                { pinned: false, recenter: adopt });
      }
      onSuccess?.();
    },
    (err) => {
      if (silent) return;
      setLocateState(state.home ? "on" : "", state.home?.label || "Set location");
      onFail?.(
        err.code === err.PERMISSION_DENIED
          ? "Location is blocked for this site. Type a ZIP code or address instead."
          : "Couldn't get a location fix. Type a ZIP code or address instead."
      );
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: POSITION_MAX_AGE }
  );
}

/* ---- manual entry -------------------------------------------------------- *
 * A ZIP or a city is resolved from the dataset already on the device: average
 * the coordinates of every establishment there. That is instant, works with no
 * signal, and needs no geocoding service. Anything else (a street address) is
 * sent to /api/geocode.
 */

let placeIndex = null;

function buildIndex() {
  if (placeIndex) return placeIndex;
  const zips = new Map();
  const cities = new Map();
  const add = (map, key, p) => {
    if (!key) return;
    const bucket = map.get(key) || [0, 0, 0];
    bucket[0] += p.lat;
    bucket[1] += p.lon;
    bucket[2] += 1;
    map.set(key, bucket);
  };
  for (const p of state.places) {
    add(zips, p.zip, p);
    add(cities, p.city.toLowerCase(), p);
  }
  const centroid = (map) => (key) => {
    const b = map.get(key);
    return b ? { lat: b[0] / b[2], lon: b[1] / b[2], count: b[2] } : null;
  };
  // ZIPs are allocated geographically, so numeric closeness is a decent proxy
  // for "the nearest ZIP we actually cover" — good enough for a suggestion.
  const known = [...zips.keys()].sort();
  const nearestZip = (zip) => {
    if (!known.length) return null;
    const target = Number(zip);
    return known.reduce((best, z) =>
      Math.abs(Number(z) - target) < Math.abs(Number(best) - target) ? z : best
    );
  };
  placeIndex = { zip: centroid(zips), city: centroid(cities), nearestZip };
  return placeIndex;
}

/** Returns {lat, lon, label} on success, or {error} explaining what went wrong.
 *  The distinction matters: "that ZIP isn't in our three counties" and "we
 *  couldn't parse that" call for very different next steps from the user. */
async function resolveLocation(text) {
  const query = text.trim();
  if (!query) return { error: "Enter a ZIP code, city, or address." };

  if (!state.places.length) {
    return { error: "Still loading restaurants — try again in a moment." };
  }

  const index = buildIndex();
  const bare = query.replace(/,?\s*(ga|georgia)\s*$/i, "").trim();

  const zip = bare.match(/^(\d{5})(?:-\d{4})?$/);
  if (zip) {
    const hit = index.zip(zip[1]);
    if (hit) return { ...hit, label: zip[1] };
    // A well-formed ZIP we have no restaurants in is almost always a ZIP
    // outside the three counties, not a typo. Say so, and suggest the nearest
    // covered ZIP rather than dead-ending.
    const near = index.nearestZip(zip[1]);
    return {
      error:
        `No inspections on file for ${zip[1]} — it's likely outside Cobb, ` +
        `Cherokee and Fulton.` + (near ? ` Try ${near} instead.` : ""),
    };
  }

  const city = index.city(bare.toLowerCase());
  if (city) return { ...city, label: titleCase(bare) };

  // A street address: hand it to the geocoder.
  let data;
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    return { error: "Address lookup is unavailable. A ZIP code works offline." };
  }
  if (!data.lat) return { error: `Couldn't find “${query}”. Try a ZIP code or city.` };
  return { lat: data.lat, lon: data.lon, label: data.label || query };
}

function openLocationSheet(message) {
  locMsg(message || "", false);
  locEl.current.textContent = state.home
    ? `Currently sorting from ${state.home.label || "your location"}.`
    : "Not set — the list isn't sorted by distance yet.";
  locEl.input.value = "";
  locEl.sheet.hidden = false;
  document.body.classList.add("sheet-open");
}

function closeLocationSheet() {
  locEl.sheet.hidden = true;
  document.body.classList.remove("sheet-open");
}

/* ---- filter and sort sheet ---------------------------------------------- */

/* One place that knows a sheet is open, so the dock and the scroll lock cannot
 * drift out of step with each other. */
function setSheet(node, open, trigger) {
  node.hidden = !open;
  if (trigger) trigger.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("sheet-open", open);
}

/* ---- search ------------------------------------------------------------- */

function openSearch() {
  el.dockSearch.hidden = false;
  el.searchBtn.setAttribute("aria-expanded", "true");
  el.search.focus();
}

/** Collapse the field, but only when it is empty -- hiding a live query would
 *  leave the list filtered by something invisible. */
function closeSearch() {
  if (el.search.value.trim()) { el.search.blur(); return; }
  el.dockSearch.hidden = true;
  el.searchBtn.setAttribute("aria-expanded", "false");
}

function syncSearchDot() {
  el.searchDot.hidden = !state.query.trim();
}

/* ---- shareable state ---------------------------------------------------- */

/* A link that reopens what is on screen now.
 *
 * A place gets ?p=<id>. Otherwise the link carries where the list is sorted
 * from and what is filtered, because "here, with the U's showing" is the thing
 * worth handing to someone -- not the app's front page. */
function shareUrl() {
  const url = new URL(location.origin + location.pathname);
  if (state.open) {
    url.searchParams.set("p", state.open.id);
    return url.toString();
  }
  if (state.home) {
    url.searchParams.set("at", `${state.home.lat.toFixed(5)},${state.home.lon.toFixed(5)}`);
    if (state.home.label) url.searchParams.set("label", state.home.label);
  }
  if (state.filter !== "all") url.searchParams.set("show", state.filter);
  if (state.grades.size < GRADE_BANDS.length) url.searchParams.set("g", [...state.grades].join(""));
  if (state.sort !== "dist") url.searchParams.set("by", state.sort);
  if (state.query.trim()) url.searchParams.set("q", state.query.trim());
  if (document.body.dataset.view === "map") url.searchParams.set("view", "map");
  return url.toString();
}

/** Restore whatever a shared link was carrying. Anything unparseable is
 *  ignored rather than fatal -- a mangled link should still open the app. */
function applyShareState() {
  const q = new URLSearchParams(location.search);
  if (!q.toString()) return;

  const at = q.get("at");
  if (at && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(at)) {
    const [lat, lon] = at.split(",").map(Number);
    state.home = { lat, lon, label: q.get("label") || "a shared link", pinned: true };
  }
  const show = q.get("show");
  if (show === "fav") state.filter = show;

  const g = q.get("g");
  if (g) {
    const letters = [...g.toUpperCase()].filter((c) => GRADE_BANDS.some((b) => b.letter === c));
    if (letters.length) state.grades = new Set(letters);
  }
  const by = q.get("by");
  if (["dist", "recent", "worst"].includes(by)) state.sort = by;

  const query = q.get("q");
  if (query) { state.query = query; el.search.value = query; el.dockSearch.hidden = false; }

  if (q.get("view") === "map") state.pendingView = "map";
  // ?p= comes from a shared link, ?place= from a push notification.
  const p = Number(q.get("p") || q.get("place"));
  if (p) state.pendingPlace = p;

  // Leave the address bar clean; the state is in memory now.
  history.replaceState(null, "", location.pathname);
}

/* ---- share -------------------------------------------------------------- */

let qrLib = null;
const loadQr = () => (qrLib ||= import(bust("/qr.js", "app")));

async function openShareSheet() {
  const url = shareUrl();
  el.shareSub.textContent = state.open
    ? state.open.name
    : "Whatever the list is showing right now";
  el.shareLink.textContent = url;
  el.shareQr.innerHTML = "<p>Building the code…</p>";
  el.shareNative.hidden = !navigator.share;
  el.shareCopyLabel.textContent = "Copy link";
  setSheet(el.shareSheet, true);

  try {
    const { encode, toSvg } = await loadQr();
    el.shareQr.innerHTML = toSvg(encode(url));
  } catch {
    // The link itself is right there to be copied, so this is a downgrade
    // rather than a failure.
    el.shareQr.innerHTML = "<p>Couldn’t draw the code — copy the link instead.</p>";
  }
}

function closeShareSheet() { setSheet(el.shareSheet, false); }

/* ---- scores in this area ------------------------------------------------ */

/** Mean, spread and grade counts over whatever the list is currently showing. */
function summarise(rows) {
  const scores = [];
  const grades = { A: 0, B: 0, C: 0, U: 0 };
  for (const p of rows) {
    if (!p.latest) continue;
    scores.push(p.latest.score);
    grades[gradeFor(p.latest.score)] += 1;
  }
  const n = scores.length;
  if (!n) return { n: 0, grades };
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  // Population, not sample: this is every score in the set, not a draw from it.
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const sorted = scores.slice().sort((a, b) => a - b);
  const mid = n >> 1;
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n, mean, sd, median, min: sorted[0], max: sorted[n - 1], grades };
}

/** The same summary, cut by city or ZIP. Areas with only a handful of places
 *  are left out: an average of three is noise, and ranking on it invites a
 *  conclusion the data cannot support. */
const AREA_MIN = 12;

function byArea(rows, key) {
  const buckets = new Map();
  for (const p of rows) {
    if (!p.latest) continue;
    const k = (key === "zip" ? p.zip : p.city) || "—";
    const bucket = buckets.get(k);
    if (bucket) bucket.push(p);
    else buckets.set(k, [p]);
  }
  return [...buckets]
    .map(([name, members]) => ({ name, ...summarise(members) }))
    .filter((a) => a.n >= AREA_MIN)
    .sort((a, b) => b.mean - a.mean);
}

function statsHTML(rows) {
  const s = summarise(rows);
  if (!s.n) return `<p class="empty">No scored places in this selection.</p>`;

  const bars = GRADE_BANDS.map((band) => {
    const n = s.grades[band.letter];
    const pct = (n / s.n) * 100;
    return `<div class="dist-row">
      <span class="dist-key" data-g="${band.letter}">${band.letter}</span>
      <span class="dist-track"><span class="dist-fill" data-g="${band.letter}" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="dist-n">${n.toLocaleString()}<small>${pct.toFixed(0)}%</small></span>
    </div>`;
  }).join("");

  const areaRows = (key) => byArea(rows, key).map((a) => `<tr>
      <th scope="row">${escapeHTML(titleCase(String(a.name)))}</th>
      <td><b>${a.mean.toFixed(1)}</b></td>
      <td>${a.sd.toFixed(1)}</td>
      <td>${a.n.toLocaleString()}</td>
    </tr>`).join("");

  const cities = areaRows("city");
  const zips = areaRows("zip");

  return `
    <div class="stat-grid">
      <div class="stat"><b>${s.mean.toFixed(1)}</b><small>Average score</small></div>
      <div class="stat"><b>${s.median.toFixed(0)}</b><small>Median</small></div>
      <div class="stat"><b>±${s.sd.toFixed(1)}</b><small>Std deviation</small></div>
      <div class="stat"><b>${s.n.toLocaleString()}</b><small>Places scored</small></div>
    </div>
    <p class="sheet-hint">Two thirds of scores fall within one standard deviation of
      the average — here, roughly ${Math.max(0, s.mean - s.sd).toFixed(0)} to
      ${Math.min(100, s.mean + s.sd).toFixed(0)}. Lowest on record in this
      selection is ${s.min}, highest is ${s.max}.</p>

    <h3 class="sec-title">How many at each grade</h3>
    <div class="dist">${bars}</div>

    ${cities ? `<h3 class="sec-title">By city</h3>
      <div class="table-wrap"><table class="area-table">
        <thead><tr><th scope="col">Place</th><th scope="col">Avg</th><th scope="col">SD</th><th scope="col">N</th></tr></thead>
        <tbody>${cities}</tbody></table></div>` : ""}

    ${zips ? `<h3 class="sec-title">By ZIP</h3>
      <div class="table-wrap"><table class="area-table">
        <thead><tr><th scope="col">ZIP</th><th scope="col">Avg</th><th scope="col">SD</th><th scope="col">N</th></tr></thead>
        <tbody>${zips}</tbody></table></div>` : ""}

    <p class="sheet-hint">Areas with fewer than ${AREA_MIN} scored places are left out —
      an average over a handful of restaurants is noise, and ranking on it would
      invite a conclusion the data cannot support.</p>`;
}

function openStatsSheet() {
  const rows = state.view;
  const scope = [];
  if (state.query.trim()) scope.push(`matching “${state.query.trim()}”`);
  if (state.filter === "fav") scope.push("saved only");
  if (state.grades.size < GRADE_BANDS.length) scope.push(`grades ${[...state.grades].join(", ")}`);
  el.statsScope.textContent = scope.length
    ? `${rows.length.toLocaleString()} places — ${scope.join(", ")}`
    : `All ${rows.length.toLocaleString()} places on record`;
  el.statsBody.innerHTML = statsHTML(rows);
  el.statsBody.scrollTop = 0;
  setSheet(el.statsSheet, true);
}

function closeStatsSheet() { setSheet(el.statsSheet, false); }

/* ---- the More menu ------------------------------------------------------ */

function openMoreSheet() {
  el.menuLocSub.textContent = state.home
    ? state.home.label || "Set to your current location"
    : "Not set — the list isn't sorted by distance";
  el.moreFresh.textContent = el.freshness.textContent;
  setSheet(el.moreSheet, true, el.moreBtn);
}

function closeMoreSheet() { setSheet(el.moreSheet, false, el.moreBtn); }

function openFilterSheet() {
  el.filterSheet.hidden = false;
  el.filterBtn.setAttribute("aria-expanded", "true");
  document.body.classList.add("sheet-open");
}

function closeFilterSheet() {
  el.filterSheet.hidden = true;
  el.filterBtn.setAttribute("aria-expanded", "false");
  document.body.classList.remove("sheet-open");
}

/* A filter you cannot see is the thing this layout set out to fix, so the
 * button says when one is on. Sort is not counted: there is always exactly one,
 * so a dot for it would be lit permanently and mean nothing. */
function syncFilterDot() {
  el.filterCount.hidden =
    state.filter === "all" && state.grades.size === GRADE_BANDS.length;
}

/* Grades are a toggle set, not a choice of one. The last one on cannot be
 * turned off -- an empty set shows nothing, which reads as a broken app rather
 * than a filter, and there is no affordance on that screen to explain it. */
function toggleGrade(letter) {
  if (state.grades.has(letter)) {
    if (state.grades.size === 1) return;
    state.grades.delete(letter);
  } else {
    state.grades.add(letter);
  }
  state.shown = PAGE;
  syncGradeChips();
  syncFilterDot();
  render();
}

function syncGradeChips() {
  document.querySelectorAll("[data-grade]").forEach((b) => {
    const on = state.grades.has(b.dataset.grade);
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

function locMsg(text, isError) {
  locEl.msg.textContent = text;
  locEl.msg.classList.toggle("is-error", !!isError);
}

/* --------------------------------------------------------------- render --- */

function computeView() {
  const pos = state.home;
  const q = state.query.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];

  let rows = state.places;

  if (state.filter === "fav") {
    rows = rows.filter((p) => state.favorites.has(p.id));
  }

  if (state.grades.size < GRADE_BANDS.length) {
    rows = rows.filter((p) =>
      p.latest && state.grades.has(gradeFor(p.latest.score))
    );
  }

  if (terms.length) {
    rows = rows.filter((p) => terms.every((t) => p.search.includes(t)));
  }

  // Distance is written onto the records themselves rather than into copies —
  // spreading ~13k objects on every keystroke is real work on a phone.
  rows = rows === state.places ? rows.slice() : rows;
  for (const p of rows) {
    p.distance = pos ? distanceMiles(pos.lat, pos.lon, p.lat, p.lon) : null;
  }

  const byDist = (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity);
  if (state.sort === "dist" && pos) rows.sort(byDist);
  else if (state.sort === "worst") {
    rows.sort((a, b) => (a.latest?.score ?? 101) - (b.latest?.score ?? 101) || byDist(a, b));
  } else {
    rows.sort((a, b) =>
      (b.latest?.date ?? "").localeCompare(a.latest?.date ?? "") || byDist(a, b)
    );
  }
  return rows;
}

function cardHTML(p) {
  const latest = p.latest;
  const grade = latest ? gradeFor(latest.score) : "U";
  const star = state.favorites.has(p.id)
    ? '<svg class="card-star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85Z"/></svg>'
    : "";
  // An approximate distance is measured from the middle of a ZIP code, so it
  // is marked in the list rather than only inside the sheet -- the whole point
  // of sorting by distance is that the top of the list is trustworthy.
  const dist = p.distance != null
    ? `<span class="card-dist${p.precision === 0 ? " is-approx" : ""}">` +
      `${p.precision === 0 ? APPROX_ICON : ""}${formatDistance(p.distance)}</span>`
    : "";
  return `<li><button class="card" type="button" data-id="${p.id}">
    <span class="badge" data-g="${grade}">${grade}<small>${latest ? latest.score : "—"}</small></span>
    <span class="card-main">
      <span class="card-name">${star}${escapeHTML(p.name)}</span>
      <span class="card-sub">${escapeHTML(p.street)}, ${escapeHTML(p.city)}</span>
    </span>
    <span class="card-meta">${dist}<span class="card-age">${
      latest ? `Scored ${inspectionAge(latest.date)}` : "Never scored"
    }</span></span>
  </button></li>`;
}

/** Append the next batch without touching the rows already on screen.
 *  Rebuilding all of them on every scroll batch gets visibly slow on a phone
 *  once a few hundred are rendered. */
function appendRows() {
  const from = el.list.childElementCount;
  const slice = state.view.slice(from, state.shown);
  if (slice.length) el.list.insertAdjacentHTML("beforeend", slice.map(cardHTML).join(""));
}

function render({ recompute = true } = {}) {
  if (recompute) state.view = computeView();
  el.list.innerHTML = "";
  appendRows();

  el.status.hidden = state.places.length > 0;
  el.empty.hidden = state.view.length > 0 || !state.places.length;
  if (!el.empty.hidden) {
    el.empty.textContent = state.query
      ? `No restaurants match “${state.query}”.`
      : state.filter === "fav"
        ? "Nothing saved yet. Open a restaurant and tap Save."
        : state.grades.size < GRADE_BANDS.length
          ? `No ${[...state.grades].join(", ")} scores here. Turn more grades on, or move the map.`
          : "Nothing matches those filters.";
  }
  if (state.sort === "dist" && !state.home && state.places.length) {
    el.status.hidden = false;
    el.status.textContent =
      "Set your location to sort by what's closest — or enter a ZIP code.";
  }
  syncPins();      // the map draws whatever the list just decided to show
}

/* ------------------------------------------------------------------ map --- */
/* The map and the list are two views of one dataset: whatever the filters and
 * the sort have produced, both draw it. Leaflet and its stylesheet are fetched
 * the first time a map is actually shown, so a phone that only ever uses the
 * list pays nothing for this.
 *
 * Tiles come from OpenStreetMap's own raster servers — no key, no account, and
 * the service worker keeps the ones you have already looked at, so a route you
 * travel often stays on screen offline. `crossOrigin` matters for that: without
 * it the tiles come back opaque and the cache can't tell a hit from a failure.
 */

let L = null;
let leafletLoading = null;
let map = null;
let pinLayer = null;
let homeMarker = null;
let gpsMarker = null;
let mapReady = false;
const pins = new Map();          // place id -> the marker currently drawn for it
const clusters = new Map();      // grid cell key -> the cluster marker for it

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoading) return leafletLoading;

  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = bust("/vendor/leaflet/leaflet.css", "vendor");
    document.head.append(css);

    const js = document.createElement("script");
    js.src = bust("/vendor/leaflet/leaflet.js", "vendor");
    js.addEventListener("load", () => resolve(window.L));
    js.addEventListener("error", () => {
      leafletLoading = null;                       // let a later attempt retry
      reject(new Error("leaflet failed to load"));
    });
    document.head.append(js);
  });
  return leafletLoading;
}

/** Bounding box of the whole dataset — the opening view when there is no
 *  position to centre on yet. */
function datasetBounds() {
  if (!state.places.length) return null;
  let s = 90, n = -90, w = 180, e = -180;
  for (const p of state.places) {
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
    if (p.lon < w) w = p.lon;
    if (p.lon > e) e = p.lon;
  }
  return [[s, w], [n, e]];
}

/* A five-point star on a 40x40 box: outer radius 19, inner 9.6, first point
 * straight up. The inner pentagon is ~15px across, which is what makes room
 * for the grade letter to sit inside it. */
const STAR_PATH =
  "M20.00,1.00 L25.64,12.23 L38.07,14.13 L29.13,22.97 L31.17,35.37 " +
  "L20.00,29.60 L8.83,35.37 L10.87,22.97 L1.93,14.13 L14.36,12.23 Z";

/** Same pairing as the list badges: the grade letter is written on the marker,
 *  so the colour is reinforcement rather than the only carrier of the meaning.
 *  Saved places take the star shape; everything else takes the plain pin. */
function pinIcon(p, { ring = true } = {}) {
  const g = p.latest ? gradeFor(p.latest.score) : "U";
  const flags = [
    p.precision === 0 ? "is-approx" : "",
    ring && state.open?.id === p.id ? "is-open" : "",
  ].filter(Boolean).join(" ");

  if (state.favorites.has(p.id)) {
    return L.divIcon({
      className: "pin-wrap",
      html: `<span class="pin-star ${flags}" data-g="${g}"><svg viewBox="0 0 40 40" aria-hidden="true">` +
            `<path d="${STAR_PATH}"/><text x="20" y="25.4">${g}</text></svg></span>`,
      iconSize: [38, 38],
      iconAnchor: [19, 19],       // a star has no tip; it marks from its centre
    });
  }

  return L.divIcon({
    className: "pin-wrap",
    html: `<span class="pin ${flags}" data-g="${g}"><b>${g}</b></span>`,
    iconSize: [28, 28],
    // The pin is a rounded square rotated -45°, so its point lands below the
    // box: half the diagonal past the centre, not at the box's own edge.
    iconAnchor: [14, 34],
  });
}

/** Everything an icon's appearance depends on, so panning can skip redrawing
 *  markers that haven't actually changed. */
const pinSignature = (p) =>
  `${p.latest ? p.latest.score : "-"}|${state.favorites.has(p.id) ? 1 : 0}` +
  `|${state.open?.id === p.id ? 1 : 0}`;

/* Pins that land within CELL px of each other are drawn as one.
 *
 * A county view puts thousands of places on screen and downtown Marietta alone
 * stacks a dozen markers into a pile no thumb can pick apart -- the pin under
 * the others is unreachable at any zoom below street level. Grid clustering in
 * screen space rather than a plugin: Leaflet is vendored here on purpose, and
 * this is forty lines against another library to keep in step with it.
 *
 * The cluster stays deliberately neutral. Colour in this app means a grade, and
 * a bag of places does not have one -- writing the worst score on it would read
 * as a verdict on all of them. */
const CELL = 52;                 // a shade under twice the 28px pin

function clusterIcon(n) {
  return L.divIcon({
    className: "pin-wrap",
    html: `<span class="pin-cluster"><b>${n}</b></span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

/** Draw the rows the list is showing — but only those in frame, and at most
 *  MAX_PINS markers. state.view is already sorted, so the cap keeps the nearest
 *  (or newest, or lowest — whichever sort is on) rather than an arbitrary
 *  slice, and the note below says what was left out instead of dropping it
 *  silently. */
function syncPins() {
  if (!mapReady) return;
  const b = map.getBounds().pad(0.12);
  const south = b.getSouth(), north = b.getNorth();
  const west = b.getWest(), east = b.getEast();

  // Saved places are exempt from the cap and from clustering. There are only
  // ever a handful, and seeing all of them at once is the main reason to zoom
  // out in the first place; letting them be swallowed defeats the feature.
  const saved = [];
  const rest = [];
  let inFrame = 0;
  for (const p of state.view) {
    if (p.lat < south || p.lat > north || p.lon < west || p.lon > east) continue;
    inFrame += 1;
    if (state.favorites.has(p.id)) saved.push(p);
    else rest.push(p);
  }

  // Bucket by where each pin actually lands on screen, so the grid follows the
  // zoom without anything having to be recomputed when it changes.
  const cells = new Map();
  for (const p of rest) {
    const pt = map.latLngToLayerPoint([p.lat, p.lon]);
    const key = `${Math.floor(pt.x / CELL)}:${Math.floor(pt.y / CELL)}`;
    const cell = cells.get(key);
    if (cell) cell.push(p);
    else cells.set(key, [p]);
  }

  const singles = [];
  const groups = [];
  for (const [key, members] of cells) {
    if (members.length === 1) singles.push(members[0]);
    else groups.push([key, members]);
  }

  const budget = Math.max(0, MAX_PINS - saved.length - groups.length);
  const wanted = saved.concat(singles.slice(0, budget));
  const shown = wanted.length + groups.reduce((n, [, m]) => n + m.length, 0);

  const keep = new Set();
  for (const p of wanted) {
    keep.add(p.id);
    const sig = pinSignature(p);
    const existing = pins.get(p.id);
    if (!existing) {
      const marker = L.marker([p.lat, p.lon], {
        icon: pinIcon(p),
        title: `${p.name} — ${p.street}`,
        keyboard: false,
        riseOnHover: true,
      });
      marker._sig = sig;
      marker.on("click", () => openSheet(p.id));
      marker.addTo(pinLayer);
      pins.set(p.id, marker);
    } else if (existing._sig !== sig) {
      existing._sig = sig;
      existing.setIcon(pinIcon(p));
    }
  }

  for (const [id, marker] of pins) {
    if (keep.has(id)) continue;
    pinLayer.removeLayer(marker);
    pins.delete(id);
  }

  const keepCells = new Set();
  for (const [key, members] of groups) {
    keepCells.add(key);
    const existing = clusters.get(key);
    if (existing && existing._n === members.length) continue;
    if (existing) pinLayer.removeLayer(existing);

    let lat = 0, lon = 0;
    for (const m of members) { lat += m.lat; lon += m.lon; }
    const marker = L.marker([lat / members.length, lon / members.length], {
      icon: clusterIcon(members.length),
      title: `${members.length} places here — tap to zoom in`,
      keyboard: false,
    });
    marker._n = members.length;
    // Zoom to what is inside rather than by a fixed step: one level is not
    // enough to break up a tight pile, and three overshoots a loose one.
    marker.on("click", () => {
      const bounds = L.latLngBounds(members.map((m) => [m.lat, m.lon]));
      if (bounds.getNorth() === bounds.getSouth() && bounds.getEast() === bounds.getWest()) {
        map.setView(bounds.getCenter(), Math.min(map.getZoom() + 3, 19));
      } else {
        map.fitBounds(bounds, { padding: [48, 48], maxZoom: 18 });
      }
    });
    marker.addTo(pinLayer);
    clusters.set(key, marker);
  }

  for (const [key, marker] of clusters) {
    if (keepCells.has(key)) continue;
    pinLayer.removeLayer(marker);
    clusters.delete(key);
  }

  setMapNote(inFrame, shown, saved.length);
}

function setMapNote(inFrame, drawn, saved = 0) {
  // The cap is allowed to drop pins; it is not allowed to do it quietly. That
  // report and the "no location yet" nudge can both apply at once, so they are
  // assembled rather than ranked against each other.
  const parts = [];
  if (state.places.length) {
    if (!inFrame) parts.push("Nothing in view matches. Zoom out, or loosen the filters.");
    else if (drawn < inFrame) {
      parts.push(`Showing ${drawn} of ${inFrame.toLocaleString()} places here — zoom in for the rest.`);
      if (saved) parts.push("Saved places always show.");
    }
    if (!state.home) {
      parts.push("No home set — move the map to where you are and tap “Sort from here”.");
    }
  }
  const text = parts.join(" ");
  el.mapNote.textContent = text;
  el.mapNote.hidden = !text;
}

/** Home: the point every distance is measured from. Draggable, because moving
 *  it is the same act as typing a ZIP — just done by hand. */
function syncHomeMarker({ recenter = false } = {}) {
  if (!mapReady) return;
  queueMicrotask(syncSearchHere);
  const home = state.home;

  if (!home) {
    if (homeMarker) map.removeLayer(homeMarker);
    homeMarker = null;
    return;
  }

  if (!homeMarker) {
    homeMarker = L.marker([home.lat, home.lon], {
      icon: L.divIcon({
        className: "pin-wrap",
        html: '<span class="home-pin"><svg viewBox="0 0 24 24" aria-hidden="true">' +
              '<path d="M3.6 10.4 12 3.6l8.4 6.8"/><path d="M5.8 12.2V20h12.4v-7.8"/>' +
              "</svg></span>",
        iconSize: [30, 30],
        iconAnchor: [15, 36],
      }),
      draggable: true,
      autoPan: true,
      zIndexOffset: 1200,
      title: "Home — drag it to sort from somewhere else",
    }).addTo(map);

    homeMarker.on("dragend", () => {
      const { lat, lng } = homeMarker.getLatLng();
      setHome(lat, lng, "Home");
      setSort("dist");
    });
  } else {
    homeMarker.setLatLng([home.lat, home.lon]);
  }

  if (recenter) {
    map.setView([home.lat, home.lon], Math.max(map.getZoom() || 0, 13), { animate: true });
  }
}

/** The device's own fix. Read-only: it says where you are, and nothing else. */
function syncGpsMarker() {
  if (!mapReady) return;
  if (!state.gps) {
    if (gpsMarker) map.removeLayer(gpsMarker);
    gpsMarker = null;
    return;
  }
  if (!gpsMarker) {
    gpsMarker = L.marker([state.gps.lat, state.gps.lon], {
      icon: L.divIcon({
        className: "pin-wrap",
        html: '<span class="you-pin"></span>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1100,      // under home, over the grade pins
    }).addTo(map);
  } else {
    gpsMarker.setLatLng([state.gps.lat, state.gps.lon]);
  }
}

/** Commit whatever the crosshair is currently over. */
function saveCentreAsHome() {
  if (!mapReady) return;
  const c = map.getCenter();
  setHome(c.lat, c.lng, "Home");
  setSort("dist");
  el.setHome.classList.add("is-done");
  setTimeout(() => {
    el.setHome.classList.remove("is-done");
    syncSearchHere();
  }, 1100);
}

el.setHome.addEventListener("click", saveCentreAsHome);

/* Offer to re-sort from here only once "here" is somewhere else.
 *
 * The control used to sit on the map permanently, along with the crosshair
 * aiming it -- which reads as an instruction on a screen you opened to look at
 * pins. It has something to say when the map has been moved away from wherever
 * the list is currently sorted from, and nothing to say before that. */
const SEARCH_HERE_M = 400;

function syncSearchHere() {
  if (!mapReady) return;
  const c = map.getCenter();
  const far = !state.home ||
    distanceMiles(state.home.lat, state.home.lon, c.lat, c.lng) * 1609.34 > SEARCH_HERE_M;
  el.setHome.hidden = !far;
  el.crosshair.hidden = !far;
  el.setHome.querySelector("span").textContent =
    state.home ? "Search from here" : "Sort from here";
}

async function ensureMap() {
  if (mapReady) return true;
  try {
    L = await loadLeaflet();
  } catch {
    el.mapNote.textContent = "Couldn't load the map — the list still works offline.";
    el.mapNote.hidden = false;
    return false;
  }
  if (mapReady) return true;                       // a concurrent call won the race

  map = L.map(el.map, { zoomControl: true, worldCopyJump: false });
  L.tileLayer(TILES, {
    maxZoom: 19,
    minZoom: 8,
    attribution: TILE_ATTR,
    crossOrigin: true,          // CORS responses, so the SW can cache tiles properly
  }).addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  map.attributionControl.setPrefix("");

  const bounds = datasetBounds();
  if (state.home) map.setView([state.home.lat, state.home.lon], 14);
  else if (bounds) map.fitBounds(bounds, { padding: [24, 24] });
  else map.setView([33.95, -84.4], 10);            // the three counties, roughly

  map.on("moveend", () => { syncPins(); syncSearchHere(); });
  mapReady = true;

  syncHomeMarker();
  syncGpsMarker();
  syncPins();
  syncSearchHere();
  return true;
}

/* ---- panes --------------------------------------------------------------- *
 * On a phone the two panes swap and the floating pill toggles between them.
 * From 980px there is room for both at once, so the pill is hidden and the map
 * is built as soon as there is data to put on it.
 */

const wideEnough = matchMedia("(min-width: 980px)");

function setPane(pane) {
  state.pane = pane;
  document.body.dataset.view = pane;
  el.viewToggle.setAttribute("aria-pressed", pane === "map" ? "true" : "false");
  el.viewToggleLabel.textContent = pane === "map" ? "List" : "Map";
  if (pane === "map") ensureMap();
}

function syncPaneLayout() {
  if (wideEnough.matches && state.places.length) ensureMap();
}

wideEnough.addEventListener("change", syncPaneLayout);

el.viewToggle.addEventListener("click", () =>
  setPane(state.pane === "map" ? "list" : "map")
);

/* The top bar's height is measured rather than assumed: it grows with the
 * safe-area inset and with the chips wrapping, and the map has to start exactly
 * below it or it either overlaps the bar or leaves a strip of background. */
const measureTopbar = () =>
  document.documentElement.style.setProperty(
    "--topbar-h", `${Math.round(el.topbar.getBoundingClientRect().height)}px`
  );

new ResizeObserver(measureTopbar).observe(el.topbar);
measureTopbar();

// Leaflet caches the container size, so it has to be told whenever the pane
// changes shape — showing it, resizing the window, or the top bar growing.
new ResizeObserver(() => {
  if (mapReady && el.paneMap.offsetWidth) map.invalidateSize();
}).observe(el.paneMap);

/* ---- the mini-map in the detail sheet ------------------------------------ */

let sheetMap = null;
let sheetPin = null;
let sheetHalo = null;

async function showSheetMap(p) {
  el.sheetMapLink.href = mapsUrl(p);
  el.sheetMapTag.textContent =
    p.precision === 0 ? "Centre of ZIP " + p.zip + " · Open in Maps" : "Open in Maps";
  el.sheetMap.hidden = false;

  let lib;
  try {
    lib = await loadLeaflet();
  } catch {
    el.sheetMap.hidden = true;                     // the address link still works
    return;
  }
  L = L || lib;
  if (state.open?.id !== p.id) return;             // the sheet moved on meanwhile

  if (!sheetMap) {
    sheetMap = L.map(el.sheetMapCanvas, {
      zoomControl: false,
      dragging: false, touchZoom: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false,
    });
    L.tileLayer(TILES, { maxZoom: 19, attribution: TILE_ATTR, crossOrigin: true })
      .addTo(sheetMap);
    sheetMap.attributionControl.setPrefix("");
  }

  // A ZIP-centroid fallback is not a street address, and a sharp pin would
  // claim more than the data knows. Those get a wider view and a soft circle.
  const approx = p.precision === 0;
  sheetMap.setView([p.lat, p.lon], approx ? 13 : 16);
  sheetMap.invalidateSize();

  if (sheetHalo) sheetMap.removeLayer(sheetHalo);
  if (sheetPin) sheetMap.removeLayer(sheetPin);
  sheetHalo = approx
    ? L.circle([p.lat, p.lon], {
        radius: 900, className: "approx-halo", weight: 1.5,
        fillOpacity: 0.12, dashArray: "4 4",
      }).addTo(sheetMap)
    : null;
  sheetPin = L.marker([p.lat, p.lon], {
    icon: pinIcon(p, { ring: false }),      // the only pin here; a ring says nothing
    interactive: false,
  }).addTo(sheetMap);
}

/* ---------------------------------------------------------------- chart --- */

const CHART_POINTS = 12;

/** Score history: one series over time, so no legend — the heading names it. */
function historyChart(history) {
  // Past ~12 points the dots collide and the line stops being readable. The
  // full record is always listed underneath, so nothing is hidden — but the
  // caption says what the chart is showing rather than quietly truncating.
  const pts = history.slice(0, CHART_POINTS).reverse();   // oldest first
  if (pts.length < 2) return "";

  const W = 320, H = 132;
  const pad = { t: 14, r: 30, b: 20, l: 4 };
  const lo = Math.max(0, Math.min(65, ...pts.map((p) => p.score)) - 6);
  const hi = 100;
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (pts.length - 1);
  const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);

  // Grade bands sit behind the line so a score reads as "which band" at a
  // glance without needing a y-axis. Labelled on the right, never colour-alone.
  const bands = GRADE_BANDS
    .filter((b) => b.min < hi)
    .map((b, i, arr) => {
      const top = i === 0 ? hi : arr[i - 1].min;
      const bottom = Math.max(b.min, lo);
      if (top <= bottom) return "";
      const yTop = y(top), yBot = y(bottom);
      return `<rect class="band" x="${pad.l}" y="${yTop}" width="${W - pad.l - pad.r}"
                height="${yBot - yTop}" fill="${b.color}"/>
              <text class="band-label" x="${W - pad.r + 5}" y="${(yTop + yBot) / 2 + 3}">${b.letter}</text>`;
    })
    .join("");

  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");

  const dots = pts.map((p, i) => `
    <circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="4.5"
            fill="${colorFor(p.score)}"/>
    <circle class="dot-hit" cx="${x(i).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="15"
            data-insp="${p.inspId}"><title>${formatDate(p.date)}: ${p.score}, grade ${gradeFor(p.score)}</title></circle>`
  ).join("");

  const last = pts[pts.length - 1];
  const lastLabel = `<text class="value-label" x="${(x(pts.length - 1) - 6).toFixed(1)}"
       y="${(y(last.score) - 11).toFixed(1)}" text-anchor="end">${last.score}</text>`;

  const ticks = `
    <text class="tick" x="${pad.l}" y="${H - 4}">${pts[0].date.slice(0, 4)}</text>
    <text class="tick" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${last.date.slice(0, 4)}</text>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Inspection scores from ${formatDate(pts[0].date)} to ${formatDate(last.date)}">
    ${bands}
    <line class="baseline" x1="${pad.l}" y1="${y(lo)}" x2="${W - pad.r}" y2="${y(lo)}"/>
    <path class="trend" d="${line}"/>
    ${dots}${lastLabel}${ticks}
  </svg>`;
}

/* ---------------------------------------------------------------- sheet --- */

/* Say so, before the tap rather than after it.
 *
 * The failure worth designing against is arriving somewhere on the strength of
 * a number the app was never sure of. So the warning sits above the Directions
 * button instead of under the map, and the button's own pin picks up the mark
 * -- whatever else is on screen, the thing being tapped carries the caveat.
 *
 * It is also careful about what it claims. Directions search by name and
 * address text, not by our coordinates, so that link is not necessarily wrong;
 * the distance and the pin are. Saying "this address is wrong" would overstate
 * what we know and train people to ignore the notice.
 */
function showApproxNote(p) {
  const approx = p.precision === 0;
  el.dirBtn.classList.toggle("is-approx", approx);
  el.sheetApprox.hidden = !approx;
  if (!approx) return;
  el.sheetApprox.innerHTML =
    `${APPROX_ICON}<span><b>Rough location.</b> This address could not be matched ` +
    `to a map, so the distance and the pin below are the middle of ZIP ` +
    `${escapeHTML(p.zip)} — not the restaurant. Directions search by name, ` +
    `which usually still finds it.</span>`;
}

function openSheet(id) {
  const p = state.places.find((x) => x.id === id);
  if (!p) return;
  state.open = p;

  el.sheetName.textContent = p.name;
  el.sheetAddr.textContent = `${p.street}, ${p.city} ${p.zip} · ${p.county} County`;
  // Tapping the address hands off to whatever maps app the phone prefers.
  // Searching by name *and* address lands on the business rather than a
  // pin in the street, which matters for anything inside a mall or plaza.
  el.sheetAddr.href = mapsUrl(p);
  el.dirBtn.href = mapsUrl(p);
  el.menuBtn.href = lookupUrl(p);
  showApproxNote(p);
  syncFavButton();

  const rows = p.history.map((h, i) => {
    const g = gradeFor(h.score);
    return `<button class="insp-row" type="button" data-insp="${h.inspId}"
              aria-expanded="false" id="insp-${h.inspId}">
        <span class="insp-pill" data-g="${g}">${h.score}</span>
        <span class="insp-date">${formatDate(h.date)}<span class="insp-hint"> · grade ${g}</span></span>
        <span class="insp-hint">${i === 0 ? "Latest" : "Details"}</span>
      </button><div class="detail" data-for="${h.inspId}" hidden></div>`;
  }).join("");

  const chart = historyChart(p.history);
  const capped = p.history.length > CHART_POINTS
    ? ` Showing the last ${CHART_POINTS} of ${p.history.length}.`
    : "";
  el.sheetBody.innerHTML =
    (chart ? `<h3 class="sec-title">Score history</h3>${chart}
              <p class="history-note">Each dot is one inspection. Tap it for that visit's findings.${capped}</p>` : "") +
    `<h3 class="sec-title">Inspections</h3><div class="insp">${rows}</div>` +
    alertsHTML();

  el.sheet.hidden = false;
  document.body.classList.add("sheet-open");
  el.sheetScroll.scrollTop = 0;
  history.pushState({ sheet: id }, "");

  showSheetMap(p);
  syncPins();      // ring the pin behind the sheet, so closing it lands in place

  // The most recent visit is what people came for — open it immediately.
  if (p.history[0]) toggleDetail(p.history[0].inspId, true);
}

function closeSheet({ back = true } = {}) {
  if (el.sheet.hidden) return;
  el.sheet.hidden = true;
  el.sheetMap.hidden = true;
  state.open = null;
  document.body.classList.remove("sheet-open");
  syncPins();
  if (back && history.state?.sheet) history.back();
}

function syncFavButton() {
  const on = state.open && state.favorites.has(state.open.id);
  el.favBtn.setAttribute("aria-pressed", on ? "true" : "false");
  el.favLabel.textContent = on ? "Saved" : "Save";
}

async function toggleDetail(inspId, forceOpen = false) {
  const panel = el.sheetBody.querySelector(`.detail[data-for="${inspId}"]`);
  const button = el.sheetBody.querySelector(`.insp-row[data-insp="${inspId}"]`);
  if (!panel || !button) return;

  const isOpen = !panel.hidden;
  if (isOpen && !forceOpen) {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    return;
  }
  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  if (panel.dataset.loaded) return;

  panel.innerHTML = '<p class="detail-loading">Loading the inspector\'s findings…</p>';
  try {
    const report = await loadReport(state.open, inspId);
    panel.innerHTML = reportHTML(report);
    panel.dataset.loaded = "1";
  } catch {
    panel.innerHTML =
      '<p class="detail-loading">Couldn\'t load this report. It may only be available online.</p>';
  }
}

async function loadReport(place, inspId) {
  const url = `/api/report?id=${place.id}&insp=${inspId}&county=${encodeURIComponent(place.county)}`;
  const res = await fetch(url);              // immutable; cached by the SW forever
  if (!res.ok) throw new Error(`report: ${res.status}`);
  return res.json();
}

function reportHTML(report) {
  const violations = report.violations || [];
  if (!violations.length) {
    return `<p class="clean-flag">No violations recorded on this visit.</p>` + formLink(report);
  }
  const risks = violations.filter((v) => v.risk_factor);
  const banner = risks.length
    ? `<p class="risk-flag">
         <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5v5M12 17h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>
         ${risks.length} foodborne-illness risk factor${risks.length > 1 ? "s" : ""}
       </p>`
    : "";
  const items = violations
    .slice()
    .sort((a, b) => Number(b.risk_factor) - Number(a.risk_factor))
    .map((v) => `<li class="${v.risk_factor ? "is-risk" : ""}">
        <span class="viol-code">${escapeHTML(v.code)}</span>
        <span>${escapeHTML(v.description)}${
          v.occurrences > 1 ? ` <span class="viol-occ">×${v.occurrences}</span>` : ""
        }</span>
      </li>`)
    .join("");
  return `${banner}<ul class="viol">${items}</ul>${formLink(report)}`;
}

const formLink = (r) =>
  r.form_url
    ? `<a class="form-link" href="${escapeHTML(r.form_url)}" target="_blank" rel="noopener">View the official report ↗</a>`
    : "";

/* --------------------------------------------------------------- alerts --- */

function alertsHTML() {
  if (!("PushManager" in window) || !("serviceWorker" in navigator)) return "";
  const saved = state.open && state.favorites.has(state.open.id);
  return `<div class="alerts">
      <h3>Alert me about new inspections</h3>
      <p>${saved
        ? "Get a notification when a new score is posted for a place you've saved."
        : "Save this place first, then turn on alerts for new scores at your saved places."}</p>
      <button id="alerts-btn" class="action" type="button" ${saved ? "" : "disabled"}>Turn on alerts</button>
    </div>`;
}

async function enableAlerts(button) {
  button.disabled = true;
  button.textContent = "Enabling…";
  try {
    if (Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        button.textContent = "Notifications blocked";
        return;
      }
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await (await fetch("/api/vapid")).json();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8(key),
      });
    }
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub, places: [...state.favorites] }),
    });
    button.textContent = "Alerts on";
  } catch {
    button.textContent = "Couldn't turn on alerts";
    button.disabled = false;
  }
}

function base64UrlToUint8(value) {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Keep the server's notion of "my saved places" in step, if alerts are on. */
async function syncSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub, places: [...state.favorites] }),
    });
  } catch {
    /* best effort */
  }
}

/* ---------------------------------------------------------------- wiring -- */

function setSort(sort) {
  state.sort = sort;
  state.shown = PAGE;
  document.querySelectorAll("[data-sort]").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.sort === sort)
  );
  render();
}

function setFilter(filter) {
  state.filter = filter;
  state.shown = PAGE;
  document.querySelectorAll("[data-filter]").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.filter === filter)
  );
  syncFilterDot();
  render();
}

// The starting sort was never marked as chosen. Invisible while the controls
// were a chip row that scrolled off the edge; in a labelled sheet it reads as
// "no sort applied".
document.querySelectorAll("[data-sort]").forEach((b) =>
  b.classList.toggle("is-on", b.dataset.sort === state.sort)
);
syncFilterDot();

document.querySelectorAll("[data-filter]").forEach((b) =>
  b.addEventListener("click", () => setFilter(b.dataset.filter))
);
document.querySelectorAll("[data-sort]").forEach((b) =>
  b.addEventListener("click", () => setSort(b.dataset.sort))
);

document.querySelectorAll("[data-grade]").forEach((b) =>
  b.addEventListener("click", () => toggleGrade(b.dataset.grade))
);

el.filterBtn.addEventListener("click", openFilterSheet);
// One locate behaviour, three places to reach it.
el.mapLocate.addEventListener("click", () => el.locate.click());

el.searchBtn.addEventListener("click", () =>
  el.dockSearch.hidden ? openSearch() : closeSearch()
);
el.searchDone.addEventListener("click", () => {
  el.search.value = "";
  state.query = "";
  state.shown = PAGE;
  syncSearchDot();
  render();
  closeSearch();
});

el.moreBtn.addEventListener("click", openMoreSheet);
el.moreSheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]") || e.target.closest("#more-close")) closeMoreSheet();
});
$("#menu-loc").addEventListener("click", () => { closeMoreSheet(); openLocationSheet(); });
$("#menu-stats").addEventListener("click", () => { closeMoreSheet(); openStatsSheet(); });
$("#menu-share").addEventListener("click", () => { closeMoreSheet(); openShareSheet(); });
el.shareSheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]") || e.target.closest("#share-close")) closeShareSheet();
});
el.shareCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(el.shareLink.textContent);
    el.shareCopyLabel.textContent = "Copied";
    setTimeout(() => { el.shareCopyLabel.textContent = "Copy link"; }, 1600);
  } catch {
    el.shareCopyLabel.textContent = "Press and hold the link to copy";
  }
});
el.shareNative.addEventListener("click", () => {
  navigator.share?.({
    title: state.open ? state.open.name : "Score",
    text: state.open
      ? `${state.open.name} — health inspection scores`
      : "Health inspection scores near here",
    url: el.shareLink.textContent,
  }).catch(() => {});
});
el.statsSheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]") || e.target.closest("#stats-close")) closeStatsSheet();
});
el.filterSheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]") || e.target.closest("#filter-close")) closeFilterSheet();
});

let searchTimer;
el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = el.search.value;
    state.shown = PAGE;
    syncSearchDot();
    render();
  }, 120);
});

el.locate.addEventListener("click", () => {
  // Never tried before: go straight for a real fix, and only fall back to the
  // picker if the device says no. Once a location exists, the button edits it.
  if (!state.home && el.locate.dataset.state !== "denied") {
    requestLocation({
      onFail: (msg) => {
        el.locate.dataset.state = "denied";
        openLocationSheet(msg);
      },
    });
    return;
  }
  openLocationSheet();
});

locEl.gps.addEventListener("click", () => {
  locMsg("Locating…", false);
  requestLocation({
    adopt: true,     // an explicit ask beats a home that was pinned earlier
    onSuccess: () => {
      setSort("dist");
      closeLocationSheet();
    },
    onFail: (msg) => locMsg(msg, true),
  });
});

locEl.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = locEl.input.value.trim();
  if (!query) return;
  locMsg("Looking that up…", false);
  const hit = await resolveLocation(query);
  if (hit.error) {
    locMsg(hit.error, true);
    return;
  }
  setHome(hit.lat, hit.lon, hit.label, { recenter: true });
  setSort("dist");
  closeLocationSheet();
});

locEl.sheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]") || e.target.closest("#loc-close")) closeLocationSheet();
});

el.list.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) openSheet(Number(card.dataset.id));
});

el.sheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]") || e.target.closest("#sheet-close")) {
    closeSheet();
    return;
  }
  const row = e.target.closest(".insp-row");
  if (row) {
    toggleDetail(Number(row.dataset.insp));
    return;
  }
  const dot = e.target.closest(".dot-hit");
  if (dot) {
    const id = Number(dot.dataset.insp);
    toggleDetail(id, true);
    el.sheetBody.querySelector(`#insp-${id}`)?.scrollIntoView({
      behavior: "smooth", block: "center",
    });
    return;
  }
  if (e.target.closest("#alerts-btn")) enableAlerts(e.target.closest("#alerts-btn"));
});

el.favBtn.addEventListener("click", () => {
  if (!state.open) return;
  const id = state.open.id;
  state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
  writeJSON(KEY.favs, [...state.favorites]);
  syncFavButton();
  const alerts = el.sheetBody.querySelector(".alerts");
  if (alerts) alerts.outerHTML = alertsHTML();
  syncSubscription();
  render();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeLocationSheet();
  closeFilterSheet();
  closeMoreSheet();
  closeStatsSheet();
  closeShareSheet();
  closeSheet();
});

// Make the back gesture close the sheet rather than leaving the app.
addEventListener("popstate", () => closeSheet({ back: false }));

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.shown < state.view.length) {
    state.shown += PAGE;
    appendRows();   // the filter and sort haven't changed, so don't recompute
  }
}, { rootMargin: "600px" }).observe(el.sentinel);

/* ------------------------------------------------------------------ go --- */

applyShareState();

document.body.dataset.view = state.pane;
if (state.home) setLocateState("on", state.home.label || "Near you");
// A shared link can carry any of these, and it arrives after the controls were
// first drawn -- so bring all of them back in line with the state, not just the
// ones the local session can change.
document.querySelectorAll("[data-sort]").forEach((b) =>
  b.classList.toggle("is-on", b.dataset.sort === state.sort)
);
document.querySelectorAll("[data-filter]").forEach((b) =>
  b.classList.toggle("is-on", b.dataset.filter === state.filter)
);
syncGradeChips();
syncFilterDot();
syncSearchDot();

loadData().then(() => {
  // Wide screens show both panes at once, so the map is built as soon as there
  // is something to put on it rather than waiting for a toggle that isn't there.
  syncPaneLayout();

  // A stored fix sorts the list instantly; then quietly refresh it.
  requestLocation({ silent: !!state.home });

  // A shared link, or a tapped notification, opens straight onto its place.
  if (state.pendingView === "map") setPane("map");
  if (state.pendingPlace) openSheet(state.pendingPlace);
  state.pendingPlace = state.pendingView = null;
});

// Tapping a notification while the app is already open.
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open-place" && e.data.placeId) openSheet(Number(e.data.placeId));
});

if ("serviceWorker" in navigator) {
  addEventListener("load", async () => {
    const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    // Ask once, explicitly. The browser checks for a new worker on its own
    // schedule, and a host that puts a long browser TTL on the script can
    // stretch that out considerably -- which looks exactly like a deploy that
    // never happened. updateViaCache: "none" keeps this check off the HTTP
    // cache no matter what header the script arrived with.
    reg.update?.().catch(() => {});
  });
}
