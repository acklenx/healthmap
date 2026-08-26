/* Web Push helpers.
 *
 * We send *payload-less* pushes: the notification carries no encrypted body,
 * and the service worker fetches what changed from /api/pending. That skips
 * the RFC 8291 payload-encryption dance (ECDH + HKDF per message) entirely
 * while still delivering real notifications, and it means a queued alert
 * survives a push that arrives while the device is offline.
 *
 * VAPID (RFC 8292) is still required: an ES256 JWT identifying this app to
 * the push service. That part is short enough to do with WebCrypto directly.
 */

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const b64urlDecode = (value) => {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

/** Import the VAPID private key. Stored as a base64url PKCS#8 blob in env. */
async function importPrivateKey(pkcs8Base64Url) {
  return crypto.subtle.importKey(
    "pkcs8",
    b64urlDecode(pkcs8Base64Url),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

async function vapidToken(audience, env) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  })));
  const unsigned = `${header}.${claims}`;
  const key = await importPrivateKey(env.VAPID_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${b64url(signature)}`;
}

/**
 * Ring one subscription's doorbell.
 * Returns "ok", "gone" (subscription is dead — delete it), or "error".
 */
export async function sendPush(endpoint, env, { ttl = 86400 } = {}) {
  let audience;
  try {
    audience = new URL(endpoint).origin;
  } catch {
    return "gone";
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${await vapidToken(audience, env)}, k=${env.VAPID_PUBLIC_KEY}`,
        TTL: String(ttl),
        "Content-Length": "0",
        Urgency: "normal",
      },
    });
  } catch {
    return "error";
  }

  // 404/410 mean the browser threw the subscription away.
  if (res.status === 404 || res.status === 410) return "gone";
  return res.ok ? "ok" : "error";
}
