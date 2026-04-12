#!/usr/bin/env node
/**
 * Xuất chapter + ảnh từ catalog SQLite (series/*.sqlite) sang JSON reader (cùng format home/index).
 * - Ưu tiên bộ có chapter cập nhật gần nhất (MAX(images_fetched_at)).
 * - Chỉ thêm chapter thiếu; không ghi đè chapter đã có trong JSON.
 * - Ảnh minh hoạ (cover): lấy catalog_series.cover_url → ghi coverUrl trong JSON manifest + manhwa-catalog.json.
 * - Tên file cố định: lấy từ manhwa-sqlite-mapping.json (dataFile) hoặc slug suy ra từ series_path.
 *
 *   node export-sqlite-to-manhwa-json.js
 *   node export-sqlite-to-manhwa-json.js --db=catalog/db/catalog.sqlite --out=. --dry-run
 *   node export-sqlite-to-manhwa-json.js --catalog-rebuild   # chỉ quét *.json và ghi manhwa-catalog.json
 *
 * manhwa-sqlite-mapping.json:
 *   { "version": 1, "bySeriesId": { "5": { "dataFile": "solo-max-level-newbie-ch180-252.json", "slug": "solo-max-level-newbie" } } }
 * Nếu chỉ có slug: dataFile mặc định là "<slug>.json".
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCatalogDb } from "./catalog/lib/db.js";
import {
  catalogDirFromMainDbPath,
  resolveSeriesDbPath,
  openSeriesDbReadonly,
} from "./catalog/lib/series-db.js";

const SKIP_JSON = new Set([
  "package.json",
  "package-lock.json",
  "manhwa-catalog.json",
  "manhwa-sqlite-mapping.json",
  "tsconfig.json",
  "jsconfig.json",
]);

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} [options]

Options:
  --db=PATH              catalog.sqlite (default: catalog/db/catalog.sqlite)
  --out=DIR              Thư mục ghi JSON + catalog (default: .)
  --mapping=PATH         manhwa-sqlite-mapping.json
  --catalog=PATH         manhwa-catalog.json
  --source=LIST          Lọc source_id (vd: asura); nhiều nguồn cách phẩy
  --limit=N              Chỉ xử lý tối đa N bộ (sau khi sort ưu tiên)
  --dry-run              Không ghi file
  --catalog-rebuild      Chỉ dựng lại manhwa-catalog.json từ *.json trên đĩa + mapping
`);
}

function parseArgs(argv) {
  const out = {
    db: "catalog/db/catalog.sqlite",
    outDir: ".",
    mapping: "manhwa-sqlite-mapping.json",
    catalog: "manhwa-catalog.json",
    sourceFilter: null,
    limit: null,
    dryRun: false,
    catalogRebuild: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    }
    if (a === "--dry-run") out.dryRun = true;
    if (a === "--catalog-rebuild") out.catalogRebuild = true;
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1];
    const v = m[2];
    if (k === "db") out.db = v;
    else if (k === "out") out.outDir = v;
    else if (k === "mapping") out.mapping = v;
    else if (k === "catalog") out.catalog = v;
    else if (k === "source") out.sourceFilter = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "limit") out.limit = Math.max(0, parseInt(v, 10)) || null;
  }
  return out;
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function slugFromSeriesPath(seriesPath) {
  const s = String(seriesPath || "").replace(/\\/g, "/");
  const seg = s.split("/").filter(Boolean).pop() || "series";
  const trimmed = seg.replace(/-[0-9a-f]{8}$/i, "");
  return trimmed
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "series";
}

function titleFromFilename(dataFile) {
  const base = dataFile
    .replace(/\.json$/i, "")
    .replace(/-ch\d+.*$/i, "")
    .replace(/-chapter[-\d].*$/i, "");
  const words = base.split(/[-_]+/).filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function resolveDataFileForSeries(row, mapping) {
  const idKey = String(row.id);
  const ent = mapping.bySeriesId?.[idKey] || null;
  const slug = ent?.slug || slugFromSeriesPath(row.series_path);
  const dataFile =
    ent?.dataFile && String(ent.dataFile).trim()
      ? String(ent.dataFile).trim()
      : `${slug}.json`;
  return { dataFile, slug, mappingEntry: ent };
}

function maxImagesFetchedAt(seriesAbs) {
  if (!existsSync(seriesAbs)) return 0;
  let sdb;
  try {
    sdb = openSeriesDbReadonly(seriesAbs);
    const r = sdb
      .prepare(
        `SELECT MAX(images_fetched_at) AS m FROM chapters WHERE fetch_ok = 1 AND image_count > 0`
      )
      .get();
    if (r?.m) {
      const t = Date.parse(r.m);
      if (Number.isFinite(t)) return t;
    }
  } catch {
    /* ignore */
  } finally {
    try {
      sdb?.close();
    } catch {
      /* ignore */
    }
  }
  return 0;
}

function seriesPriorityMs(row, catalogDir) {
  const abs = resolveSeriesDbPath(catalogDir, row.id, row.series_db_file);
  const fromCh = maxImagesFetchedAt(abs);
  if (fromCh) return fromCh;
  if (row.content_sync_completed_at) {
    const t = Date.parse(row.content_sync_completed_at);
    if (Number.isFinite(t)) return t;
  }
  if (row.updated_at) {
    const t = Date.parse(row.updated_at);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function chapterNum(ch) {
  const n = ch?.chapter;
  return Number.isFinite(n) ? n : null;
}

function normCover(u) {
  const s = u != null && String(u).trim();
  return s ? String(s) : null;
}

function sqliteChapterToJson(row, imageUrls) {
  const n = row.chapter_num;
  return {
    title: row.title || `Chapter ${n}`,
    chapter: n,
    url: row.chapter_url,
    finalUrl: row.final_url || row.chapter_url || "",
    total: imageUrls.length,
    images: imageUrls,
  };
}

function exportOneSeries({ row, catalogDir, outDir, dataFile, dryRun }) {
  const abs = resolveSeriesDbPath(catalogDir, row.id, row.series_db_file);
  if (!existsSync(abs)) {
    return { ok: false, reason: "no_series_db", dataFile };
  }

  let sdb;
  try {
    sdb = openSeriesDbReadonly(abs);
  } catch (e) {
    return { ok: false, reason: String(e.message || e), dataFile };
  }

  try {
    const chRows = sdb
      .prepare(
        `SELECT id, chapter_num, title, chapter_url, final_url, fetch_ok, image_count
         FROM chapters
         WHERE fetch_ok = 1 AND image_count > 0
         ORDER BY chapter_num ASC`
      )
      .all();

    const imgStmt = sdb.prepare(
      `SELECT url FROM chapter_images WHERE chapter_id = ? ORDER BY sort_order ASC`
    );

    const outPath = join(outDir, dataFile);
    let existing = loadJson(outPath);
    if (!existing || typeof existing !== "object") existing = {};
    const existingChapters = Array.isArray(existing.chapters) ? existing.chapters : [];
    const have = new Set();
    for (const ch of existingChapters) {
      const k = chapterNum(ch);
      if (k != null) have.add(k);
    }

    let added = 0;
    const toAppend = [];
    for (const r of chRows) {
      if (have.has(r.chapter_num)) continue;
      const urls = imgStmt.all(r.id).map((x) => x.url);
      if (!urls.length) continue;
      toAppend.push(sqliteChapterToJson(r, urls));
      added++;
    }

    const merged = [...existingChapters, ...toAppend].sort(
      (a, b) => (chapterNum(a) ?? 0) - (chapterNum(b) ?? 0)
    );
    const prevCover = normCover(existing.coverUrl);
    const mergedCover = normCover(row.cover_url) || prevCover;
    const coverChanged = mergedCover !== prevCover;

    if (added === 0 && existingChapters.length > 0 && !coverChanged) {
      return { ok: true, dataFile, added: 0, skipped: "all_present" };
    }

    if (merged.length === 0) {
      return { ok: true, dataFile, added: 0, skipped: "no_chapters" };
    }

    const nums = merged.map(chapterNum).filter((n) => n != null);
    const fromChapter = nums.length ? Math.min(...nums) : null;
    const toChapter = nums.length ? Math.max(...nums) : null;

    const sampleUrl =
      existing.sampleUrl ||
      merged.find((c) => c.url)?.url ||
      row.series_url ||
      "";

    const outManifest = {
      ...existing,
      sampleUrl,
      fromChapter,
      toChapter,
      fetchedAt: new Date().toISOString(),
      source: existing.source != null && existing.source !== "" ? existing.source : row.source_id,
      chapters: merged,
    };
    if (mergedCover) {
      outManifest.coverUrl = mergedCover;
    } else {
      delete outManifest.coverUrl;
    }

    if (!dryRun) {
      writeJson(outPath, outManifest);
    }
    return { ok: true, dataFile, added, totalChapters: merged.length };
  } finally {
    try {
      sdb.close();
    } catch {
      /* ignore */
    }
  }
}

function isDataJsonCandidate(name) {
  if (!name.endsWith(".json")) return false;
  if (SKIP_JSON.has(name)) return false;
  if (name.startsWith(".")) return false;
  return true;
}

function buildReverseFileToId(mapping) {
  const m = new Map();
  for (const [idStr, ent] of Object.entries(mapping.bySeriesId || {})) {
    const slug = ent?.slug;
    const dataFile =
      ent?.dataFile && String(ent.dataFile).trim()
        ? String(ent.dataFile).trim()
        : slug
          ? `${slug}.json`
          : null;
    if (dataFile) m.set(dataFile, Number(idStr));
  }
  return m;
}

function rebuildManhwaCatalog({ outDir, catalogPath, mapping, catalogDb, dryRun }) {
  const reverse = buildReverseFileToId(mapping);
  let names;
  try {
    names = readdirSync(outDir);
  } catch {
    console.error("Cannot read out dir:", outDir);
    return;
  }

  const series = [];
  for (const dataFile of names.filter(isDataJsonCandidate).sort((a, b) => a.localeCompare(b))) {
    const full = join(outDir, dataFile);
    const j = loadJson(full);
    if (!j || !Array.isArray(j.chapters)) continue;

    const nums = j.chapters.map((c) => chapterNum(c)).filter((n) => n != null);
    const fromC = nums.length ? Math.min(...nums) : null;
    const toC = nums.length ? Math.max(...nums) : null;

    const sqliteSeriesId = reverse.get(dataFile) ?? null;
    let dbRow = null;
    if (sqliteSeriesId != null && catalogDb) {
      dbRow = catalogDb
        .prepare(
          `SELECT id, title, source_id, cover_url, content_sync_complete, content_sync_completed_at, content_sync_note
           FROM catalog_series WHERE id = ?`
        )
        .get(sqliteSeriesId);
    }

    const source = j.source || dbRow?.source_id || "unknown";
    const title =
      (dbRow?.title && String(dbRow.title).trim()) ||
      j.title ||
      titleFromFilename(dataFile);
    const subtitle =
      fromC != null && toC != null
        ? `Ch. ${fromC}–${toC} · ${dataFile}`
        : `${j.chapters.length} chương · ${dataFile}`;
    const coverUrl =
      normCover(dbRow?.cover_url) || normCover(j.coverUrl) || null;

    series.push({
      dataFile,
      title,
      displayTitle: title,
      subtitle,
      source,
      fromChapter: fromC,
      toChapter: toC,
      chapterCount: j.chapters.length,
      sqliteSeriesId,
      contentSyncComplete: dbRow?.content_sync_complete === 1,
      contentSyncNote: dbRow?.content_sync_note || null,
      ...(coverUrl ? { coverUrl } : {}),
    });
  }

  const catalog = {
    version: 1,
    updatedAt: new Date().toISOString(),
    series: series.sort((a, b) =>
      String(a.title).localeCompare(String(b.title), "vi", { sensitivity: "base" })
    ),
  };

  if (!dryRun) {
    writeJson(catalogPath, catalog);
  }
  console.log(
    `manhwa-catalog: ${series.length} series → ${resolve(catalogPath)}${dryRun ? " (dry-run)" : ""}`
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = resolve(process.cwd(), opts.outDir);
  const dbPath = resolve(process.cwd(), opts.db);
  const mappingPath = resolve(process.cwd(), opts.mapping);
  const catalogPath = resolve(process.cwd(), opts.catalog);

  const mapping = loadJson(mappingPath) || { version: 1, bySeriesId: {} };
  if (!mapping.bySeriesId) mapping.bySeriesId = {};

  let catalogDb = null;
  if (!opts.catalogRebuild && existsSync(dbPath)) {
    try {
      catalogDb = openCatalogDb(dbPath);
    } catch (e) {
      console.error("Open catalog DB:", e.message || e);
      process.exit(1);
    }
  } else if (!opts.catalogRebuild) {
    console.error("Catalog DB not found:", dbPath);
    process.exit(1);
  }

  if (opts.catalogRebuild) {
    let dbForCatalog = null;
    if (existsSync(dbPath)) {
      try {
        dbForCatalog = openCatalogDb(dbPath);
      } catch {
        /* chỉ thiếu metadata SQLite trên catalog */
      }
    }
    rebuildManhwaCatalog({
      outDir,
      catalogPath,
      mapping,
      catalogDb: dbForCatalog,
      dryRun: opts.dryRun,
    });
    dbForCatalog?.close();
    return;
  }

  const catalogDir = catalogDirFromMainDbPath(dbPath);
  let sql = `SELECT id, source_id, series_path, title, series_url, series_db_file, cover_url,
                    content_sync_complete, content_sync_completed_at, updated_at
             FROM catalog_series WHERE 1=1`;
  const params = [];
  if (opts.sourceFilter?.length) {
    const ph = opts.sourceFilter.map(() => "?").join(",");
    sql += ` AND source_id IN (${ph})`;
    params.push(...opts.sourceFilter);
  }
  const rows = catalogDb.prepare(sql).all(...params);

  const ranked = rows
    .map((row) => ({
      row,
      pri: seriesPriorityMs(row, catalogDir),
    }))
    .sort((a, b) => b.pri - a.pri);

  const limited =
    opts.limit != null ? ranked.slice(0, opts.limit) : ranked;

  for (const { row } of limited) {
    if (!row.series_db_file || !String(row.series_db_file).trim()) continue;
    const { dataFile } = resolveDataFileForSeries(row, mapping);
    const r = exportOneSeries({
      row,
      catalogDir,
      outDir,
      dataFile,
      dryRun: opts.dryRun,
    });
    console.log(
      `${r.ok ? "OK" : "SKIP"}  id=${row.id}  ${dataFile}  added=${r.added ?? 0}  ${r.reason || r.skipped || ""}`
    );
  }

  rebuildManhwaCatalog({
    outDir,
    catalogPath,
    mapping,
    catalogDb,
    dryRun: opts.dryRun,
  });
  catalogDb.close();
}

main();
