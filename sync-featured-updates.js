#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { fetchAsuraImagesFromUrl } from "./extract.mjs";

const execFile = promisify(execFileCb);
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
  return s;
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
  const count = nums.length || Number(seriesEntry.chapterCount || 0);
  return {
    ...seriesEntry,
    fromChapter: from,
    toChapter: to,
    chapterCount: count,
    subtitle: `Ch. ${from}\u2013${to} · ${seriesEntry.dataFile}`,
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
    process.stderr.write(`  + asura ch.${n} (${images.length} ảnh)\n`);
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

async function runNodeScript(args) {
  const { stdout, stderr } = await execFile("node", args, {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 10,
  });
  if (stdout && stdout.trim()) process.stderr.write(stdout.trim() + "\n");
  if (stderr && stderr.trim()) process.stderr.write(stderr.trim() + "\n");
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
    console.log("Không có bộ featured nào để cập nhật.");
    return;
  }

  let touchedSeries = 0;
  let totalAdded = 0;
  for (const s of featured) {
    const source = normalizeSource(s.source);
    const dataFile = String(s.dataFile || "").trim();
    if (!dataFile) continue;
    const dataAbs = resolve(process.cwd(), "data-json", dataFile);

    process.stderr.write(`\n[${s.title}] source=${source}\n`);

    let doc;
    try {
      doc = await readJson(dataAbs);
    } catch {
      process.stderr.write("  ! skip: không đọc được file data-json\n");
      continue;
    }
    const beforeTo = Number(doc.toChapter || 0);

    if (source === "asura") {
      const rs = await updateAsuraDoc(doc, args.delayMs);
      process.stderr.write(`  -> ${rs.stoppedReason}\n`);
      if (rs.added > 0) {
        touchedSeries++;
        totalAdded += rs.added;
        if (!args.dryRun) await writeJson(dataAbs, doc);
      }
    } else if (source === "mgeko") {
      if (!doc.sampleUrl) {
        process.stderr.write("  ! skip: thiếu sampleUrl trong data json\n");
        continue;
      }
      if (args.dryRun) {
        process.stderr.write("  ~ dry-run: bỏ qua crawl mgeko (không ghi file)\n");
        continue;
      }
      await runNodeScript([
        "crawl-mgeko-series.js",
        doc.sampleUrl,
        "--out",
        `data-json/${dataFile}`,
        "--no-catalog",
        "--concurrency",
        String(args.concurrency),
      ]);
      doc = await readJson(dataAbs);
      const added = Math.max(0, Number(doc.toChapter || 0) - beforeTo);
      if (added > 0) {
        touchedSeries++;
        totalAdded += added;
      }
    } else if (source === "kunmanga") {
      const sample = String(doc.sampleUrl || "").trim();
      const slug = slugFromKunmangaSampleUrl(sample);
      if (!slug) {
        process.stderr.write("  ! skip: không parse được slug kunmanga\n");
        continue;
      }
      if (args.dryRun) {
        process.stderr.write("  ~ dry-run: bỏ qua crawl kunmanga (không ghi file)\n");
        continue;
      }
      let origin = "https://www.kunmanga.online";
      try {
        origin = new URL(sample).origin || origin;
      } catch {
        /* default origin */
      }
      await runNodeScript([
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
      doc = await readJson(dataAbs);
      const added = Math.max(0, Number(doc.toChapter || 0) - beforeTo);
      if (added > 0) {
        touchedSeries++;
        totalAdded += added;
      }
    } else if (source === "onepunchmantruyen") {
      const sample = String(doc.sampleUrl || s.sampleUrl || "").trim();
      const home = String(doc.homeUrl || "").trim();
      const seriesUrl = home || sample;
      if (!seriesUrl) {
        process.stderr.write("  ! skip: thiếu homeUrl/sampleUrl trong data json\n");
        continue;
      }
      if (args.dryRun) {
        process.stderr.write("  ~ dry-run: bỏ qua crawl onepunchmantruyen (không ghi file)\n");
        continue;
      }
      await runNodeScript([
        "crawl-onepunchmantruyen-series.js",
        seriesUrl,
        "--out",
        `data-json/${dataFile}`,
        "--no-catalog",
        "--concurrency",
        String(args.concurrency),
      ]);
      doc = await readJson(dataAbs);
      const added = Math.max(0, Number(doc.toChapter || 0) - beforeTo);
      if (added > 0) {
        touchedSeries++;
        totalAdded += added;
      }
    } else {
      process.stderr.write(`  ! skip: source chưa hỗ trợ (${s.source})\n`);
      continue;
    }

    const idx = catalog.series.findIndex((it) => it.dataFile === dataFile);
    if (idx >= 0) {
      catalog.series[idx] = syncSeriesMetaFromDoc(catalog.series[idx], doc);
    }
  }

  if (!args.dryRun) {
    catalog.updatedAt = new Date().toISOString();
    await writeJson(catalogAbs, catalog);
  }

  console.log(
    args.dryRun
      ? `[dry-run] xong: ${featured.length} bộ featured, có thể thêm ${totalAdded} chapter mới`
      : `xong: ${featured.length} bộ featured, đã cập nhật ${touchedSeries} bộ, thêm ${totalAdded} chapter mới`
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
