/* POST /api/notify — called by the nightly crawler after it finds new scores.
 *
 * Body: { changes: [{ id, name, date, score, grade }] }
 * Auth:  Authorization: Bearer <NOTIFY_SECRET>
 *
 * Queues a row per (subscriber, change) and rings each affected subscriber's
 * doorbell once. The service worker then collects the details from /api/pending.
 */

import { sendPush } from "./_push.js";

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.VAPID_PRIVATE_KEY) return json({ error: "alerts not configured" }, 503);

  const auth = request.headers.get("Authorization") || "";
  if (!env.NOTIFY_SECRET || auth !== `Bearer ${env.NOTIFY_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }

  let changes;
  try {
    ({ changes } = await request.json());
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!Array.isArray(changes) || !changes.length) return json({ ok: true, sent: 0 });

  const byPlace = new Map();
  for (const c of changes) {
    if (Number.isInteger(c?.id)) byPlace.set(c.id, c);
  }
  if (!byPlace.size) return json({ ok: true, sent: 0 });

  const { results: subs } = await env.DB.prepare(
    "SELECT endpoint, places FROM subscriptions"
  ).all();

  const inserts = [];
  const targets = [];
  for (const sub of subs || []) {
    let watched;
    try {
      watched = JSON.parse(sub.places);
    } catch {
      continue;
    }
    const hits = watched.map((id) => byPlace.get(id)).filter(Boolean);
    if (!hits.length) continue;
    targets.push(sub.endpoint);
    for (const h of hits) {
      inserts.push(
        env.DB.prepare(
          `INSERT INTO pending (endpoint, place_id, name, inspection_date, score, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(sub.endpoint, h.id, String(h.name || ""), String(h.date || ""),
               Number(h.score) || 0, Date.now())
      );
    }
  }

  if (!targets.length) return json({ ok: true, sent: 0 });
  await env.DB.batch(inserts);

  let sent = 0;
  const dead = [];
  for (const endpoint of targets) {
    const outcome = await sendPush(endpoint, env);
    if (outcome === "ok") sent++;
    else if (outcome === "gone") dead.push(endpoint);
  }

  // Reap subscriptions the browser has discarded, so the table stays small.
  if (dead.length) {
    const marks = dead.map(() => "?").join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM subscriptions WHERE endpoint IN (${marks})`).bind(...dead),
      env.DB.prepare(`DELETE FROM pending WHERE endpoint IN (${marks})`).bind(...dead),
    ]);
  }

  return json({ ok: true, sent, pruned: dead.length });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
