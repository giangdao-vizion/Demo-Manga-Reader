#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { BROWSER_HEADERS, collectArticleImageUrls } from "./extract.mjs";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_SOURCE = "onepunchmantruyen";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <series-url> [options]

Options:
  --out PATH          Mặc định: data-json/<slug>.json
  --catalog PATH      Mặc định: manhwa-catalog.json
  --no-catalog        Không cập nhật catalog
  --concurrency N     Fetch song song N chapter (mặc định: ${DEFAULT_CONCURRENCY})
  --featured          Gắn featured=true trong catalog
`);
}

function parseArgs(argv) {
  const out = {
    seriesUrl: "",
    outPath: "",
    catalogPath: "manhwa-catalog.json",
    updateCatalog: true,
    concurrency: DEFAULT_CONCURRENCY,
    featured: false,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--out" && argv[i + 1]) out.outPath = String(argv[++i]).trim();
    else if (a === "--catalog" && argv[i + 1]) out.catalogPath = String(argv[++i]).trim();
    else if (a === "--no-catalog") out.updateCatalog = false;
    else if (a === "--concurrency" && argv[i + 1]) out.concurrency = Number(argv[++i], 10);
    else if (a === "--featured") out.featured = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  if (positional[0]) out.seriesUrl = positional[0];
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = DEFAULT_CONCURRENCY;
  if (out.concurrency > 20) out.concurrency = 20;
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

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function chapterInfoFromUrl(chapterUrl) {
  const clean = normalizeUrl(chapterUrl);
  let raw = "";
  try {
    const p = new URL(clean).pathname;
    const m = p.match(/-chapter-([^/]+)\/?$/i);
    raw = m ? String(m[1]).trim() : "";
  } catch {
    raw = "";
  }
  const normalized = raw.replace(/-/g, ".");
  const simple = normalized.match(/^(\d+)(?:\.(\d+))?$/);
  if (simple) {
    const major = simple[1];
    const minor = simple[2];
    return {
      chapterKey: raw || clean,
      chapterLabel: raw || clean,
      chapterTitle: minor ? `${major}.${minor}` : major,
      chapterNumber: minor ? Number(`${major}.${minor}`) : Number(major),
    };
  }
  return {
    chapterKey: raw || clean,
    chapterLabel: raw || clean,
    chapterTitle: raw || clean,
    chapterNumber: NaN,
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return { html: await res.text(), finalUrl: res.url || url };
}

function extractSeriesMeta(html, baseUrl) {
  const $ = cheerio.load(html);
  const title =
    String($("h1").first().text() || "")
      .replace(/\s+/g, " ")
      .trim() || "One Punch Man";

  let coverUrl = "";
  const candidateSelectors = [
    "main img.wp-post-image",
    "article img.wp-post-image",
    "img[loading='eager']",
    "img",
  ];
  for (const sel of candidateSelectors) {
    const src = String($(sel).first().attr("src") || "").trim();
    if (!src) continue;
    try {
      coverUrl = new URL(src, baseUrl).href;
      break;
    } catch {
      /* ignore invalid */
    }
  }
  return { title, coverUrl };
}

function extractChapterLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const list = [];
  $("a[href]").each((_, el) => {
    const raw = String($(el).attr("href") || "").trim();
    if (!raw) return;
    let abs = "";
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      return;
    }
    const u = new URL(abs);
    if (!/\/doc-one-punch-man-chapter-/i.test(u.pathname)) return;
    const key = normalizeUrl(abs);
    if (seen.has(key)) return;
    seen.add(key);
    const info = chapterInfoFromUrl(abs);
    list.push({
      url: abs,
      chapterKey: info.chapterKey,
      chapterLabel: info.chapterLabel,
      chapterTitle: info.chapterTitle,
      chapterNumber: info.chapterNumber,
    });
  });

  list.sort((a, b) => {
    const an = Number.isFinite(a.chapterNumber) ? a.chapterNumber : Number.MAX_SAFE_INTEGER;
    const bn = Number.isFinite(b.chapterNumber) ? b.chapterNumber : Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return a.url.localeCompare(b.url);
  });
  return list;
}

function filterChapterImages(urls) {
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    let ok = false;
    try {
      const p = new URL(u).pathname.toLowerCase();
      ok = p.includes("/wp-content/uploads/") && /\.(?:jpe?g|png|webp|gif)$/.test(p);
      if (p.endsWith("/chapter.gif")) ok = false;
      if (p.includes("one-punch-manz")) ok = false;
    } catch {
      ok = false;
    }
    if (ok) out.push(u);
  }
  return out;
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

function chapterNumberOf(ch, idx) {
  if (ch && Number.isFinite(ch.chapter)) return Number(ch.chapter);
  return idx + 1;
}

async function upsertCatalog(catalogAbs, outFileName, doc, opts) {
  const catalog = JSON.parse(await readFile(catalogAbs, "utf8"));
  if (!catalog || !Array.isArray(catalog.series)) throw new Error("catalog thiếu mảng series");
  const nums = doc.chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
  const from = nums.length ? Math.min(...nums) : 1;
  const to = nums.length ? Math.max(...nums) : from;
  const entry = {
    dataFile: outFileName,
    title: doc.title || "One Punch Man",
    displayTitle: doc.title || "One Punch Man",
    subtitle: `Ch. ${from}\u2013${to} · ${outFileName}`,
    source: DEFAULT_SOURCE,
    fromChapter: from,
    toChapter: to,
    chapterCount: doc.chapters.length,
    sqliteSeriesId: null,
    contentSyncComplete: false,
    contentSyncNote: null,
    coverUrl: doc.coverUrl || null,
    featured: opts.featured === true,
  };
  const idx = catalog.series.findIndex((s) => s && s.dataFile === outFileName);
  if (idx >= 0) catalog.series[idx] = { ...catalog.series[idx], ...entry };
  else catalog.series.push(entry);
  catalog.updatedAt = new Date().toISOString();
  await writeFile(catalogAbs, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.seriesUrl) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const seriesUrl = normalizeUrl(args.seriesUrl);
  if (!seriesUrl) throw new Error("Series URL không hợp lệ");

  console.error(`Fetch series page: ${seriesUrl}`);
  const seriesRes = await fetchHtml(seriesUrl);
  const meta = extractSeriesMeta(seriesRes.html, seriesRes.finalUrl);
  const chapterLinks = extractChapterLinks(seriesRes.html, seriesRes.finalUrl);
  if (!chapterLinks.length) throw new Error("Không tìm thấy chapter links");

  const slug = slugify(meta.title || "one-punch-man") || "one-punch-man";
  const outRel = args.outPath || `data-json/${slug}.json`;
  const outAbs = resolve(process.cwd(), outRel);
  const outFileName = outRel.split("/").pop();

  console.error(`Cần fetch ${chapterLinks.length}/${chapterLinks.length} chapter (concurrency=${args.concurrency}).`);
  let progress = 0;
  const results = await runPool(chapterLinks, args.concurrency, async (ch) => {
    const r = await fetchHtml(ch.url);
    const images = filterChapterImages(collectArticleImageUrls(r.html, r.finalUrl));
    progress++;
    process.stderr.write(`\r[${progress}/${chapterLinks.length}] Ch.${ch.chapterTitle}`);
    return {
      ...ch,
      finalUrl: r.finalUrl,
      images,
    };
  });
  process.stderr.write("\n");

  const chapters = results
    .map((r) => {
      if (!r || !Array.isArray(r.images) || !r.images.length) return null;
      return {
        title: r.chapterTitle,
        chapter: Number.isFinite(r.chapterNumber) ? r.chapterNumber : undefined,
        chapterKey: r.chapterKey,
        chapterLabel: r.chapterLabel,
        url: r.url,
        finalUrl: r.finalUrl,
        total: r.images.length,
        images: r.images,
      };
    })
    .filter(Boolean);

  if (!chapters.length) throw new Error("Không lấy được ảnh chapter nào");

  const nums = chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
  const doc = {
    sampleUrl: chapters[0].url,
    homeUrl: seriesUrl,
    title: meta.title,
    fromChapter: nums.length ? Math.min(...nums) : 1,
    toChapter: nums.length ? Math.max(...nums) : nums.length,
    fetchedAt: new Date().toISOString(),
    source: DEFAULT_SOURCE,
    coverUrl: meta.coverUrl || "",
    chapters,
  };

  await writeFile(outAbs, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`Wrote ${chapters.length} chapter(s) -> ${outAbs}`);

  if (args.updateCatalog) {
    const catalogAbs = resolve(process.cwd(), args.catalogPath);
    await upsertCatalog(catalogAbs, outFileName, doc, { featured: args.featured });
    console.log(`Updated catalog: ${args.catalogPath}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

