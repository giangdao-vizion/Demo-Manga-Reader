#!/usr/bin/env node
/**
 * Đổ vào DB: chapter + URL + (tuỳ chọn) URL ảnh — theo nguồn (asura / qimanhwa, v.v.).
 * Cùng tựa trùng canonical_key: HTML chapter + URL lấy từ bộ preferred_fetch_catalog_id (chapter_count cao hơn).
 * Config: "contentCookieEnv": "QIMANHWA_COOKIE" để gửi Cookie khi fetch (Cloudflare).
 * Dựa trên catalog_series đã có (chạy catalog:sync trước).
 *
 *   node sync-catalog-content.js [catalog/configs/asura-content.json]
 *   node sync-catalog-content.js --limit-series=2 --max-chapters=3
 *   node sync-catalog-content.js --no-images
 *   node sync-catalog-content.js --series-id=5 --force
 *
 * Trong JSON config: chapterConcurrency (1–8) = số chapter fetch song song (ghi DB vẫn lần lượt).
 *
 * Hàng đợi theo DB: mặc định chỉ lấy bộ có content_sync_complete=0.
 * Chapter trong mỗi bộ được xử lý từ mới nhất → cũ (ưu tiên chương vừa ra).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCatalogContentSync } from "./catalog/lib/sync-catalog-content-core.js";

const DEFAULT_CONFIG = "catalog/configs/asura-content.json";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} [config.json] [options]

Options (ghi đè config):
  --no-images              Chỉ ghi nhận chapter + URL, không tải list ảnh
  --force                  Tải lại ảnh dù chapter đã có ảnh
  --limit-series=N         Chỉ xử lý N bộ đầu tiên
  --max-chapters=N         Mỗi bộ chỉ N chapter cuối (mới nhất; có thể trùng chapter Premium → 0 ảnh)
  --series-id=N            Chỉ một series (id trong catalog_series)
  --offset-series=N        Bỏ qua N bộ đầu trong hàng đợi (sau khi lọc chưa sync)
  --include-synced         Cũng xử lý bộ đã complete (không dùng bộ lọc skip)
  --reset-series-sync      Kèm --series-id: reset cờ complete trước khi chạy
`);
}

function parseArgInt(name, argv) {
  const eq = argv.find((a) => a.startsWith(name + "="));
  if (eq) {
    const n = Number(eq.slice(name.length + 1), 10);
    return Number.isFinite(n) ? n : null;
  }
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) {
    const n = Number(argv[i + 1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseFlags(argv) {
  const flags = {
    fetchImages: !argv.includes("--no-images"),
    force: argv.includes("--force"),
    limitSeries: parseArgInt("--limit-series", argv),
    maxChapters: parseArgInt("--max-chapters", argv),
    seriesId: parseArgInt("--series-id", argv),
    offsetSeries: parseArgInt("--offset-series", argv),
    includeSynced: argv.includes("--include-synced"),
    resetSeriesSync: argv.includes("--reset-series-sync"),
  };
  const positional = argv.slice(2).filter((a) => !a.startsWith("--"));
  return { flags, positional };
}

async function loadConfig(path) {
  const raw = await readFile(path, "utf8");
  const j = JSON.parse(raw);
  if (!j.dbPath) throw new Error('config cần "dbPath".');
  if (j.sourceIdFilter === undefined || j.sourceIdFilter === null) {
    j.sourceIdFilter = "asura";
  }
  return j;
}

function progressToStderr(ev) {
  if (!ev || typeof ev !== "object") return;
  const t = ev.type;
  if (t === "lock_busy") {
    process.stderr.write(String(ev.message || "") + "\n");
    return;
  }
  if (t === "log") {
    process.stderr.write(String(ev.message || "") + "\n");
    return;
  }
  if (t === "run_start") {
    process.stderr.write(`\n[run #${ev.runId}] ${ev.seriesTotal} bộ trong lô\n`);
    return;
  }
  if (t === "series_start") {
    const pref =
      ev.fetchSourceId && ev.fetchSourceId !== ev.sourceId
        ? ` · fetch:${ev.fetchSourceId}`
        : "";
    process.stderr.write(
      `\n[${ev.seriesIndex}/${ev.seriesTotal}] #${ev.seriesId} ${ev.title} (${ev.seriesPath})${pref}\n`
    );
    return;
  }
  if (t === "series_fetch_error") {
    process.stderr.write(`  series page: ${ev.message}\n`);
    process.stderr.write(`  (chưa đánh dấu complete — sẽ thử lại lần sau)\n`);
    return;
  }
  if (t === "series_db_path") {
    process.stderr.write(`  → DB bộ: ${ev.relativePath}\n`);
    return;
  }
  if (t === "chapters_scope") {
    const pend = ev.pendingInRun != null ? ev.pendingInRun : ev.count;
    const done = ev.alreadyCompleteInDb != null ? ev.alreadyCompleteInDb : 0;
    process.stderr.write(
      `  → ${ev.count} ch trong scope (cũ → mới); cần tải: ${pend}; đã có ảnh OK: ${done}; mẫu số ch: ${(ev.chapterNumsSample || []).join(", ")}…\n`
    );
    return;
  }
  if (t === "chapter_done") {
    const n = ev.chapterNum;
    if (ev.action === "skip") {
      process.stderr.write(`  ch.${n}: bỏ qua (đã có ${ev.images} ảnh trong DB)\n`);
    } else if (ev.action === "stub") {
      process.stderr.write(`  ch.${n}: stub (chưa tải ảnh)\n`);
    } else if (ev.action === "fetch_ok") {
      process.stderr.write(`  ch.${n}: ${ev.images} ảnh\n`);
    } else if (ev.action === "fetch_fail") {
      process.stderr.write(`  ch.${n}: lỗi — ${ev.error || "?"}\n`);
    }
    return;
  }
  if (t === "series_marked_complete") {
    process.stderr.write(`  → đã đánh dấu content_sync_complete (${ev.note || ""})\n`);
    return;
  }
  if (t === "series_complete") {
    if (ev.contentSyncComplete) {
      process.stderr.write(`  → content_sync_complete · ${ev.note || ""}\n`);
    } else {
      process.stderr.write(
        `  → chưa đánh dấu complete (--no-images). Lần sau vẫn được chọn trong hàng đợi khi chạy có ảnh.\n`
      );
    }
    return;
  }
  if (t === "run_finish") {
    if (ev.ok) {
      console.log(ev.message);
    } else {
      console.error(ev.message);
    }
  }
}

async function main() {
  const argv = process.argv;
  if (argv.includes("-h") || argv.includes("--help")) {
    usage();
    process.exit(0);
  }

  const { flags, positional } = parseFlags(argv);
  const configPath = resolve(process.cwd(), positional[0] || DEFAULT_CONFIG);

  let cfg;
  try {
    cfg = await loadConfig(configPath);
  } catch (e) {
    console.error(e.message || e);
    usage();
    process.exit(1);
  }

  try {
    const result = await runCatalogContentSync({
      cfg,
      flags,
      onProgress: progressToStderr,
    });
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    if (e && e.code === "ECATALOGCONTENTLOCK") {
      process.exitCode = 1;
      return;
    }
    console.error(String(e.message || e));
    process.exitCode = 1;
  }
}

main();
