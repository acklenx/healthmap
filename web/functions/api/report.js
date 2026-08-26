/* GET /api/report?id=<establishment>&insp=<inspection>&county=<name>
 *
 * Fetches one inspection's detail page from the Georgia DPH site and returns
 * the itemized violations as JSON. Proxying rather than crawling every report
 * up front keeps the nightly job small: there are ~50k inspections on record
 * and almost none of them will ever be looked at.
 *
 * A completed inspection is a historical fact, so the response is immutable:
 * it is cached at the edge for a year and, by the service worker, forever.
 */

const UPSTREAM = "https://ga.healthinspections.us/georgia/";
const COUNTIES = new Set(["Cobb", "Cherokee", "Fulton"]);
const YEAR = 31536000;

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const insp = url.searchParams.get("insp");
  const county = url.searchParams.get("county");

  // Validate strictly: these values are interpolated into an upstream URL.
  if (!/^\d{1,12}$/.test(id || "") || !/^\d{1,12}$/.test(insp || "") || !COUNTIES.has(county)) {
    return json({ error: "bad request" }, 400, "no-store");
  }

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/report?id=${id}&insp=${insp}&county=${county}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const target = `${UPSTREAM}history.cfm?id=${id}&inspID=${insp}&county=${encodeURIComponent(county)}`;
  let html;
  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "restaurant-scores/1.0", Accept: "text/html" },
      cf: { cacheTtl: YEAR, cacheEverything: true },
    });
    if (!upstream.ok) return json({ error: "upstream error" }, 502, "no-store");
    html = await upstream.text();
  } catch {
    return json({ error: "upstream unreachable" }, 502, "no-store");
  }

  const report = parseReport(html);
  const response = json({ id: Number(id), insp: Number(insp), county, ...report }, 200,
                        `public, max-age=${YEAR}, immutable`);
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl },
  });
}

/* ---- parser (mirrors crawler/source.py: parse_report) -------------------- */

const CODE_RE = /^\d{1,2}(?:-\d{1,2})?[A-Z]{0,2}$/;
const RED_RE = /color\s*:\s*red|color\s*=\s*["']?red|<font[^>]*red/i;

function clean(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function parseReport(page) {
  // The site appends its reusable search form below the report; cut it off so
  // the form's markup can't be mistaken for violation rows.
  const cut = page.indexOf("Establishment Search");
  const body = (cut > 0 ? page.slice(0, cut) : page)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");

  const violations = [];
  for (const [row] of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length !== 3) continue;
    const code = clean(cells[0]);
    const occ = clean(cells[2]);
    if (!CODE_RE.test(code) || !/^\d+$/.test(occ)) continue;   // skips the header row
    violations.push({
      code,
      description: clean(cells[1]),
      occurrences: Number(occ),
      // The page marks foodborne-illness risk factors only by colouring them red.
      risk_factor: RED_RE.test(row),
    });
  }

  const grab = (re) => (body.match(re)?.[1] || "").trim();
  const form = body.match(/href="([^"]*_report_full\.cfm[^"]*)"/i);
  return {
    name: clean(grab(/<h3>([\s\S]*?)<\/h3>/i)),
    date: grab(/Date:\s*([\d/]{8,10})/i),
    grade: grab(/Grade:\s*([A-U])\b/i),
    violations,
    form_url: form ? new URL(decodeEntities(form[1]), UPSTREAM).toString() : null,
  };
}
