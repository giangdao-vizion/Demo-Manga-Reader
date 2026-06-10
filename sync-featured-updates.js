#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { fetchAsuraImagesFromUrl } from "./extract.mjs";
import {
  SOURCE_LABELS,
  describeAsuraStop,
  formatCrawlerLine,
  humanizeErrorMessage,
  logLine,
  logSeriesHeader,
  summarizeChapterDelta,
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

function syncSeriesMetaFromDoc(seriesEntry, doc) {
  const nums = (doc.chapters || [])
    .map((c, i) => chapterNumberOf(c, i))
    .filter((n) => Number.isFinite(n));
  const from = nums.length ? Math.min(...nums) : seriesEntry.fromChapter;
  const to = nums.length ? Math.max(...nums) : seriesEntry.toChapter;
  const count = (doc.chapters || []).length || Number(seriesEntry.chapterCount || 0);
  const contentUpdatedAt =
    doc.fetchedAt || seriesEntry.contentUpdatedAt || seriesEntry.updatedAt || null;
  return {
    ...seriesEntry,
    fromChapter: from,
    toChapter: to,
    chapterCount: count,
    subtitle: `Ch. ${from}\u2013${to} · ${seriesEntry.dataFile}`,
    ...(contentUpdatedAt ? { contentUpdatedAt } : {}),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function updateAsuraDoc(doc, delayMs) {
  if (!doc || !Array.isArray(doc.chapters) || !doc.sampleUrl) {
    return { added: 0, stoppedReason: "missing sampleUrl/chapters" };
  }
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
    doc.chapters.push({
      title: `Chapter ${n}`,
      chapter: n,
      url,
      finalUrl: result.finalUrl || url,
      total: images.length,
      images,
    });
    added++;
    logLine(`  + Ch.${n} · ${images.length} ảnh`);
    if (delayMs > 0) await sleep(delayMs);
  }

  if (added > 0) {
    doc.chapters.sort((a, b) => chapterNumberOf(a, 0) - chapterNumberOf(b, 0));
    const newNums = doc.chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
    doc.fromChapter = Math.min(...newNums);
    doc.toChapter = Math.max(...newNums);
    doc.fetchedAt = new Date().toISOString();
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

function runNodeScript(args, actionLabel) {
  logLine(`  ▶ ${actionLabel}`);
  const started = Date.now();
  let lastProgress = "";
  let lastHeartbeat = started;

  return new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const handleChunk = (chunk) => {
      const now = Date.now();
      if (now - lastHeartbeat > 15000 && !lastProgress) {
        const sec = Math.round((now - started) / 1000);
        logLine(`  · Vẫn đang chạy… (${sec}s — thường đang đọc danh sách chương từ site)`);
        lastHeartbeat = now;
      }

      const text = String(chunk || "");
      for (const part of text.split(/\r|\n/)) {
        const formatted = formatCrawlerLine(part);
        if (!formatted) continue;
        lastHeartbeat = now;
        if (formatted.kind === "progress") {
          process.stderr.write(`\r${formatted.text.padEnd(72)}`);
          lastProgress = formatted.text;
        } else {
          if (lastProgress) {
            process.stderr.write("\n");
            lastProgress = "";
          }
          logLine(formatted.text);
        }
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      if (lastProgress) process.stderr.write("\n");
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Crawler kết thúc với mã lỗi ${code}`));
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

  for (let si = 0; si < featured.length; si++) {
    const s = featured[si];
    const source = normalizeSource(s.source);
    const dataFile = String(s.dataFile || "").trim();
    const title = String(s.displayTitle || s.title || dataFile || "Không tên");

    if (!dataFile) {
      logSeriesHeader(si + 1, featured.length, title, sourceLabel(source), "(thiếu dataFile)");
      logLine("  ⊘ Bỏ qua: catalog không có tên file JSON");
      skipped++;
      continue;
    }

    const dataAbs = resolve(process.cwd(), "data-json", dataFile);
    logSeriesHeader(si + 1, featured.length, title, sourceLabel(source), dataFile);

    let doc;
    try {
      doc = await readJson(dataAbs);
    } catch {
      logLine(`  ⊘ Bỏ qua: không đọc được data-json/${dataFile}`);
      skipped++;
      continue;
    }

    const before = chapterStats(doc);
    const beforeTo = before.to;
    const beforeCount = before.count;
    let seriesChanged = false;

    try {
      if (source === "asura") {
        if (!doc.sampleUrl) {
          logLine("  ⊘ Bỏ qua: thiếu sampleUrl trong file JSON");
          skipped++;
          continue;
        }
        if (args.dryRun) {
          logLine("  ○ Dry-run: sẽ quét chương mới Asura (không ghi file)");
          continue;
        }
        logLine("  ▶ Quét chương mới trên Asura…");
        const rs = await updateAsuraDoc(doc, args.delayMs);
        logLine(`  → ${describeAsuraStop(rs.stoppedReason)}`);
        if (rs.added > 0) {
          await writeJson(dataAbs, doc);
          touchedSeries++;
          totalAdded += rs.added;
          seriesChanged = true;
          catalogDirty = true;
          logLine(`  ✓ ${summarizeChapterDelta(beforeTo, doc.toChapter, beforeCount, doc.chapters.length)}`);
        } else {
          logLine("  · Không có chương mới — giữ nguyên file JSON");
        }
      } else if (source === "mgeko") {
        if (!doc.sampleUrl) {
          logLine("  ⊘ Bỏ qua: thiếu sampleUrl trong file JSON");
          skipped++;
          continue;
        }
        if (args.dryRun) {
          logLine("  ○ Dry-run: sẽ đồng bộ từ MGEKO (không ghi file)");
          continue;
        }
        await runNodeScript(
          [
            "crawl-mgeko-series.js",
            doc.sampleUrl,
            "--out",
            `data-json/${dataFile}`,
            "--no-catalog",
            "--concurrency",
            String(args.concurrency),
          ],
          "Kiểm tra chương mới trên MGEKO (giữ nguyên chương đã có ảnh)"
        );
        doc = await readJson(dataAbs);
        const after = chapterStats(doc);
        const added = Math.max(0, after.to - beforeTo, after.count - beforeCount);
        if (added > 0) {
          touchedSeries++;
          totalAdded += added;
          seriesChanged = true;
          catalogDirty = true;
          logLine(`  ✓ ${summarizeChapterDelta(beforeTo, after.to, beforeCount, after.count)}`);
        } else {
          logLine("  · Không có chương mới — giữ nguyên file JSON");
        }
      } else if (source === "kunmanga") {
        const sample = String(doc.sampleUrl || "").trim();
        const slug = slugFromKunmangaSampleUrl(sample);
        if (!slug) {
          logLine("  ⊘ Bỏ qua: không đọc được slug KunManga từ sampleUrl");
          skipped++;
          continue;
        }
        if (args.dryRun) {
          logLine("  ○ Dry-run: sẽ đồng bộ từ KunManga (không ghi file)");
          continue;
        }
        let origin = "https://www.kunmanga.online";
        try {
          origin = new URL(sample).origin || origin;
        } catch {
          /* default */
        }
        await runNodeScript(
          [
            "crawl-kunmanga-series.js",
            "--slug",
            slug,
            "--origin",
            origin,
            "--out",
            `data-json/${dataFile}`,
            "--merge",
            "--no-catalog",
          ],
          "Đồng bộ chapter từ KunManga (merge)"
        );
        doc = await readJson(dataAbs);
        const after = chapterStats(doc);
        const added = Math.max(0, after.to - beforeTo, after.count - beforeCount);
        if (added > 0) {
          touchedSeries++;
          totalAdded += added;
          seriesChanged = true;
          catalogDirty = true;
          logLine(`  ✓ ${summarizeChapterDelta(beforeTo, after.to, beforeCount, after.count)}`);
        } else {
          logLine("  · Không có chương mới — giữ nguyên file JSON");
        }
      } else if (source === "onepunchmantruyen") {
        const sample = String(doc.sampleUrl || "").trim();
        const home = String(doc.homeUrl || "").trim();
        const seriesUrl = home || sample;
        if (!seriesUrl) {
          logLine("  ⊘ Bỏ qua: thiếu homeUrl hoặc sampleUrl");
          skipped++;
          continue;
        }
        if (args.dryRun) {
          logLine("  ○ Dry-run: sẽ crawl OnePunchManTruyen (không ghi file)");
          continue;
        }
        await runNodeScript(
          [
            "crawl-onepunchmantruyen-series.js",
            seriesUrl,
            "--out",
            `data-json/${dataFile}`,
            "--no-catalog",
            "--concurrency",
            String(args.concurrency),
          ],
          "Crawl lại từ OnePunchManTruyen"
        );
        doc = await readJson(dataAbs);
        const after = chapterStats(doc);
        const added = Math.max(0, after.to - beforeTo, after.count - beforeCount);
        if (added > 0) {
          touchedSeries++;
          totalAdded += added;
          seriesChanged = true;
          catalogDirty = true;
          logLine(`  ✓ ${summarizeChapterDelta(beforeTo, after.to, beforeCount, after.count)}`);
        } else {
          logLine("  · Không có chương mới — giữ nguyên file JSON");
        }
      } else if (source === "onepunchmanmau") {
        const sample = String(doc.sampleUrl || s.sampleUrl || "").trim();
        if (!sample) {
          logLine("  ⊘ Bỏ qua: thiếu sampleUrl trong file JSON");
          skipped++;
          continue;
        }
        if (args.dryRun) {
          logLine("  ○ Dry-run: sẽ crawl OnePunchManMau.com (không ghi file)");
          continue;
        }
        await runNodeScript(
          [
            "crawl-onepunchmanmau-series.js",
            sample,
            "--out",
            `data-json/${dataFile}`,
            "--no-catalog",
            "--concurrency",
            String(args.concurrency),
            "--keep-legacy",
          ],
          "Kiểm tra chương mới trên OnePunchManMau.com (giữ nguyên chương đã có ảnh)"
        );
        doc = await readJson(dataAbs);
        const after = chapterStats(doc);
        const added = Math.max(0, after.to - beforeTo, after.count - beforeCount);
        if (added > 0) {
          touchedSeries++;
          totalAdded += added;
          seriesChanged = true;
          catalogDirty = true;
          logLine(`  ✓ ${summarizeChapterDelta(beforeTo, after.to, beforeCount, after.count)}`);
        } else {
          logLine("  · Không có chương mới — giữ nguyên file JSON");
        }
      } else if (source === "truyenonepiece") {
        const sample = String(doc.sampleUrl || s.sampleUrl || "").trim();
        const home = String(doc.homeUrl || "").trim();
        const seriesUrl = home || sample;
        if (!seriesUrl) {
          logLine("  ⊘ Bỏ qua: thiếu homeUrl hoặc sampleUrl");
          skipped++;
          continue;
        }
        if (args.dryRun) {
          logLine("  ○ Dry-run: sẽ crawl Truyen-One-Piece (không ghi file)");
          continue;
        }
        await runNodeScript(
          [
            "crawl-truyen-one-piece-series.js",
            seriesUrl,
            "--out",
            `data-json/${dataFile}`,
            "--no-catalog",
            "--concurrency",
            String(args.concurrency),
          ],
          "Kiểm tra chương mới trên Truyen-One-Piece.com (giữ nguyên chương đã có ảnh)"
        );
        doc = await readJson(dataAbs);
        const after = chapterStats(doc);
        const added = Math.max(0, after.to - beforeTo, after.count - beforeCount);
        if (added > 0) {
          touchedSeries++;
          totalAdded += added;
          seriesChanged = true;
          catalogDirty = true;
          logLine(`  ✓ ${summarizeChapterDelta(beforeTo, after.to, beforeCount, after.count)}`);
        } else {
          logLine("  · Không có chương mới — giữ nguyên file JSON");
        }
      } else {
        logLine(`  ⊘ Bỏ qua: nguồn "${s.source}" chưa được hỗ trợ trong featured:sync`);
        skipped++;
        continue;
      }
    } catch {
      failed++;
      logLine("  ✗ Lỗi khi cập nhật bộ này (xem chi tiết phía trên)");
      continue;
    }

    const idx = catalog.series.findIndex((it) => it.dataFile === dataFile);
    if (idx >= 0 && !args.dryRun && seriesChanged) {
      catalog.series[idx] = syncSeriesMetaFromDoc(catalog.series[idx], doc);
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
