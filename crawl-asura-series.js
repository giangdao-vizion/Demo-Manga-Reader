#!/usr/bin/env node
/**
 * Crawl full series từ Asura Scans (trang series hoặc chapter sample).
 *
 * Usage:
 *   node crawl-asura-series.js "https://asurascans.com/comics/slug-xxxx"
 *   node crawl-asura-series.js "<series-or-chapter-url>" --out data-json/foo.json --title "Title"
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { BROWSER_HEADERS, fetchAsuraImagesFromUrl } from "./extract.mjs";
import {
  buildAsuraChapterUrl,
  extractChapterNumbersFromSeriesHtml,
} from "./catalog/lib/asura-chapter-index.js";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_SOURCE = "asura";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <series-or-chapter-url> [options]

Options:
  --out PATH          Mặc định: data-json/<slug>.json
  --title TITLE       Tên hiển thị trong JSON + catalog
  --catalog PATH      Mặc định: manhwa-catalog.json
  --no-catalog        Không cập nhật catalog
  --concurrency N     Fetch song song N chapter (mặc định: ${DEFAULT_CONCURRENCY})
  --featured          Gắn featured=true trong catalog
  --force             Tải lại toàn bộ chapter (bỏ merge)
`);
}

function parseArgs(argv) {
  const out = {
    url: "",
    outPath: "",
    title: "",
    catalogPath: "manhwa-catalog.json",
    updateCatalog: true,
    concurrency: DEFAULT_CONCURRENCY,
    featured: false,
    force: false,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--out" && argv[i + 1]) out.outPath = String(argv[++i]).trim();
    else if (a === "--title" && argv[i + 1]) out.title = String(argv[++i]).trim();
    else if (a === "--catalog" && argv[i + 1]) out.catalogPath = String(argv[++i]).trim();
    else if (a === "--no-catalog") out.updateCatalog = false;
    else if (a === "--concurrency" && argv[i + 1]) out.concurrency = Number(argv[++i], 10);
    else if (a === "--featured") out.featured = true;
    else if (a === "--force") out.force = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  if (positional[0]) out.url = positional[0];
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = DEFAULT_CONCURRENCY;
  if (out.concurrency > 10) out.concurrency = 10;
  return out;
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.href;
  } catch {
    return String(u || "").trim();
  }
}

function seriesPathFromUrl(url) {
  try {
    const p = new URL(url).pathname.replace(/\/$/, "");
    const m = p.match(/^(\/comics\/[^/]+)/i);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function slugFromSeriesPath(seriesPath) {
  return String(seriesPath || "")
    .replace(/^\/comics\//i, "")
    .replace(/-[0-9a-f]{6,}$/i, "")
    .toLowerCase();
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return { html: await res.text(), finalUrl: res.url || url };
}

function extractSeriesMeta(html, baseUrl) {
  const $ = cheerio.load(html);
  let title =
    String($("h1").first().text() || "")
      .replace(/\s+/g, " ")
      .trim() || "";
  if (!title) {
    title = String($("title").first().text() || "")
      .split("|")[0]
      .trim();
  }
  let coverUrl = "";
  const og = String($("meta[property='og:image']").attr("content") || "").trim();
  if (og) {
    try {
      coverUrl = new URL(og, baseUrl).href;
    } catch {
      /* ignore */
    }
  }
  if (!coverUrl) {
    $("img").each((_, el) => {
      if (coverUrl) return;
      const src = String($(el).attr("src") || "").trim();
      if (/\/covers\//i.test(src)) {
        try {
          coverUrl = new URL(src, baseUrl).href;
        } catch {
          /* ignore */
        }
      }
    });
  }
  return { title, coverUrl };
}

function existingChapterLookup(existingDoc) {
  const byNum = new Map();
  if (!existingDoc || !Array.isArray(existingDoc.chapters)) return byNum;
  for (const ch of existingDoc.chapters) {
    if (!ch) continue;
    const n = Number.isFinite(ch.chapter) ? Number(ch.chapter) : NaN;
    if (Number.isFinite(n)) byNum.set(n, ch);
  }
  return byNum;
}

async function runPool(items, maxP, worker) {
  const results = new Array(items.length);
  let i = 0;
  let inFlight = 0;
  return new Promise((resolveDone) => {
    function pump() {
      while (inFlight < maxP && i < items.length) {
        const idx = i++;
        inFlight++;
        Promise.resolve(worker(items[idx], idx))
          .then((res) => {
            results[idx] = res;
          })
          .catch((err) => {
            results[idx] = { ok: false, error: err };
          })
          .finally(() => {
            inFlight--;
            if (i >= items.length && inFlight === 0) resolveDone(results);
            else pump();
          });
      }
    }
    if (!items.length) resolveDone(results);
    else pump();
  });
}

async function upsertCatalog(catalogAbs, outFileName, doc, opts) {
  const catalog = JSON.parse(await readFile(catalogAbs, "utf8"));
  if (!catalog || !Array.isArray(catalog.series)) throw new Error("catalog thiếu mảng series");

  const nums = (doc.chapters || [])
    .map((c) => Number(c.chapter))
    .filter(Number.isFinite);
  const from = nums.length ? Math.min(...nums) : 1;
  const to = nums.length ? Math.max(...nums) : from;
  const displayTitle = doc.title || "Unknown";
  const entry = {
    dataFile: outFileName,
    title: displayTitle,
    displayTitle,
    subtitle: `Ch. ${from}\u2013${to} · ${outFileName}`,
    source: DEFAULT_SOURCE,
    fromChapter: from,
    toChapter: to,
    chapterCount: doc.chapters.length,
    contentSyncNote: "Nguồn asurascans.com.",
    coverUrl: doc.coverUrl || null,
  };
  if (opts.featured === true) entry.featured = true;
  if (opts.bumpTimestamp) entry.contentUpdatedAt = new Date().toISOString();

  let idx = catalog.series.findIndex((s) => s && s.dataFile === outFileName);
  if (idx < 0) {
    const want = displayTitle.toLowerCase();
    idx = catalog.series.findIndex(
      (s) =>
        s &&
        String(s.source || "").toLowerCase() === DEFAULT_SOURCE &&
        String(s.title || "").trim().toLowerCase() === want
    );
  }
  if (idx >= 0) {
    const prev = catalog.series[idx];
    catalog.series[idx] = {
      ...prev,
      ...entry,
      title: prev.title || entry.title,
      displayTitle: prev.displayTitle || entry.displayTitle,
      sqliteSeriesId: prev.sqliteSeriesId ?? null,
      featured: opts.featured === true ? true : prev.featured === true,
    };
  } else {
    catalog.series.push({
      ...entry,
      sqliteSeriesId: null,
      contentSyncComplete: false,
      featured: opts.featured === true,
    });
  }

  catalog.updatedAt = new Date().toISOString();
  await writeFile(catalogAbs, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const seedUrl = normalizeUrl(args.url);
  const seriesPath = seriesPathFromUrl(seedUrl);
  if (!seriesPath) throw new Error("URL không phải trang comics Asura");

  const origin = new URL(seedUrl).origin;
  const seriesUrl = `${origin}${seriesPath}`;

  console.error(`Fetch series page: ${seriesUrl}`);
  const seed = await fetchHtml(seriesUrl);
  const meta = extractSeriesMeta(seed.html, seed.finalUrl);
  const chapterNums = extractChapterNumbersFromSeriesHtml(seed.html, seriesPath);
  if (!chapterNums.length) throw new Error("Không tìm thấy chapter trên trang series");

  const slug = slugFromSeriesPath(seriesPath);
  const outRel = args.outPath || `data-json/${slug}.json`;
  const outAbs = resolve(process.cwd(), outRel);
  const outFileName = outRel.split(/[/\\]/).pop();

  const existing = args.force ? null : await readJsonIfExists(outAbs);
  const byNum = existingChapterLookup(existing);

  let skipped = 0;
  const targets = [];
  for (const n of chapterNums) {
    const old = byNum.get(n);
    if (!args.force && old && Array.isArray(old.images) && old.images.length > 0) {
      skipped++;
      continue;
    }
    targets.push(n);
  }

  if (skipped > 0) console.error(`Merge mode: giữ lại ${skipped} chapter đã có ảnh.`);
  if (!targets.length) {
    console.error(`Không có chương mới cần tải (${skipped}/${chapterNums.length}).`);
    if (existing?.chapters?.length) {
      console.error("Skip write: không có chương mới cần cập nhật JSON.");
      return;
    }
  } else {
    console.error(
      `Cần fetch ${targets.length}/${chapterNums.length} chapter (concurrency=${args.concurrency}).`
    );
  }

  let progress = 0;
  const fetched = targets.length
    ? await runPool(targets, args.concurrency, async (n) => {
        const url = buildAsuraChapterUrl(seriesUrl, seriesPath, n);
        const result = await fetchAsuraImagesFromUrl(url);
        progress++;
        process.stderr.write(`\r[${progress}/${targets.length}] Ch.${n}`);
        const images = Array.isArray(result.images) ? result.images : [];
        return {
          chapter: n,
          url,
          finalUrl: result.finalUrl || url,
          images,
          ok: result.ok && images.length > 0,
          error: !result.ok
            ? `HTTP ${result.status}`
            : images.length
              ? null
              : "No chapter images",
        };
      })
    : [];
  if (targets.length > 0) process.stderr.write("\n");

  const fetchedByNum = new Map(fetched.map((r) => [r.chapter, r]));
  const chapters = [];
  for (const n of chapterNums) {
    const fromFetch = fetchedByNum.get(n);
    const fromCarry = byNum.get(n);
    if (fromFetch && fromFetch.ok) {
      chapters.push({
        title: `Chapter ${n}`,
        chapter: n,
        url: fromFetch.url,
        finalUrl: fromFetch.finalUrl,
        total: fromFetch.images.length,
        images: fromFetch.images,
      });
      continue;
    }
    if (fromFetch && fromFetch.error) {
      console.error(`  ! Ch.${n}: ${fromFetch.error}`);
    }
    if (fromCarry && Array.isArray(fromCarry.images) && fromCarry.images.length) {
      chapters.push({
        title: fromCarry.title || `Chapter ${n}`,
        chapter: n,
        url: fromCarry.url || buildAsuraChapterUrl(seriesUrl, seriesPath, n),
        finalUrl: fromCarry.finalUrl || fromCarry.url,
        total: fromCarry.images.length,
        images: fromCarry.images,
      });
    }
  }

  if (!chapters.length) throw new Error("Không lấy được ảnh chapter nào");

  const nums = chapters.map((c) => Number(c.chapter)).filter(Number.isFinite);
  const doc = {
    sampleUrl: buildAsuraChapterUrl(seriesUrl, seriesPath, nums[0] ?? chapterNums[0]),
    homeUrl: seriesUrl,
    title: args.title || meta.title,
    fromChapter: nums.length ? Math.min(...nums) : chapterNums[0],
    toChapter: nums.length ? Math.max(...nums) : chapterNums[chapterNums.length - 1],
    fetchedAt: new Date().toISOString(),
    source: DEFAULT_SOURCE,
    coverUrl: meta.coverUrl || existing?.coverUrl || "",
    chapters,
  };

  const beforeCount = Array.isArray(existing?.chapters) ? existing.chapters.length : 0;
  const added = Math.max(0, chapters.length - beforeCount);

  await writeFile(outAbs, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`Wrote ${chapters.length} chapter(s) -> ${outAbs}`);

  if (args.updateCatalog) {
    const catalogAbs = resolve(process.cwd(), args.catalogPath);
    await upsertCatalog(catalogAbs, outFileName, doc, {
      featured: args.featured,
      bumpTimestamp: added > 0,
    });
    console.log(`Updated catalog: ${args.catalogPath}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
