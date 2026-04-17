import { canonicalKeyFromTitle } from "./title-canonical.js";

/** Điền canonical_key còn thiếu từ title. */
export function backfillCanonicalKeys(db) {
  const rows = db
    .prepare(
      `SELECT id, title FROM catalog_series
       WHERE canonical_key IS NULL OR TRIM(COALESCE(canonical_key, '')) = ''`
    )
    .all();
  const upd = db.prepare(`UPDATE catalog_series SET canonical_key = ? WHERE id = ?`);
  for (const r of rows) {
    const k = canonicalKeyFromTitle(r.title);
    if (k) upd.run(k, r.id);
  }
}

/**
 * Cùng canonical_key: ưu tiên nguồn có chapter_count lớn hơn (đồng bộ ảnh lấy URL từ bộ đó).
 * preferred_fetch_catalog_id = id bộ “thắng”; NULL nếu chỉ có một bộ hoặc chưa gom được.
 */
export function recomputePreferredFetchCatalog(db) {
  backfillCanonicalKeys(db);
  db.prepare(`UPDATE catalog_series SET preferred_fetch_catalog_id = NULL`).run();
  const rows = db
    .prepare(
      `SELECT id, canonical_key, COALESCE(chapter_count, 0) AS ch
       FROM catalog_series
       WHERE canonical_key IS NOT NULL AND TRIM(canonical_key) != ''`
    )
    .all();
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.canonical_key)) byKey.set(r.canonical_key, []);
    byKey.get(r.canonical_key).push(r);
  }
  const upd = db.prepare(
    `UPDATE catalog_series SET preferred_fetch_catalog_id = ? WHERE id = ?`
  );
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const winner = list.reduce((a, b) => (a.ch >= b.ch ? a : b));
    const winId = winner.id;
    for (const r of list) {
      upd.run(winId, r.id);
    }
  }
}
