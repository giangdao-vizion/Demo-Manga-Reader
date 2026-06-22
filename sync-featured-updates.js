#!/usr/bin/env node
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { fetchAsuraImagesFromUrl } from "./extract.mjs";
import {
  SOURCE_LABELS,
  chapterLabelFromCrawlerExtra,
  createSeriesSyncReport,
  humanizeErrorMessage,
  logLine,
  logSeriesHeader,
  logSeriesSyncReport,
} from "./sync-log.mjs";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_DELAY_MS = 450;

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} [options]

Options:
  --catalog PATH         Mặc định: manhwa-catalog.json
  --concurrency N        Dùng cho crawler mgeko (mặc định: ${DEFAULT_CONCURRENCY})
  --delay MS             Delay khi check asura (mặc định: ${DEFAULT_DELAY_MS})
  --limit N              Chỉ xử lý N bộ featured đầu tiên
  --dry-run              Chỉ kiểm tra, không ghi file
`);
}

function parseArgs(argv) {
  const out = {
    catalogPath: "manhwa-catalog.json",
    concurrency: DEFAULT_CONCURRENCY,
    delayMs: DEFAULT_DELAY_MS,
    limit: null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--catalog" && argv[i + 1]) out.catalogPath = String(argv[++i]).trim();
    else if (a === "--concurrency" && argv[i + 1]) out.concurrency = Number(argv[++i], 10);
    else if (a === "--delay" && argv[i + 1]) out.delayMs = Number(argv[++i], 10);
    else if (a === "--limit" && argv[i + 1]) out.limit = Number(argv[++i], 10);
    else if (a === "--dry-run") out.dryRun = true;
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = DEFAULT_CONCURRENCY;
  if (!Number.isInteger(out.delayMs) || out.delayMs < 0) out.delayMs = DEFAULT_DELAY_MS;
  if (!Number.isInteger(out.limit) || out.limit <= 0) out.limit = null;
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeSource(source) {
  const s = String(source || "").trim().toLowerCase();
  if (s === "asura" || s === "asurascans") return "asura";
  if (s === "mgeko") return "mgeko";
  if (s === "kunmanga") return "kunmanga";
  if (s === "onepunchmantruyen" || s === "one-punch-man-truyen") return "onepunchmantruyen";
  if (s === "onepunchmanmau" || s === "one-punch-man-mau") return "onepunchmanmau";
  if (s === "truyenonepiece" || s === "truyen-one-piece") return "truyenonepiece";
  return s;
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

function chapterNumFromAsuraUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\/chapter\/(\d+)\/?$/i);
    return m ? Number(m[1], 10) : NaN;
  } catch {
    return NaN;
  }
}

function buildAsuraChapterUrl(sampleUrl, n) {
  const u = new URL(sampleUrl);
  u.pathname = u.pathname.replace(/\/chapter\/\d+\/?$/i, `/chapter/${n}`);
  return u.href;
}

function chapterNumberOf(ch, idx) {
  if (ch && Number.isFinite(ch.chapter)) return Number(ch.chapter);
  return idx + 1;
}

function chapterIdentity(ch) {
  if (ch && ch.chapterKey != null && String(ch.chapterKey).trim()) {
    return String(ch.chapterKey).trim();
  }
  if (ch && Number.isFinite(ch.chapter)) return String(ch.chapter);
  if (ch && ch.url) return String(ch.url).trim();
  return String(ch?.title || "").trim();
}

function chapterDisplayLabel(ch) {
  if (ch.chapterLabel != null && String(ch.chapterLabel).trim()) {
    return String(ch.chapterLabel).trim();
  }
  if (ch.chapterKey != null && String(ch.chapterKey).trim()) {
    return String(ch.chapterKey).trim();
  }
  if (Number.isFinite(ch.chapter)) return String(ch.chapter);
  return String(ch.title || "").trim() || "?";
}

function sortChapterLabels(labels) {
  return labels.slice().sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "vi", { numeric: true, sensitivity: "base" });
  });
}

function findNewChapterLabels(beforeDoc, afterDoc) {
  const before = new Set((beforeDoc.chapters || []).map(chapterIdentity));
  const labels = [];
  for (const ch of afterDoc.chapters || []) {
    if (!before.has(chapterIdentity(ch))) {
      labels.push(chapterDisplayLabel(ch));
    }
  }
  return sortChapterLabels(labels);
}

function chapterMetaFromDoc(doc) {
  const chapters = Array.isArray(doc.chapters) ? doc.chapters : [];
  const nums = chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
  const from = nums.length
    ? Math.min(...nums)
    : Number.isFinite(Number(doc.fromChapter))
      ? Number(doc.fromChapter)
      : 1;
  const to = nums.length
    ? Math.max(...nums)
    : Number.isFinite(Number(doc.toChapter))
      ? Number(doc.toChapter)
      : from;
  const count = chapters.length || Number(doc.chapterCount) || 0;
  return { from, to, count };
}

function catalogMetaDiffers(entry, meta) {
  if (!entry || !meta) return false;
  return (
    Number(entry.fromChapter) !== meta.from ||
    Number(entry.toChapter) !== meta.to ||
    Number(entry.chapterCount) !== meta.count
  );
}

function syncSeriesMetaFromDoc(seriesEntry, doc, { contentUpdatedAt = null } = {}) {
  const meta = chapterMetaFromDoc(doc);
  const patch = {
    fromChapter: meta.from,
    toChapter: meta.to,
    chapterCount: meta.count,
    subtitle: `Ch. ${meta.from}\u2013${meta.to} · ${seriesEntry.dataFile}`,
  };
  if (contentUpdatedAt) {
    patch.contentUpdatedAt = contentUpdatedAt;
  }
  return { ...seriesEntry, ...patch };
}

function applyCatalogSeriesFromDoc(catalog, dataFile, doc, { bumpTimestamp = false } = {}) {
  const idx = catalog.series.findIndex((it) => it.dataFile === dataFile);
  if (idx < 0) return false;
  const stale = catalogMetaDiffers(catalog.series[idx], chapterMetaFromDoc(doc));
  if (!stale && !bumpTimestamp) return false;
  catalog.series[idx] = syncSeriesMetaFromDoc(catalog.series[idx], doc, {
    contentUpdatedAt: bumpTimestamp ? new Date().toISOString() : null,
  });
  return true;
}

async function reconcileFeaturedCatalogFromJson(catalog, featured) {
  let updated = 0;
  for (const s of featured) {
    const dataFile = String(s?.dataFile || "").trim();
    if (!dataFile) continue;
    const dataAbs = resolve(process.cwd(), "data-json", dataFile);
    let doc;
    try {
      doc = await readJson(dataAbs);
    } catch {
      continue;
    }
    if (applyCatalogSeriesFromDoc(catalog, dataFile, doc)) updated++;
  }
  return updated;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function fileMtimeMs(path) {
  try {
    const st = await stat(path);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

async function updateAsuraDoc(doc, delayMs, report) {
  if (!doc || !Array.isArray(doc.chapters) || !doc.sampleUrl) {
    return { added: 0, stoppedReason: "missing sampleUrl/chapters" };
  }
  report.sourceOk = true;

  const nums = doc.chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
  let currentMax = nums.length ? Math.max(...nums) : Number(doc.toChapter || 0);
  if (!Number.isFinite(currentMax) || currentMax < 0) currentMax = 0;

  let added = 0;
  let stoppedReason = "no new chapter";
  for (let n = currentMax + 1; n <= currentMax + 300; n++) {
    const url = buildAsuraChapterUrl(doc.sampleUrl, n);
    const result = await fetchAsuraImagesFromUrl(url);
    if (!result.ok) {
      stoppedReason = `HTTP ${result.status} at chapter ${n}`;
      break;
    }
    const finalNum = chapterNumFromAsuraUrl(result.finalUrl || "");
    if (!Number.isFinite(finalNum) || finalNum !== n) {
      stoppedReason = `redirect mismatch at chapter ${n}`;
      break;
    }
    const images = Array.isArray(result.images) ? result.images : [];
    if (!images.length) {
      stoppedReason = `no images at chapter ${n}`;
      break;
    }
    const label = String(n);
    doc.chapters.push({
      title: `Chapter ${n}`,
      chapter: n,
      url,
      finalUrl: result.finalUrl || url,
      total: images.length,
      images,
    });
    added++;
    report.newChapterLabels.push(label);
    report.loaded.push({ label, status: "done" });
    if (delayMs > 0) await sleep(delayMs);
  }

  if (added > 0) {
    doc.chapters.sort((a, b) => chapterNumberOf(a, 0) - chapterNumberOf(b, 0));
    const newNums = doc.chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
    doc.fromChapter = Math.min(...newNums);
    doc.toChapter = Math.max(...newNums);
    doc.fetchedAt = new Date().toISOString();
    report.newChapterLabels = sortChapterLabels(report.newChapterLabels);
  }
  return { added, stoppedReason };
}

function slugFromKunmangaSampleUrl(sampleUrl) {
  try {
    const parts = new URL(sampleUrl).pathname.split("/").filter(Boolean);
    const mangaIdx = parts.findIndex((p) => p === "manga");
    return mangaIdx >= 0 && parts[mangaIdx + 1] ? parts[mangaIdx + 1] : "";
  } catch {
    return "";
  }
}

function ingestCrawlerLine(line, result) {
  const raw = String(line || "")
    .replace(/^\r+/, "")
    .trim();
  if (!raw) return;

  if (
    /^Fetch (series|chapter|reader|home)/i.test(raw) ||
    /^Merge mode:/i.test(raw) ||
    /^Cần fetch/i.test(raw) ||
    /^Không có chương mới cần tải/i.test(raw) ||
    /^--merge:/i.test(raw)
  ) {
    result.sourceOk = true;
  }

  if (/^Skip write:/i.test(raw)) {
    result.skipWrite = true;
    result.sourceOk = true;
  }
  if (/^Wrote\s+\d+/i.test(raw)) {
    result.wrote = true;
    result.sourceOk = true;
  }

  const failM = raw.match(/^!\s*Ch\.([^:]+):\s*(.+)$/i);
  if (failM) {
    if (!result.failedAttempts) result.failedAttempts = [];
    result.failedAttempts.push({
      label: failM[1].trim(),
      error: failM[2].trim(),
    });
    result.sourceOk = true;
    return;
  }

  const progressM = raw.match(/^\[(\d+)\/(\d+)\]\s*(.*)$/);
  if (progressM) {
    const label = chapterLabelFromCrawlerExtra(progressM[3]);
    if (!result.attemptedFetchLabels) result.attemptedFetchLabels = [];
    if (!result.attemptedFetchLabels.includes(label)) {
      result.attemptedFetchLabels.push(label);
    }
    result.sourceOk = true;
  }
}

function runNodeScript(args) {
  return new Promise((resolve, reject) => {
    const result = {
      sourceOk: false,
      skipWrite: false,
      wrote: false,
      failedAttempts: [],
      attemptedFetchLabels: [],
      error: null,
    };

    const child = spawn("node", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const handleChunk = (chunk) => {
      const text = String(chunk || "");
      for (const part of text.split(/\r|\n/)) {
        ingestCrawlerLine(part, result);
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    child.on("error", (err) => {
      result.error = err.message || String(err);
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(result);
        return;
      }
      result.error = result.error || `Crawler kết thúc với mã lỗi ${code}`;
      reject(new Error(result.error));
    });
  });
}

function chapterStats(doc) {
  const chapters = Array.isArray(doc.chapters) ? doc.chapters : [];
  const nums = chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
  return {
    count: chapters.length,
    to: nums.length ? Math.max(...nums) : Number(doc.toChapter || 0),
  };
}

function finalizeCrawlerReport(report, beforeDoc, afterDoc, crawlResult, jsonWasWritten) {
  report.sourceOk = crawlResult.sourceOk;
  if (crawlResult.error) report.error = crawlResult.error;

  const newLabels = jsonWasWritten ? findNewChapterLabels(beforeDoc, afterDoc) : [];
  report.newChapterLabels = newLabels.length ? newLabels : [];
  report.loaded = report.newChapterLabels.map((label) => ({
    label,
    status: "done",
  }));

  if (!report.newChapterLabels.length) {
    if (crawlResult.failedAttempts?.length) {
      report.retryWithoutImages = sortChapterLabels(
        crawlResult.failedAttempts.map((row) => row.label)
      );
    } else if (
      crawlResult.skipWrite &&
      crawlResult.attemptedFetchLabels?.length
    ) {
      report.retryWithoutImages = sortChapterLabels(
        crawlResult.attemptedFetchLabels
      );
    }
  }

  report.jsonUpdated = jsonWasWritten && report.newChapterLabels.length > 0;
  report.jsonSkipped = !report.jsonUpdated;
  logSeriesSyncReport(report);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const catalogAbs = resolve(process.cwd(), args.catalogPath);
  const catalog = await readJson(catalogAbs);
  if (!catalog || !Array.isArray(catalog.series)) {
    throw new Error("manhwa-catalog.json thiếu mảng series");
  }

  let featured = catalog.series.filter((s) => s && s.featured === true);
  if (args.limit != null) featured = featured.slice(0, args.limit);
  if (!featured.length) {
    console.log("Không có bộ truyện nào được đánh dấu featured trong catalog.");
    return;
  }

  logLine("");
  logLine("════════════════════════════════════════");
  logLine("  Comic Hub · Cập nhật bộ featured");
  logLine(`  ${featured.length} bộ · ${args.dryRun ? "chế độ xem trước (không ghi file)" : "sẽ ghi file"}`);
  logLine("════════════════════════════════════════");

  let touchedSeries = 0;
  let totalAdded = 0;
  let skipped = 0;
  let failed = 0;
  let catalogDirty = false;
  let catalogReconciled = 0;

  if (!args.dryRun) {
    catalogReconciled = await reconcileFeaturedCatalogFromJson(catalog, featured);
    if (catalogReconciled > 0) {
      catalogDirty = true;
      logLine("");
      logLine(`  Đồng bộ catalog từ JSON: ${catalogReconciled} bộ featured cần chỉnh số chương`);
    }
  }

  for (let si = 0; si < featured.length; si++) {
    const s = featured[si];
    const source = normalizeSource(s.source);
    const dataFile = String(s.dataFile || "").trim();
    const title = String(s.displayTitle || s.title || dataFile || "Không tên");

    if (!dataFile) {
      logSeriesHeader(si + 1, featured.length, title, sourceLabel(source), "(thiếu dataFile)");
      logSeriesSyncReport({
        sourceOk: false,
        newChapterLabels: [],
        loaded: [],
        jsonUpdated: false,
        jsonSkipped: true,
        error: "catalog không có tên file JSON",
      });
      skipped++;
      continue;
    }

    const dataAbs = resolve(process.cwd(), "data-json", dataFile);
    logSeriesHeader(si + 1, featured.length, title, sourceLabel(source), dataFile);

    let doc;
    try {
      doc = await readJson(dataAbs);
    } catch {
      logSeriesSyncReport({
        sourceOk: false,
        newChapterLabels: [],
        loaded: [],
        jsonUpdated: false,
        jsonSkipped: true,
        error: `không đọc được data-json/${dataFile}`,
      });
      skipped++;
      continue;
    }

    const beforeDoc = doc;
    const before = chapterStats(doc);
    const beforeTo = before.to;
    const beforeCount = before.count;
    let seriesChanged = false;
    const report = createSeriesSyncReport();

    try {
      if (source === "asura") {
        if (!doc.sampleUrl) {
          report.error = "thiếu sampleUrl trong file JSON";
          logSeriesSyncReport(report);
          skipped++;
          continue;
        }
        if (args.dryRun) {
          report.sourceOk = true;
          logSeriesSyncReport(report);
          continue;
        }
        const rs = await updateAsuraDoc(doc, args.delayMs, report);
        if (rs.added > 0) {
          await writeJson(dataAbs, doc);
          report.jsonUpdated = true;
          report.jsonSkipped = false;
          seriesChanged = true;
          touchedSeries++;
          totalAdded += rs.added;
        } else {
          report.jsonUpdated = false;
          report.jsonSkipped = true;
          report.loaded = [];
        }
        logSeriesSyncReport(report);
      } else if (source === "mgeko") {
        if (!doc.sampleUrl) {
          report.error = "thiếu sampleUrl trong file JSON";
          logSeriesSyncReport(report);
          skipped++;
          continue;
        }
        if (args.dryRun) {
          report.sourceOk = true;
          logSeriesSyncReport(report);
          continue;
        }
        const mtimeBefore = await fileMtimeMs(dataAbs);
        const crawl = await runNodeScript([
          "crawl-mgeko-series.js",
          doc.sampleUrl,
          "--out",
          `data-json/${dataFile}`,
          "--no-catalog",
          "--concurrency",
          String(args.concurrency),
        ]);
        const mtimeAfter = await fileMtimeMs(dataAbs);
        const jsonWasWritten = crawl.wrote || (mtimeBefore != null && mtimeAfter != null && mtimeAfter > mtimeBefore);
        doc = await readJson(dataAbs);
        const after = chapterStats(doc);
        const newLabels = jsonWasWritten
          ? findNewChapterLabels(beforeDoc, doc)
          : [];
        const added = newLabels.length;
        if (added > 0) {
          seriesChanged = true;
          touchedSeries++;
          totalAdded += added;
        }
        finalizeCrawlerReport(report, beforeDoc, doc, crawl, jsonWasWritten);
      } else if (source === "kunmanga") {
        const sample = String(doc.sampleUrl || "").trim();
        const slug = slugFromKunmangaSampleUrl(sample);
        if (!slug) {
          report.error = "không đọc được slug KunManga từ sampleUrl";
          logSeriesSyncReport(report);
          skipped++;
          continue;
        }
        if (args.dryRun) {
          report.sourceOk = true;
          logSeriesSyncReport(report);
          continue;
        }
        let origin = "https://www.kunmanga.online";
        try {
          origin = new URL(sample).origin || origin;
        } catch {
          /* default */
        }
        const mtimeBefore = await fileMtimeMs(dataAbs);
        const crawl = await runNodeScript([
          "crawl-kunmanga-series.js",
          "--slug",
          slug,
          "--origin",
          origin,
          "--out",
          `data-json/${dataFile}`,
          "--merge",
          "--no-catalog",
        ]);
        const mtimeAfter = await fileMtimeMs(dataAbs);
        const jsonWasWritten = crawl.wrote || (mtimeBefore != null && mtimeAfter != null && mtimeAfter > mtimeBefore);
        doc = await readJson(dataAbs);
        const newLabels = jsonWasWritten
          ? findNewChapterLabels(beforeDoc, doc)
          : [];
        const added = newLabels.length;
        if (added > 0) {
          seriesChanged = true;
          touchedSeries++;
          totalAdded += added;
        }
        finalizeCrawlerReport(report, beforeDoc, doc, crawl, jsonWasWritten);
      } else if (source === "onepunchmantruyen") {
        const sample = String(doc.sampleUrl || "").trim();
        const home = String(doc.homeUrl || "").trim();
        const seriesUrl = home || sample;
        if (!seriesUrl) {
          report.error = "thiếu homeUrl hoặc sampleUrl";
          logSeriesSyncReport(report);
          skipped++;
          continue;
        }
        if (args.dryRun) {
          report.sourceOk = true;
          logSeriesSyncReport(report);
          continue;
        }
        const mtimeBefore = await fileMtimeMs(dataAbs);
        const crawl = await runNodeScript([
          "crawl-onepunchmantruyen-series.js",
          seriesUrl,
          "--out",
          `data-json/${dataFile}`,
          "--no-catalog",
          "--concurrency",
          String(args.concurrency),
        ]);
        const mtimeAfter = await fileMtimeMs(dataAbs);
        const jsonWasWritten = crawl.wrote || (mtimeBefore != null && mtimeAfter != null && mtimeAfter > mtimeBefore);
        doc = await readJson(dataAbs);
        const newLabels = jsonWasWritten
          ? findNewChapterLabels(beforeDoc, doc)
          : [];
        const added = newLabels.length;
        if (added > 0) {
          seriesChanged = true;
          touchedSeries++;
          totalAdded += added;
        }
        finalizeCrawlerReport(report, beforeDoc, doc, crawl, jsonWasWritten);
      } else if (source === "onepunchmanmau") {
        const sample = String(doc.sampleUrl || s.sampleUrl || "").trim();
        if (!sample) {
          report.error = "thiếu sampleUrl trong file JSON";
          logSeriesSyncReport(report);
          skipped++;
          continue;
        }
        if (args.dryRun) {
          report.sourceOk = true;
          logSeriesSyncReport(report);
          continue;
        }
        const mtimeBefore = await fileMtimeMs(dataAbs);
        const crawl = await runNodeScript([
          "crawl-onepunchmanmau-series.js",
          sample,
          "--out",
          `data-json/${dataFile}`,
          "--no-catalog",
          "--concurrency",
          String(args.concurrency),
          "--keep-legacy",
        ]);
        const mtimeAfter = await fileMtimeMs(dataAbs);
        const jsonWasWritten = crawl.wrote || (mtimeBefore != null && mtimeAfter != null && mtimeAfter > mtimeBefore);
        doc = await readJson(dataAbs);
        const newLabels = jsonWasWritten
          ? findNewChapterLabels(beforeDoc, doc)
          : [];
        const added = newLabels.length;
        if (added > 0) {
          seriesChanged = true;
          touchedSeries++;
          totalAdded += added;
        }
        finalizeCrawlerReport(report, beforeDoc, doc, crawl, jsonWasWritten);
      } else if (source === "truyenonepiece") {
        const sample = String(doc.sampleUrl || s.sampleUrl || "").trim();
        const home = String(doc.homeUrl || "").trim();
        const seriesUrl = home || sample;
        if (!seriesUrl) {
          report.error = "thiếu homeUrl hoặc sampleUrl";
          logSeriesSyncReport(report);
          skipped++;
          continue;
        }
        if (args.dryRun) {
          report.sourceOk = true;
          logSeriesSyncReport(report);
          continue;
        }
        const mtimeBefore = await fileMtimeMs(dataAbs);
        const crawl = await runNodeScript([
          "crawl-truyen-one-piece-series.js",
          seriesUrl,
          "--out",
          `data-json/${dataFile}`,
          "--no-catalog",
          "--concurrency",
          String(args.concurrency),
        ]);
        const mtimeAfter = await fileMtimeMs(dataAbs);
        const jsonWasWritten = crawl.wrote || (mtimeBefore != null && mtimeAfter != null && mtimeAfter > mtimeBefore);
        doc = await readJson(dataAbs);
        const newLabels = jsonWasWritten
          ? findNewChapterLabels(beforeDoc, doc)
          : [];
        const added = newLabels.length;
        if (added > 0) {
          seriesChanged = true;
          touchedSeries++;
          totalAdded += added;
        }
        finalizeCrawlerReport(report, beforeDoc, doc, crawl, jsonWasWritten);
      } else {
        report.error = `nguồn "${s.source}" chưa được hỗ trợ`;
        logSeriesSyncReport(report);
        skipped++;
        continue;
      }
    } catch (err) {
      failed++;
      report.sourceOk = report.sourceOk || false;
      report.error = err.message || String(err);
      report.jsonUpdated = false;
      report.jsonSkipped = true;
      logSeriesSyncReport(report);
      continue;
    }

    const idx = catalog.series.findIndex((it) => it.dataFile === dataFile);
    if (idx >= 0 && !args.dryRun) {
      const bumped = applyCatalogSeriesFromDoc(catalog, dataFile, doc, {
        bumpTimestamp: seriesChanged,
      });
      if (bumped) catalogDirty = true;
    }
  }

  if (!args.dryRun && catalogDirty) {
    catalog.updatedAt = new Date().toISOString();
    await writeJson(catalogAbs, catalog);
    logLine("");
    logLine(`  Đã lưu ${args.catalogPath}`);
  } else if (!args.dryRun) {
    logLine("");
    logLine("  Không có thay đổi — giữ nguyên catalog");
  }

  logLine("");
  logLine("────────────────────────────────────────");
  if (args.dryRun) {
    console.log(
      `Hoàn tất (dry-run): ${featured.length} bộ featured · ước tính thêm ${totalAdded} chương · bỏ qua ${skipped} · lỗi ${failed}`
    );
  } else {
    console.log(
      `Hoàn tất: ${featured.length} bộ featured · cập nhật ${touchedSeries} bộ · thêm ${totalAdded} chương mới · bỏ qua ${skipped} · lỗi ${failed}`
    );
  }
  logLine("────────────────────────────────────────");
}

main().catch((err) => {
  logLine("");
  logLine(`✗ Lỗi: ${humanizeErrorMessage(err.message || err)}`);
  process.exit(1);
});
