/* Generate a VAPID key pair for web push.
 *
 *   node scripts/gen_vapid.mjs
 *
 * The public key goes in the app's config (the browser needs it to subscribe);
 * the private key is a Cloudflare secret and must never reach the client.
 */

import { generateKeyPairSync } from "node:crypto";

const b64url = (buf) => buf.toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

// The browser wants the raw uncompressed point (0x04 || X || Y), which is the
// trailing 65 bytes of the SPKI encoding for P-256.
const spki = publicKey.export({ type: "spki", format: "der" });
const raw = spki.subarray(spki.length - 65);

console.log("VAPID_PUBLIC_KEY  =", b64url(raw));
console.log("VAPID_PRIVATE_KEY =", b64url(privateKey.export({ type: "pkcs8", format: "der" })));
console.log(`
Set them on the Pages project:
  npx wrangler pages secret put VAPID_PRIVATE_KEY
  npx wrangler pages secret put VAPID_PUBLIC_KEY
  npx wrangler pages secret put NOTIFY_SECRET      # any long random string
`);
