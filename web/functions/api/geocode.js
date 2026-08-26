/* GET /api/geocode?q=<address>
 *
 * Only used when someone types a street address. ZIP codes and city names are
 * resolved on the device from the dataset it already has, so this is the rare
 * path -- which is why it is a thin proxy rather than anything cleverer.
 *
 * Uses the US Census geocoder: free, no API key, and the same service the
 * crawler uses for establishment addresses, so results stay consistent.
 */

const CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const DAY = 86400;

export async function onRequestGet({ request }) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (!q || q.length > 200) return json({ error: "bad request" }, 400, "no-store");

  // Georgia-only app; nudge bare addresses into the right state.
  const address = /\b(GA|GEORGIA)\b/i.test(q) ? q : `${q}, GA`;
  const url = `${CENSUS}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;

  let data;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "restaurant-scores/1.0" },
      cf: { cacheTtl: DAY, cacheEverything: true },
    });
    if (!res.ok) return json({ error: "geocoder unavailable" }, 502, "no-store");
    data = await res.json();
  } catch {
    return json({ error: "geocoder unreachable" }, 502, "no-store");
  }

  const match = data?.result?.addressMatches?.[0];
  if (!match) return json({ lat: null, lon: null }, 200, `public, max-age=${DAY}`);

  return json(
    {
      lat: match.coordinates.y,
      lon: match.coordinates.x,
      label: shortLabel(match.matchedAddress) || q,
    },
    200,
    `public, max-age=${DAY}`
  );
}

/** "3460 SANDY PLAINS RD, MARIETTA, GA, 30066" -> "Marietta" */
function shortLabel(matched) {
  const parts = String(matched || "").split(",").map((s) => s.trim());
  if (parts.length < 2) return "";
  const city = parts[1].toLowerCase();
  return city.replace(/(^|[^a-z'])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

const json = (body, status, cacheControl) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cacheControl },
  });
