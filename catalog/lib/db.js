import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { migrateLegacyEmbeddedChaptersIfPresent } from "./migrate-legacy-embedded-chapters.js";
import { canonicalKeyFromTitle } from "./title-canonical.js";

/**
 * @param {string} dbPath - absolute or relative to process.cwd()
 */
export function openCatalogDb(dbPath) {
  const abs = resolve(process.cwd(), dbPath);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function columnExists(db, table, name) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === name);
}

function ensureColumn(db, table, name, ddl) {
  if (columnExists(db, table, name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      series_path TEXT NOT NULL,
      list_url TEXT NOT NULL,
      list_params_json TEXT,
      title TEXT NOT NULL,
      series_url TEXT NOT NULL,
      cover_url TEXT,
      chapter_count INTEGER,
      status TEXT,
      rating REAL,
      extra_json TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(source_id, series_path)
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_series_source ON catalog_series(source_id);
    CREATE INDEX IF NOT EXISTS idx_catalog_series_list ON catalog_series(list_url);

    CREATE TABLE IF NOT EXISTS catalog_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      list_url TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      pages_fetched INTEGER,
      rows_upserted INTEGER
    );

    CREATE TABLE IF NOT EXISTS catalog_content_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      series_processed INTEGER,
      chapters_discovered INTEGER,
      chapters_imaged INTEGER
    );
  `);

  ensureColumn(db, "catalog_series", "content_sync_complete", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "catalog_series", "content_sync_completed_at", "TEXT");
  ensureColumn(db, "catalog_series", "content_sync_note", "TEXT");
  ensureColumn(db, "catalog_series", "series_db_file", "TEXT");
  ensureColumn(db, "catalog_series", "latest_chapter_num", "INTEGER");
  ensureColumn(db, "catalog_series", "chapters_stored_count", "INTEGER");
  ensureColumn(db, "catalog_series", "canonical_key", "TEXT");
  ensureColumn(db, "catalog_series", "preferred_fetch_catalog_id", "INTEGER");

  if (tableExists(db, "catalog_chapters")) {
    migrateLegacyEmbeddedChaptersIfPresent(db);
  }
}

/**
 * Gán đường dẫn file DB per-series cho mọi dòng đang thiếu.
 */
export function backfillSeriesDbFiles(db) {
  db.prepare(
    `UPDATE catalog_series SET series_db_file = 'series/' || id || '.sqlite'
     WHERE series_db_file IS NULL OR TRIM(COALESCE(series_db_file, '')) = ''`
  ).run();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function makeUpsertSeries(db) {
  const stmt = db.prepare(`
    INSERT INTO catalog_series (
      source_id, series_path, list_url, list_params_json, title, series_url,
      cover_url, chapter_count, status, rating, extra_json, updated_at, canonical_key
    ) VALUES (
      @source_id, @series_path, @list_url, @list_params_json, @title, @series_url,
      @cover_url, @chapter_count, @status, @rating, @extra_json, @updated_at, @canonical_key
    )
    ON CONFLICT(source_id, series_path) DO UPDATE SET
      list_url = excluded.list_url,
      list_params_json = excluded.list_params_json,
      title = excluded.title,
      series_url = excluded.series_url,
      cover_url = excluded.cover_url,
      chapter_count = excluded.chapter_count,
      status = excluded.status,
      rating = excluded.rating,
      extra_json = excluded.extra_json,
      updated_at = excluded.updated_at,
      canonical_key = COALESCE(NULLIF(TRIM(excluded.canonical_key), ''), catalog_series.canonical_key)
  `);
  return (row) => {
    const canonical_key =
      row.canonical_key && String(row.canonical_key).trim()
        ? String(row.canonical_key).trim()
        : canonicalKeyFromTitle(row.title);
    return stmt.run({ ...row, canonical_key });
  };
}
