import { dirname } from "node:path";
import {
  openSeriesDbWritable,
  seriesDbRelativePath,
  prepareSeriesChapterStatements,
  updateSeriesSummaryFromChaptersDb,
} from "./series-db.js";

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * Chuyển catalog_chapters + catalog_chapter_images trong catalog.sqlite
 * sang catalog/db/series/{id}.sqlite rồi xóa bảng cũ (chỉ chạy khi bảng cũ còn tồn tại).
 */
export function migrateLegacyEmbeddedChaptersIfPresent(mainDb) {
  if (!tableExists(mainDb, "catalog_chapters")) {
    return false;
  }

  const catalogDir = dirname(mainDb.name);
  const seriesIds = mainDb.prepare("SELECT DISTINCT series_id FROM catalog_chapters").all();

  for (const { series_id: sid } of seriesIds) {
    const chapters = mainDb
      .prepare(
        `SELECT id, chapter_num, title, chapter_url, final_url, image_count, fetch_ok, error_message,
                chapters_list_fetched_at, images_fetched_at
         FROM catalog_chapters WHERE series_id = ? ORDER BY chapter_num ASC`
      )
      .all(sid);

    const seriesDb = openSeriesDbWritable(catalogDir, sid);
    const { saveChapterWithImages, saveChapterStub } = prepareSeriesChapterStatements(seriesDb);

    for (const ch of chapters) {
      const imgs = mainDb
        .prepare(`SELECT sort_order, url FROM catalog_chapter_images WHERE chapter_id = ? ORDER BY sort_order ASC`)
        .all(ch.id);
      const row = {
        chapter_num: ch.chapter_num,
        title: ch.title,
        chapter_url: ch.chapter_url,
        final_url: ch.final_url,
        image_count: ch.image_count,
        fetch_ok: ch.fetch_ok,
        error_message: ch.error_message,
        chapters_list_fetched_at: ch.chapters_list_fetched_at,
        images_fetched_at: ch.images_fetched_at,
      };
      if (imgs.length > 0) {
        saveChapterWithImages(
          row,
          imgs.map((x) => x.url)
        );
      } else {
        saveChapterStub(row);
      }
    }

    updateSeriesSummaryFromChaptersDb(mainDb, sid, seriesDb);
    mainDb
      .prepare(`UPDATE catalog_series SET series_db_file = ? WHERE id = ?`)
      .run(seriesDbRelativePath(sid), sid);

    seriesDb.close();
  }

  mainDb.exec("DROP TABLE IF EXISTS catalog_chapter_images");
  mainDb.exec("DROP TABLE IF EXISTS catalog_chapters");
  return true;
}
