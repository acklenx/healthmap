/* POST /api/subscribe — register (or update) which saved places to alert on.
 *
 * Body: { subscription: <PushSubscription JSON>, places: [<establishment id>] }
 *
 * Keyed by the push endpoint, which is the browser's own opaque identifier for
 * this install. No account, no email, nothing that identifies a person.
 */

const MAX_PLACES = 500;

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "alerts not configured" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const sub = body?.subscription;
  const endpoint = sub?.endpoint;
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 1024) {
    return json({ error: "invalid subscription" }, 400);
  }

  const places = Array.isArray(body.places)
    ? [...new Set(body.places.filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_PLACES)
    : [];

  if (!places.length) {
    // Unsubscribing is just saving an empty list; drop the row entirely.
    await env.DB.prepare("DELETE FROM subscriptions WHERE endpoint = ?").bind(endpoint).run();
    return json({ ok: true, places: 0 });
  }

  await env.DB.prepare(
    `INSERT INTO subscriptions (endpoint, places, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(endpoint) DO UPDATE SET places = ?2, updated_at = ?3`
  ).bind(endpoint, JSON.stringify(places), Date.now()).run();

  return json({ ok: true, places: places.length });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
