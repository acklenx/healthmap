/* Service worker — the aggressive-caching half of the app.
 *
 * Four cache policies, chosen by how mutable the thing actually is:
 *
 *   shell     App code, Leaflet included. Versioned by SHELL_VERSION; replaced
 *             on activate.
 *   data      places.json?v=<stamp>. The stamp changes only when the crawler
 *             publishes, so a cached copy is correct forever. Old stamps are
 *             evicted on activate.
 *   reports   /api/report responses. A completed inspection is a historical
 *             fact -- it never changes -- so these are kept indefinitely.
 *   tiles     OpenStreetMap raster tiles. Also effectively immutable, but this
 *             one is bounded: panning can pull in tiles forever.
 *
 * /version.json is deliberately never cached: it is the freshness probe, a
 * few bytes, and caching it would defeat the entire scheme.
 */

const SHELL_VERSION = "v6";
const SHELL = `shell-${SHELL_VERSION}`;
const DATA = "data-v1";
const REPORTS = "reports-v1";
const TILES = "tiles-v1";

const TILE_HOST = "tile.openstreetmap.org";
const TILE_LIMIT = 900;      // roughly a couple of towns' worth, at a few kB each

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  // Loaded on demand when something is shared, precached for the same reason
  // Leaflet is: the moment you want it is not a good moment to need the network.
  "/qr.js",
  "/manifest.webmanifest",
  // Leaflet is precached rather than lazily cached: it is only ever fetched
  // when a map is first opened, and that is exactly the moment you are least
  // likely to have signal to spare.
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/leaflet.css",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // `cache: "reload"` rather than cache.addAll(), which would fetch through
    // the HTTP cache. A hit there installs the *previous* release's files into
    // the new shell -- the version number changes, the assets do not, and the
    // bug looks exactly like the deploy never happened.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (response.ok) await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const stale = names.filter((n) => n.startsWith("shell-") && n !== SHELL);
    await Promise.all(stale.map((n) => caches.delete(n)));
    await self.clients.claim();

    // Refresh whatever is already on screen, once, after a version change.
    //
    // A navigation is network-first but the shell is cache-first, so the load
    // that triggers this upgrade got the *new* index.html wired to the
    // *previous* version's app.js and styles.css -- markup referring to rules
    // and functions that aren't there yet. It looks like a broken page, and it
    // stays broken until something reloads it.
    //
    // `stale` is only non-empty when this activation actually replaced an
    // older shell, which happens once per release, so this cannot loop.
    if (!stale.length) return;
    for (const client of await self.clients.matchAll({ type: "window" })) {
      client.navigate(client.url).catch(() => {
        /* the tab moved on, or navigation was blocked -- nothing to refresh */
      });
    }
  })());
});

/** Cache-first with no revalidation — for genuinely immutable URLs. */
async function immutable(request, cacheName, { prune } = {}) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) {
    if (prune) {
      // Only one version of the dataset is ever useful; drop the rest.
      for (const key of await cache.keys()) {
        if (key.url !== request.url) await cache.delete(key);
      }
    }
    cache.put(request, response.clone());
  }
  return response;
}

/* Map tiles. Cache-first and never revalidated: a tile is a picture of a
 * place, and the places in three Georgia counties do not move. A slightly
 * dated basemap beats a grey square with no signal.
 *
 * Unlike the dataset this grows without bound as you pan, so it is capped.
 * cache.keys() comes back in insertion order, which makes the front of the
 * list the oldest tiles -- good enough eviction for something this cheap to
 * refetch. Trimming every put would mean walking 900 keys per tile, so it
 * runs on a counter instead. */
let tilesSinceTrim = 0;

async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    if (++tilesSinceTrim >= 50) {
      tilesSinceTrim = 0;
      const keys = await cache.keys();
      const excess = keys.length - TILE_LIMIT;
      if (excess > 0) await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)));
    }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.hostname === TILE_HOST) {
    event.respondWith(tile(request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (url.pathname === "/version.json") return;  // always live

  if (url.pathname === "/places.json") {
    event.respondWith(immutable(request, DATA, { prune: true }));
    return;
  }

  if (url.pathname === "/api/report") {
    event.respondWith(immutable(request, REPORTS));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/index.html", { ignoreSearch: true }))
    );
    return;
  }

  // App shell: serve from cache, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(request, { ignoreSearch: true });
    const network = fetch(request)
      .then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      })
      .catch(() => hit);
    return hit || network;
  })());
});

/* ------------------------------------------------------------- alerts --- */

self.addEventListener("push", (event) => {
  // Pushes are sent without a payload, so the details are collected here. That
  // also means an alert queued while the device was offline still arrives with
  // the right text rather than as an empty buzz.
  event.waitUntil((async () => {
    let items = [];
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const res = await fetch("/api/pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        if (res.ok) items = (await res.json()).items || [];
      }
    } catch {
      /* fall through to the generic notification below */
    }

    // The Push API requires a visible notification for every message received.
    if (!items.length) {
      await self.registration.showNotification("New inspection posted", {
        body: "Open Score to see the latest results.",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: "inspection",
      });
      return;
    }

    if (items.length > 2) {
      await self.registration.showNotification(
        `${items.length} new inspection scores`,
        {
          body: items.map((i) => titleish(i.name)).join(", "),
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          tag: "inspection-batch",
        }
      );
      return;
    }

    await Promise.all(items.map((i) => {
      const grade = i.score >= 90 ? "A" : i.score >= 80 ? "B" : i.score >= 70 ? "C" : "U";
      return self.registration.showNotification(titleish(i.name), {
        body: `Scored ${i.score} (grade ${grade}) on ${i.date}`,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: `insp-${i.placeId}`,
        data: { placeId: i.placeId },
      });
    }));
  })());
});

function titleish(name) {
  // The apostrophe guard keeps "DADDY'S" from becoming "Daddy'S".
  return String(name || "")
    .toLowerCase()
    .replace(/(^|[^a-z'])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data?.placeId;
  const target = id ? `/?place=${id}` : "/";
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) {
        await client.focus();
        client.postMessage({ type: "open-place", placeId: id });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
