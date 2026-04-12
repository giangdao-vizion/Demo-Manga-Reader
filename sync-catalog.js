#!/usr/bin/env node
/**
 * Đồng bộ danh mục truyện từ một URL browse (config) vào SQLite.
 *
 * Usage:
 *   node sync-catalog.js [path/to/config.json]
 *
 * Mặc định: catalog/configs/asura-manhwa-min100.json
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openCatalogDb, makeUpsertSeries, backfillSeriesDbFiles } from "./catalog/lib/db.js";
import { collectAllSeriesFromBrowse } from "./catalog/lib/adapters/asura-browse.js";

const ADAPTERS = {
  "asura-browse": collectAllSeriesFromBrowse,
};

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} [config.json]`);
}

function listParamsJson(listUrl) {
  const u = new URL(listUrl);
  const o = {};
  u.searchParams.forEach((v, k) => {
    o[k] = v;
  });
  return JSON.stringify(o);
}

async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const j = JSON.parse(raw);
  if (!j.sourceId || typeof j.sourceId !== "string") {
    throw new Error('config cần "sourceId" (string).');
  }
  if (!j.adapter || typeof j.adapter !== "string") {
    throw new Error('config cần "adapter" (string).');
  }
  if (!j.listUrl || typeof j.listUrl !== "string") {
    throw new Error('config cần "listUrl" (string).');
  }
  if (!j.dbPath || typeof j.dbPath !== "string") {
    throw new Error('config cần "dbPath" (string).');
  }
  return j;
}

async function main() {
  const configArg = process.argv[2];
  if (configArg === "-h" || configArg === "--help") {
    usage();
    process.exit(0);
  }

  const configPath = resolve(
    process.cwd(),
    configArg || "catalog/configs/asura-manhwa-min100.json"
  );

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (e) {
    console.error(e.message || e);
    usage();
    process.exit(1);
  }

  const runAdapter = ADAPTERS[config.adapter];
  if (!runAdapter) {
    console.error(`Adapter không hỗ trợ: ${config.adapter}. Có: ${Object.keys(ADAPTERS).join(", ")}`);
    process.exit(1);
  }

  const db = openCatalogDb(config.dbPath);
  const upsert = makeUpsertSeries(db);
  const started = new Date().toISOString();

  const insertRun = db.prepare(`
    INSERT INTO catalog_sync_runs (source_id, list_url, started_at, ok, pages_fetched, rows_upserted)
    VALUES (?, ?, ?, 0, NULL, NULL)
  `);
  const runResult = insertRun.run(config.sourceId, config.listUrl, started);
  const runId = Number(runResult.lastInsertRowid);

  const finishOk = db.prepare(`
    UPDATE catalog_sync_runs SET ended_at = ?, ok = 1, message = ?, pages_fetched = ?, rows_upserted = ?
    WHERE id = ?
  `);
  const finishErr = db.prepare(`
    UPDATE catalog_sync_runs SET ended_at = ?, ok = 0, message = ?
    WHERE id = ?
  `);

  console.error(`Config: ${configPath}`);
  console.error(`listUrl: ${config.listUrl}`);
  console.error(`db: ${resolve(process.cwd(), config.dbPath)}`);

  try {
    const result = await runAdapter({
      listUrl: config.listUrl,
      delayMs: config.delayMs ?? 600,
      userAgent: config.userAgent,
    });

    const now = new Date().toISOString();
    const paramsJson = listParamsJson(config.listUrl);
    let n = 0;

    for (const it of result.items) {
      upsert({
        source_id: config.sourceId,
        series_path: it.seriesPath,
        list_url: config.listUrl,
        list_params_json: paramsJson,
        title: it.title,
        series_url: it.seriesUrl,
        cover_url: it.coverUrl,
        chapter_count: it.chapterCount,
        status: it.status,
        rating: it.rating,
        extra_json: null,
        updated_at: now,
      });
      n++;
    }

    backfillSeriesDbFiles(db);

    const msg = `OK · ${n} series · ${result.pagesFetched} trang (≈${result.perPage}/trang) · total báo trên web: ${result.totalReported ?? "?"}`;
    finishOk.run(now, msg, result.pagesFetched, n, runId);
    console.log(msg);
  } catch (e) {
    const now = new Date().toISOString();
    const msg = String(e.message || e);
    finishErr.run(now, msg, runId);
    console.error(msg);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
