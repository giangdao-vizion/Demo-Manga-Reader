import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Đường dẫn tương đối (so với thư mục chứa catalog.sqlite). */
export function seriesDbRelativePath(seriesId) {
  return `series/${seriesId}.sqlite`;
}

export function catalogDirFromMainDbPath(catalogDbPath) {
  return dirname(resolve(process.cwd(), catalogDbPath));
}

export function resolveSeriesDbPath(catalogDir, seriesId, seriesDbFile) {
  const rel = seriesDbFile && String(seriesDbFile).trim() ? seriesDbFile : seriesDbRelativePath(seriesId);
  return join(catalogDir, rel);
}

/**
 * @param {string} catalogDir - thư mục cha của catalog.sqlite
 * @param {number} seriesId
 */
export function openSeriesDbAbsWritable(absPath) {
  mkdirSync(dirname(absPath), { recursive: true });
  const db = new Database(absPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrateSeriesDbSchema(db);
  return db;
}

export function openSeriesDbWritable(catalogDir, seriesId) {
  const abs = join(catalogDir, "series", `${seriesId}.sqlite`);
  return openSeriesDbAbsWritable(abs);
}

export function openSeriesDbReadonly(absPath) {
  if (!absPath) return null;
  const db = new Database(absPath, { readonly: true, fileMustExist: true });
  db.pragma("foreign_keys = ON");
  return db;
}

function migrateSeriesDbSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_num INTEGER NOT NULL,
      title TEXT,
      chapter_url TEXT NOT NULL,
      final_url TEXT,
      image_count INTEGER NOT NULL DEFAULT 0,
      fetch_ok INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      chapters_list_fetched_at TEXT,
      images_fetched_at TEXT,
      UNIQUE(chapter_num)
    );
    CREATE INDEX IF NOT EXISTS idx_chapters_num ON chapters(chapter_num);

    CREATE TABLE IF NOT EXISTS chapter_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      url TEXT NOT NULL,
      UNIQUE(chapter_id, sort_order),
      FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_images_ch ON chapter_images(chapter_id);
  `);
}

/**
 * @param {import("better-sqlite3").Database} db - series db
 */
export function prepareSeriesChapterStatements(db) {
  const upsertChapter = db.prepare(`
    INSERT INTO chapters (
      chapter_num, title, chapter_url, final_url, image_count, fetch_ok,
      error_message, chapters_list_fetched_at, images_fetched_at
    ) VALUES (
      @chapter_num, @title, @chapter_url, @final_url, @image_count, @fetch_ok,
      @error_message, @chapters_list_fetched_at, @images_fetched_at
    )
    ON CONFLICT(chapter_num) DO UPDATE SET
      title = excluded.title,
      chapter_url = excluded.chapter_url,
      final_url = excluded.final_url,
      image_count = excluded.image_count,
      fetch_ok = excluded.fetch_ok,
      error_message = excluded.error_message,
      chapters_list_fetched_at = COALESCE(
        chapters.chapters_list_fetched_at,
        excluded.chapters_list_fetched_at
      ),
      images_fetched_at = COALESCE(excluded.images_fetched_at, chapters.images_fetched_at)
    RETURNING id
  `);

  const delImages = db.prepare(`DELETE FROM chapter_images WHERE chapter_id = ?`);
  const insImage = db.prepare(
    `INSERT INTO chapter_images (chapter_id, sort_order, url) VALUES (?, ?, ?)`
  );

  const saveChapterWithImages = db.transaction((row, imageUrls) => {
    const r = upsertChapter.get(row);
    const chapterId = r.id;
    delImages.run(chapterId);
    for (let i = 0; i < imageUrls.length; i++) {
      insImage.run(chapterId, i, imageUrls[i]);
    }
    return chapterId;
  });

  const saveChapterStub = db.transaction((row) => {
    upsertChapter.run(row);
  });

  return { saveChapterWithImages, saveChapterStub };
}

export function updateSeriesSummaryFromChaptersDb(mainDb, seriesId, seriesDb) {
  const row = seriesDb
    .prepare("SELECT COUNT(*) AS c, MAX(chapter_num) AS mx FROM chapters")
    .get();
  const cnt = row.c ?? 0;
  const mx = row.mx != null ? row.mx : null;
  mainDb
    .prepare(
      `UPDATE catalog_series SET chapters_stored_count = ?, latest_chapter_num = ? WHERE id = ?`
    )
    .run(cnt, mx, seriesId);
}
