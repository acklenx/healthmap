/* GET /api/vapid — the public key the browser needs in order to subscribe. */
export function onRequestGet({ env }) {
  if (!env.VAPID_PUBLIC_KEY) {
    return new Response(JSON.stringify({ error: "alerts not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ key: env.VAPID_PUBLIC_KEY }), {
    headers: {
      "Content-Type": "application/json",
      // The key is a build-time constant; let clients hold it for a day.
      "Cache-Control": "public, max-age=86400",
    },
  });
}
