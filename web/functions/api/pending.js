/* POST /api/pending — the service worker asks "what changed for me?"
 *
 * Because pushes are sent without a payload, this is how a notification gets
 * its text. Delivered rows are deleted, so each alert is shown once.
 *
 * Body: { endpoint: <this install's push endpoint> }
 */

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ items: [] });

  let endpoint;
  try {
    ({ endpoint } = await request.json());
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) {
    return json({ error: "invalid endpoint" }, 400);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, place_id, name, inspection_date, score
       FROM pending WHERE endpoint = ? ORDER BY id LIMIT 20`
  ).bind(endpoint).all();

  if (results?.length) {
    await env.DB.prepare(
      `DELETE FROM pending WHERE id IN (${results.map(() => "?").join(",")})`
    ).bind(...results.map((r) => r.id)).run();
  }

  return json({
    items: (results || []).map((r) => ({
      placeId: r.place_id,
      name: r.name,
      date: r.inspection_date,
      score: r.score,
    })),
  });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
