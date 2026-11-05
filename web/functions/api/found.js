/* GET /api/found
 *
 * Inspections somebody's visit found on the state's site that the nightly
 * data does not have yet -- see /api/place and _found.js. The app fetches this
 * once per launch and folds the rows in exactly as it folds in its own
 * checks, so the badge on the list is right for everyone, not only for
 * whoever happened to open that restaurant.
 *
 * Cached at the edge for a few minutes: it is the same answer for every
 * visitor, and a new finding being five minutes late costs nothing.
 */

import { listFound } from "./_found.js";

const TTL = 300;

export async function onRequestGet({ request, env, waitUntil }) {
  const cache = caches.default;
  const key = new Request(new URL("/api/found", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const rows = await listFound(env?.DB);
  const response = new Response(JSON.stringify({ rows }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${TTL}`,
    },
  });
  waitUntil(cache.put(key, response.clone()));
  return response;
}
