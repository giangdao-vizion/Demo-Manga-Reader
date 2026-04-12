#!/usr/bin/env node
/**
 * Trang quản lý catalog (đọc SQLite). Chỉ bind localhost.
 *
 * File DB mặc định luôn là catalog/db/catalog.sqlite trong repo (cạnh thư mục catalog/),
 * không phụ thuộc thư mục làm việc khi chạy node. Ghi đè bằng CATALOG_DB (tuyệt đối hoặc
 * tương đối gốc repo).
 *
 *   PORT=4567 node catalog/view-server.js
 *   CATALOG_DB=/path/to/catalog.sqlite node catalog/view-server.js
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openSeriesDbReadonly } from "./lib/series-db.js";
import { runCatalogContentSync } from "./lib/sync-catalog-content-core.js";

/** Thư mục .../catalog (chứa view-server.js). */
const __dirname = dirname(fileURLToPath(import.meta.url));
/** Gốc repo (cha của thư mục catalog). */
const REPO_ROOT = dirname(__dirname);
/** catalog.sqlite mặc định, cố định trong source. */
const DEFAULT_CATALOG_DB = join(__dirname, "db", "catalog.sqlite");

function resolveFromRepo(relativeOrAbsolute) {
  const p = String(relativeOrAbsolute).trim();
  if (!p) return DEFAULT_CATALOG_DB;
  return isAbsolute(p) ? resolve(p) : resolve(REPO_ROOT, p);
}

function resolveCatalogDbPath() {
  const env = process.env.CATALOG_DB;
  if (!env || !String(env).trim()) return DEFAULT_CATALOG_DB;
  return resolveFromRepo(env);
}

const PORT = Number(process.env.PORT || 4567);
const HOST = process.env.CATALOG_HOST || "127.0.0.1";
const DB_PATH = resolveCatalogDbPath();
const CATALOG_DIR = dirname(DB_PATH);
const INDEX_HTML = join(__dirname, "view", "index.html");
const READER_SQLITE_HTML = join(REPO_ROOT, "reader-sqlite.html");
const READER_SQLITE_JS = join(REPO_ROOT, "reader-sqlite.js");
const READER_SQLITE_LOCAL_HTML = join(REPO_ROOT, "reader-sqlite-local.html");
const READER_SQLITE_LOCAL_JS = join(REPO_ROOT, "reader-sqlite-local.js");
const CONTENT_CONFIG_PATH = resolveFromRepo(
  process.env.CATALOG_CONTENT_CONFIG || "catalog/configs/asura-content.json"
);
const ALLOW_ADMIN_CONTENT_SYNC = process.env.CATALOG_ALLOW_CONTENT_SYNC !== "0";

/** @type {Set<import('node:http').ServerResponse>} */
const contentSyncSseClients = new Set();
let contentSyncInFlight = false;

function broadcastContentSyncEvent(ev) {
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const clientRes of contentSyncSseClients) {
    try {
      clientRes.write(payload);
    } catch {
      contentSyncSseClients.delete(clientRes);
    }
  }
}

async function loadContentSyncConfig() {
  const raw = await readFile(CONTENT_CONFIG_PATH, "utf8");
  const j = JSON.parse(raw);
  if (!j.dbPath) throw new Error('Thiếu "dbPath" trong config nội dung.');
  if (j.sourceIdFilter === undefined || j.sourceIdFilter === null) {
    j.sourceIdFilter = "asura";
  }
  return j;
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Body quá lớn."));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(s);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function tableColumnExists(db, table, col) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

function openDb() {
  if (!existsSync(DB_PATH)) {
    return null;
  }
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * ORDER BY an toàn cho /api/series (whitelist).
 * @param {string} sortRaw
 * @param {boolean} hasSyncCol
 * @param {boolean} hasChaptersStoredCol
 */
function seriesListOrderSql(sortRaw, hasSyncCol, hasChaptersStoredCol) {
  let sort = (sortRaw || "title").trim();
  if (sort === "title") sort = "title_asc";
  else if (sort === "updated") sort = "updated_desc";
  else if (sort === "chapters") sort = "chapters_desc";

  if (!hasSyncCol && (sort === "sync_pending_first" || sort === "sync_done_first")) {
    sort = "title_asc";
  }
  if (!hasChaptersStoredCol && (sort === "db_chapters_desc" || sort === "db_chapters_asc")) {
    sort = "title_asc";
  }

  const ORDER = {
    title_asc: "ORDER BY s.title COLLATE NOCASE ASC",
    title_desc: "ORDER BY s.title COLLATE NOCASE DESC",
    updated_desc: "ORDER BY (s.updated_at IS NULL), s.updated_at DESC, s.title COLLATE NOCASE ASC",
    updated_asc: "ORDER BY (s.updated_at IS NULL), s.updated_at ASC, s.title COLLATE NOCASE ASC",
    chapters_desc: "ORDER BY (s.chapter_count IS NULL), s.chapter_count DESC, s.title COLLATE NOCASE ASC",
    chapters_asc: "ORDER BY (s.chapter_count IS NULL), s.chapter_count ASC, s.title COLLATE NOCASE ASC",
    id_asc: "ORDER BY s.id ASC",
    id_desc: "ORDER BY s.id DESC",
    source_asc: "ORDER BY s.source_id COLLATE NOCASE ASC, s.title COLLATE NOCASE ASC",
    source_desc: "ORDER BY s.source_id COLLATE NOCASE DESC, s.title COLLATE NOCASE ASC",
    sync_pending_first:
      "ORDER BY CASE WHEN s.content_sync_complete = 1 THEN 1 ELSE 0 END, s.title COLLATE NOCASE ASC",
    sync_done_first:
      "ORDER BY CASE WHEN s.content_sync_complete = 1 THEN 0 ELSE 1 END, s.title COLLATE NOCASE ASC",
    db_chapters_desc:
      "ORDER BY (s.chapters_stored_count IS NULL), s.chapters_stored_count DESC, s.title COLLATE NOCASE ASC",
    db_chapters_asc:
      "ORDER BY (s.chapters_stored_count IS NULL), s.chapters_stored_count ASC, s.title COLLATE NOCASE ASC",
    status_asc: "ORDER BY (s.status IS NULL), s.status COLLATE NOCASE ASC, s.title COLLATE NOCASE ASC",
    status_desc: "ORDER BY (s.status IS NULL), s.status COLLATE NOCASE DESC, s.title COLLATE NOCASE ASC",
    rating_desc: "ORDER BY (s.rating IS NULL), s.rating DESC, s.title COLLATE NOCASE ASC",
    rating_asc: "ORDER BY (s.rating IS NULL), s.rating ASC, s.title COLLATE NOCASE ASC",
    path_asc: "ORDER BY s.series_path COLLATE NOCASE ASC",
    path_desc: "ORDER BY s.series_path COLLATE NOCASE DESC",
  };

  return ORDER[sort] || ORDER.title_asc;
}

function handleApi(db, url) {
  const u = new URL(url, "http://local");
  const path = u.pathname;

  if (path === "/api/stats") {
    if (!db) {
      return {
        ok: true,
        dbPath: DB_PATH,
        exists: false,
        seriesCount: 0,
        runsCount: 0,
        contentRunsCount: 0,
        contentPendingSeries: null,
      };
    }
    const seriesCount = db.prepare("SELECT COUNT(*) AS c FROM catalog_series").get().c;
    const runsCount = db.prepare("SELECT COUNT(*) AS c FROM catalog_sync_runs").get().c;
    const sources = db
      .prepare(
        "SELECT source_id AS id, COUNT(*) AS n FROM catalog_series GROUP BY source_id ORDER BY n DESC"
      )
      .all();
    let contentRunsCount = 0;
    if (tableExists(db, "catalog_content_runs")) {
      contentRunsCount = db.prepare("SELECT COUNT(*) AS c FROM catalog_content_runs").get().c;
    }
    let contentPendingSeries = null;
    if (tableColumnExists(db, "catalog_series", "content_sync_complete")) {
      contentPendingSeries = db
        .prepare("SELECT COUNT(*) AS c FROM catalog_series WHERE content_sync_complete = 0")
        .get().c;
    }
    return {
      ok: true,
      dbPath: DB_PATH,
      exists: true,
      seriesCount,
      runsCount,
      sources,
      contentRunsCount,
      contentPendingSeries,
    };
  }

  if (path === "/api/series") {
    if (!db) {
      return { ok: true, total: 0, items: [], limit: 50, offset: 0 };
    }
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") || 50)));
    const offset = Math.max(0, Number(u.searchParams.get("offset") || 0));
    const q = (u.searchParams.get("q") || "").trim();
    const source = (u.searchParams.get("source") || "").trim();
    const sort = u.searchParams.get("sort") || "title";
    const syncFilter = (u.searchParams.get("sync") || "all").trim().toLowerCase();

    const hasSyncCol = tableColumnExists(db, "catalog_series", "content_sync_complete");
    const hasChaptersStoredCol = tableColumnExists(db, "catalog_series", "chapters_stored_count");

    const where = [];
    const params = [];
    if (q) {
      where.push("(s.title LIKE ? ESCAPE '\\' OR s.series_path LIKE ? ESCAPE '\\')");
      const esc = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const like = "%" + esc + "%";
      params.push(like, like);
    }
    if (source) {
      where.push("s.source_id = ?");
      params.push(source);
    }
    if (hasSyncCol && syncFilter === "done") {
      where.push("s.content_sync_complete = 1");
    } else if (hasSyncCol && syncFilter === "pending") {
      where.push("(s.content_sync_complete IS NULL OR s.content_sync_complete = 0)");
    }

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const orderSql = seriesListOrderSql(sort, hasSyncCol, hasChaptersStoredCol);

    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM catalog_series s ${whereSql}`)
      .get(...params);
    const total = countRow.c;

    const syncCols = hasSyncCol
      ? `s.content_sync_complete, s.content_sync_completed_at, s.content_sync_note`
      : `NULL AS content_sync_complete, NULL AS content_sync_completed_at, NULL AS content_sync_note`;

    const seriesMetaCols = tableColumnExists(db, "catalog_series", "series_db_file")
      ? `s.series_db_file, s.latest_chapter_num, s.chapters_stored_count,
         s.chapters_stored_count AS db_chapter_count,`
      : `NULL AS series_db_file, NULL AS latest_chapter_num, NULL AS chapters_stored_count,
         NULL AS db_chapter_count,`;

    const items = db
      .prepare(
        `SELECT s.id, s.source_id, s.series_path, s.list_url, s.list_params_json, s.title, s.series_url,
                s.cover_url, s.chapter_count, s.status, s.rating, s.extra_json, s.updated_at,
                ${seriesMetaCols}
                ${syncCols}
         FROM catalog_series s ${whereSql} ${orderSql} LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    return { ok: true, total, items, limit, offset };
  }

  if (path === "/api/runs") {
    if (!db) {
      return { ok: true, items: [] };
    }
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") || 30)));
    const items = db
      .prepare(
        `SELECT id, source_id, list_url, started_at, ended_at, ok, message, pages_fetched, rows_upserted
         FROM catalog_sync_runs ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
    return { ok: true, items };
  }

  if (path === "/api/content-runs") {
    if (!db || !tableExists(db, "catalog_content_runs")) {
      return { ok: true, items: [] };
    }
    const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") || 20)));
    const items = db
      .prepare(
        `SELECT id, started_at, ended_at, ok, message, series_processed, chapters_discovered, chapters_imaged
         FROM catalog_content_runs ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
    return { ok: true, items };
  }

  if (path === "/api/series-chapters") {
    if (!db) {
      return { ok: false, error: "Không mở được catalog." };
    }
    const seriesId = Number(u.searchParams.get("seriesId"), 10);
    if (!Number.isFinite(seriesId)) {
      return { ok: false, error: "Thiếu hoặc sai seriesId." };
    }
    const meta = db
      .prepare(`SELECT series_db_file FROM catalog_series WHERE id = ?`)
      .get(seriesId);
    if (!meta || !meta.series_db_file) {
      return {
        ok: false,
        error: "Chưa có series_db_file. Chạy npm run catalog:sync rồi catalog:content.",
      };
    }
    const abs = join(CATALOG_DIR, meta.series_db_file);
    if (!existsSync(abs)) {
      return { ok: true, seriesId, total: 0, items: [], limit: 200, offset: 0 };
    }
    let sdb;
    try {
      sdb = openSeriesDbReadonly(abs);
      const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit") || 200)));
      const off = Math.max(0, Number(u.searchParams.get("offset") || 0));
      const total = sdb.prepare("SELECT COUNT(*) AS c FROM chapters").get().c;
      const rows = sdb
        .prepare(
          `SELECT id, chapter_num, title, chapter_url, final_url, image_count, fetch_ok, error_message,
                  chapters_list_fetched_at, images_fetched_at
           FROM chapters ORDER BY chapter_num ASC LIMIT ? OFFSET ?`
        )
        .all(limit, off);
      const items = rows.map((r) => ({ ...r, series_id: seriesId }));
      return { ok: true, seriesId, total, items, limit, offset: off };
    } finally {
      if (sdb) sdb.close();
    }
  }

  if (path === "/api/chapter-images") {
    if (!db) {
      return { ok: false, error: "Không mở được catalog." };
    }
    const seriesId = Number(u.searchParams.get("seriesId"), 10);
    const chapterId = Number(u.searchParams.get("chapterId"), 10);
    if (!Number.isFinite(seriesId) || !Number.isFinite(chapterId)) {
      return { ok: false, error: "Cần seriesId và chapterId." };
    }
    const meta = db
      .prepare(`SELECT series_db_file FROM catalog_series WHERE id = ?`)
      .get(seriesId);
    if (!meta || !meta.series_db_file) {
      return { ok: false, error: "Chưa có file DB cho bộ này." };
    }
    const abs = join(CATALOG_DIR, meta.series_db_file);
    if (!existsSync(abs)) {
      return { ok: true, chapterId, seriesId, total: 0, items: [] };
    }
    let sdb;
    try {
      sdb = openSeriesDbReadonly(abs);
      const items = sdb
        .prepare(
          `SELECT id, chapter_id, sort_order, url FROM chapter_images WHERE chapter_id = ? ORDER BY sort_order ASC`
        )
        .all(chapterId);
      return { ok: true, chapterId, seriesId, total: items.length, items };
    } finally {
      if (sdb) sdb.close();
    }
  }

  return handleReaderRoutes(db, u);
}

/**
 * API cho reader-sqlite.html — manifest nhẹ + ảnh theo từng chapter.
 * @param {import('better-sqlite3').Database | null} db
 * @param {URL} u
 */
function handleReaderRoutes(db, u) {
  const path = u.pathname;
  if (path !== "/api/reader/manifest" && path !== "/api/reader/chapter") {
    return null;
  }
  if (!db) {
    return { ok: false, error: "Không mở được catalog.sqlite." };
  }

  if (path === "/api/reader/manifest") {
    const seriesId = Number(u.searchParams.get("seriesId"), 10);
    if (!Number.isFinite(seriesId)) {
      return { ok: false, error: "Thiếu hoặc sai seriesId." };
    }
    const row = db
      .prepare(
        `SELECT id, title, updated_at, series_db_file FROM catalog_series WHERE id = ?`
      )
      .get(seriesId);
    if (!row) {
      return { ok: false, error: "Không tìm thấy series." };
    }
    if (!row.series_db_file || !String(row.series_db_file).trim()) {
      return {
        ok: false,
        error: "Chưa có series_db_file. Chạy npm run \"catalog:sync\" rồi đồng bộ nội dung.",
      };
    }
    const abs = join(CATALOG_DIR, row.series_db_file);
    if (!existsSync(abs)) {
      return { ok: false, error: "File DB bộ chưa tồn tại: " + row.series_db_file };
    }
    let sdb;
    try {
      sdb = openSeriesDbReadonly(abs);
      const rows = sdb
        .prepare(
          `SELECT id, chapter_num, title, image_count, fetch_ok, error_message
           FROM chapters ORDER BY chapter_num ASC`
        )
        .all();
      const chapters = rows.map((r) => ({
        chapter: r.chapter_num,
        title: r.title || "Chapter " + r.chapter_num,
        total: r.image_count ?? 0,
        images: [],
        error:
          r.fetch_ok === 1
            ? null
            : r.error_message || (r.image_count > 0 ? null : "Chưa có ảnh hoặc fetch lỗi"),
      }));
      const nums = rows.map((r) => r.chapter_num);
      const fromChapter = nums.length ? Math.min(...nums) : null;
      const toChapter = nums.length ? Math.max(...nums) : null;
      return {
        ok: true,
        source: "sqlite",
        seriesId,
        title: row.title,
        fromChapter,
        toChapter,
        fetchedAt: row.updated_at || null,
        chapters,
      };
    } finally {
      if (sdb) sdb.close();
    }
  }

  if (path === "/api/reader/chapter") {
    const seriesId = Number(u.searchParams.get("seriesId"), 10);
    const chapterNum = Number(
      u.searchParams.get("chapterNum") || u.searchParams.get("c"),
      10
    );
    if (!Number.isFinite(seriesId) || !Number.isFinite(chapterNum)) {
      return { ok: false, error: "Cần seriesId và chapterNum (hoặc c)." };
    }
    const meta = db.prepare(`SELECT series_db_file FROM catalog_series WHERE id = ?`).get(seriesId);
    if (!meta || !meta.series_db_file) {
      return { ok: false, error: "Không có file DB cho bộ này." };
    }
    const abs = join(CATALOG_DIR, meta.series_db_file);
    if (!existsSync(abs)) {
      return { ok: false, error: "File DB bộ không tồn tại." };
    }
    let sdb;
    try {
      sdb = openSeriesDbReadonly(abs);
      const chRow = sdb
        .prepare(
          `SELECT id, chapter_num, title, image_count, fetch_ok, error_message
           FROM chapters WHERE chapter_num = ?`
        )
        .get(chapterNum);
      if (!chRow) {
        return { ok: false, error: "Không có chapter " + chapterNum + " trong DB." };
      }
      const urls = sdb
        .prepare(
          `SELECT url FROM chapter_images WHERE chapter_id = ? ORDER BY sort_order ASC`
        )
        .all(chRow.id);
      return {
        ok: true,
        chapter: chRow.chapter_num,
        title: chRow.title || "Chapter " + chRow.chapter_num,
        images: urls.map((x) => x.url),
        error:
          chRow.fetch_ok === 1
            ? null
            : chRow.error_message || (urls.length ? null : "Chưa có URL ảnh"),
      };
    } finally {
      if (sdb) sdb.close();
    }
  }

  return null;
}

/**
 * @param {Record<string, unknown>} body
 */
async function startContentSyncFromAdmin(body) {
  if (!ALLOW_ADMIN_CONTENT_SYNC) {
    return { ok: false, error: "Đã tắt sync từ UI (đặt CATALOG_ALLOW_CONTENT_SYNC=0)." };
  }
  if (contentSyncInFlight) {
    return { ok: false, error: "Đang có đồng bộ nội dung chạy. Đợi xong hoặc xem tiến độ bên dưới." };
  }

  const seriesIdNum = Number(body.seriesId);
  const hasSeries =
    body.seriesId != null &&
    body.seriesId !== "" &&
    Number.isFinite(seriesIdNum);
  const next = body.next === true || body.next === "true";

  if (!hasSeries && !next) {
    return { ok: false, error: "Gửi { seriesId: number } hoặc { next: true }." };
  }

  const seriesId = hasSeries ? seriesIdNum : null;
  const flags = {
    fetchImages: body.fetchImages !== false,
    force: !!body.force,
    nextSeries: next && seriesId == null,
    seriesId,
    includeSynced: !!body.includeSynced,
  };

  let cfg;
  try {
    cfg = await loadContentSyncConfig();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  contentSyncInFlight = true;
  broadcastContentSyncEvent({ type: "run_queued", flags });

  void (async () => {
    try {
      await runCatalogContentSync({
        cfg,
        flags,
        onProgress: (ev) => broadcastContentSyncEvent(ev),
      });
    } catch (e) {
      const code = e && e.code;
      if (code === "ECATALOGCONTENTLOCK") {
        broadcastContentSyncEvent({
          type: "lock_busy",
          message: String(e.message || e),
        });
      } else {
        broadcastContentSyncEvent({
          type: "run_error",
          message: String(e.message || e),
        });
      }
    } finally {
      contentSyncInFlight = false;
      broadcastContentSyncEvent({ type: "idle" });
    }
  })();

  return { ok: true, started: true };
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  const u = new URL(url, "http://127.0.0.1");

  if (req.method === "GET" && u.pathname === "/api/content-sync/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(
      `data: ${JSON.stringify({
        type: "hello",
        running: contentSyncInFlight,
        allowSync: ALLOW_ADMIN_CONTENT_SYNC,
      })}\n\n`
    );
    contentSyncSseClients.add(res);
    req.on("close", () => {
      contentSyncSseClients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && u.pathname === "/api/content-sync/status") {
    json(res, 200, {
      ok: true,
      running: contentSyncInFlight,
      allowSync: ALLOW_ADMIN_CONTENT_SYNC,
      configPath: CONTENT_CONFIG_PATH,
    });
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/content-sync/start") {
    readJsonBody(req)
      .then((body) => startContentSyncFromAdmin(body))
      .then((out) => {
        const st = out.ok ? 200 : out.error && out.error.includes("Đang có") ? 409 : 400;
        json(res, st, out);
      })
      .catch((e) => {
        json(res, 400, { ok: false, error: String(e.message || e) });
      });
    return;
  }

  if (req.method === "GET" && url.startsWith("/api/")) {
    let db;
    try {
      db = openDb();
      const payload = handleApi(db, "http://x" + url);
      if (!payload) {
        json(res, 404, { ok: false, error: "Not found" });
        return;
      }
      json(res, 200, payload);
    } catch (e) {
      json(res, 500, { ok: false, error: String(e.message || e) });
    } finally {
      if (db) db.close();
    }
    return;
  }

  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    try {
      const html = readFileSync(INDEX_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e.message || e));
    }
    return;
  }

  if (req.method === "GET" && u.pathname === "/reader-sqlite.html") {
    try {
      if (!existsSync(READER_SQLITE_HTML)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("reader-sqlite.html not found");
        return;
      }
      const html = readFileSync(READER_SQLITE_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e.message || e));
    }
    return;
  }

  if (req.method === "GET" && u.pathname === "/reader-sqlite-local.html") {
    try {
      if (!existsSync(READER_SQLITE_LOCAL_HTML)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("reader-sqlite-local.html not found");
        return;
      }
      const html = readFileSync(READER_SQLITE_LOCAL_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e.message || e));
    }
    return;
  }

  if (req.method === "GET" && u.pathname === "/reader-sqlite-local.js") {
    try {
      if (!existsSync(READER_SQLITE_LOCAL_JS)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("reader-sqlite-local.js not found");
        return;
      }
      const js = readFileSync(READER_SQLITE_LOCAL_JS, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(js);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e.message || e));
    }
    return;
  }

  if (req.method === "GET" && u.pathname === "/reader-sqlite.js") {
    try {
      if (!existsSync(READER_SQLITE_JS)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("reader-sqlite.js not found");
        return;
      }
      const js = readFileSync(READER_SQLITE_JS, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(js);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e.message || e));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.error(`Catalog UI: http://${HOST}:${PORT}/`);
  console.error(`Reader SQLite (API): http://${HOST}:${PORT}/reader-sqlite.html?seriesId=ID&c=CHAPTER`);
  console.error(`Reader SQLite (file+SQL.js): http://${HOST}:${PORT}/reader-sqlite-local.html`);
  console.error(`Database: ${DB_PATH}${existsSync(DB_PATH) ? "" : " (chưa có file — chạy npm run catalog:sync trước)"}`);
  console.error(
    `Đồng bộ nội dung từ UI: ${ALLOW_ADMIN_CONTENT_SYNC ? "bật" : "tắt"} · config ${CONTENT_CONFIG_PATH}`
  );
});
