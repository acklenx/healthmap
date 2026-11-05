/* Shared by /api/place, which writes what it finds, and /api/found, which
 * hands it out. Both are no-ops without the D1 binding: the app works without
 * it, each device just keeps its own findings, as it always has. */

// The nightly crawl normally catches up the next morning; a month covers a
// long outage of it without the table growing past a few thousand rows.
export const FOUND_KEEP_DAYS = 30;
// Only recent inspections are news. /api/place may be asked about a window
// years wide, and the older rows in it are already in the published data.
const NEWS_DAYS = 45;

/** Record the inspections one place check turned up. Never throws. */
export async function recordFound(db, placeId, inspections, now = Date.now()) {
  if (!db || !inspections?.length) return 0;
  const floor = new Date(now - NEWS_DAYS * 86400000).toISOString().slice(0, 10);
  const fresh = inspections.filter((h) =>
    Number.isInteger(h.inspId) && Number.isInteger(h.score) &&
    /^\d{4}-\d{2}-\d{2}$/.test(h.date) && h.date >= floor);
  if (!fresh.length) return 0;
  try {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO found (insp_id, place_id, date, score, found_at)
       VALUES (?, ?, ?, ?, ?)`);
    await db.batch([
      ...fresh.map((h) => insert.bind(h.inspId, placeId, h.date, h.score, now)),
      db.prepare("DELETE FROM found WHERE found_at < ?")
        .bind(now - FOUND_KEEP_DAYS * 86400000),
    ]);
    return fresh.length;
  } catch {
    return 0;                        // a table not created yet, say
  }
}

/** Everything still worth knowing, as [placeId, date, score, inspId] rows. */
export async function listFound(db, now = Date.now()) {
  if (!db) return [];
  try {
    const { results } = await db.prepare(
      `SELECT place_id, date, score, insp_id FROM found
        WHERE found_at >= ? ORDER BY place_id, date`
    ).bind(now - FOUND_KEEP_DAYS * 86400000).all();
    return (results || []).map((r) => [r.place_id, r.date, r.score, r.insp_id]);
  } catch {
    return [];
  }
}
