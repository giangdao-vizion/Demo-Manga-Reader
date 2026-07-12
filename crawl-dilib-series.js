#!/usr/bin/env node
/**
 * Crawl truyện tranh từ dilib.vn (select chapter + /img/comic/…)
 *
 * Usage:
 *   node crawl-dilib-series.js "https://dilib.vn/truyen-tranh/gantz-14751-chap-1.html"
 *   node crawl-dilib-series.js "<chapter-url>" --out data-json/gantz-dilib.json --featured
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { BROWSER_HEADERS, collectImageUrls } from "./extract.mjs";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_SOURCE = "dilib";
const DEFAULT_HOME = "https://dilib.vn/truyen-tranh/";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <chapter-url> [options]

Options:
  --out PATH          Mặc định: data-json/<slug>-dilib.json
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
    chapterUrl: "",
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
  if (positional[0]) out.chapterUrl = positional[0];
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = DEFAULT_CONCURRENCY;
  if (out.concurrency > 12) out.concurrency = 12;
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

function canonicalChapterUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return normalizeUrl(url);
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function siteEmptyChapterKeysSet(existing) {
  const keys = Array.isArray(existing?.siteEmptyChapterKeys)
    ? existing.siteEmptyChapterKeys
    : [];
  return new Set(keys.map(String));
}

function sortChapterKeyStrings(keys) {
  return keys.slice().sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b), "vi", { numeric: true, sensitivity: "base" });
  });
}

function seriesSlugFromUrl(chapterUrl) {
  try {
    const m = new URL(chapterUrl).pathname.match(/\/truyen-tranh\/(.+)-chap-\d+\.html$/i);
    return m ? String(m[1]).trim() : "";
  } catch {
    return "";
  }
}

function chapterInfoFromUrl(chapterUrl) {
  const clean = normalizeUrl(chapterUrl);
  let raw = "";
  try {
    const m = new URL(clean).pathname.match(/-chap-(\d+)\.html$/i);
    raw = m ? String(m[1]).trim() : "";
  } catch {
    raw = "";
  }
  const num = Number(raw);
  return {
    chapterKey: raw || clean,
    chapterLabel: raw || clean,
    chapterTitle: raw || clean,
    chapterNumber: Number.isFinite(num) ? num : NaN,
  };
}

function buildChapterUrl(baseChapterUrl, optionValue) {
  const slug = seriesSlugFromUrl(baseChapterUrl);
  if (!slug) throw new Error("Không đọc được slug series từ URL chapter");
  const origin = new URL(baseChapterUrl).origin;
  const suffix = String(optionValue || "").trim();
  if (!/^-chap-\d+$/i.test(suffix)) return "";
  return `${origin}/truyen-tranh/${slug}${suffix}.html`;
}

function existingChapterLookup(existingDoc) {
  const byUrl = new Map();
  const byKey = new Map();
  if (!existingDoc || !Array.isArray(existingDoc.chapters)) return { byUrl, byKey };
  for (const ch of existingDoc.chapters) {
    if (ch && ch.url) byUrl.set(canonicalChapterUrl(ch.url), ch);
    if (ch && ch.finalUrl) byUrl.set(canonicalChapterUrl(ch.finalUrl), ch);
    if (ch && ch.chapterKey) byKey.set(String(ch.chapterKey), ch);
    else if (ch && ch.url) {
      const info = chapterInfoFromUrl(ch.url);
      if (info.chapterKey) byKey.set(info.chapterKey, ch);
    }
  }
  return { byUrl, byKey };
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
      .replace(/\s+-\s*CHAPTER\s+\d+\s*$/i, "")
      .replace(/\s+Chapter\s+\d+\s*$/i, "")
      .trim() || "Unknown";

  let coverUrl = "";
  const og = String($("meta[property='og:image']").attr("content") || "").trim();
  if (og) {
    try {
      coverUrl = new URL(og, baseUrl).href;
    } catch {
      /* ignore */
    }
  }
  return { title, coverUrl };
}

function extractChaptersFromSelect(html, baseUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const list = [];

  $("select option").each((_, el) => {
    const raw = String($(el).attr("value") || "").trim();
    if (!raw || !/^-chap-\d+$/i.test(raw)) return;
    const abs = buildChapterUrl(baseUrl, raw);
    if (!abs) return;
    const key = canonicalChapterUrl(abs);
    if (seen.has(key)) return;
    seen.add(key);
    const info = chapterInfoFromUrl(abs);
    const label = String($(el).text() || "")
      .replace(/^chap\s*/i, "")
      .trim();
    list.push({
      url: abs,
      chapterKey: info.chapterKey,
      chapterLabel: label || info.chapterLabel,
      chapterTitle: label || info.chapterTitle,
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
    let ok = false;
    try {
      const p = new URL(u).pathname.toLowerCase();
      ok = /\/img\/comic\//i.test(p) && /\.(?:jpe?g|png|webp|gif)$/.test(p);
    } catch {
      ok = false;
    }
    if (ok) {
      seen.add(u);
      out.push(u);
    }
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
  if (Number.isFinite(ch.chapterNumber)) return ch.chapterNumber;
  return idx + 1;
}

function defaultOutPath(slug, title) {
  const base = slug || String(title || "series")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `data-json/${base}-dilib.json`;
}

async function upsertCatalog(catalogAbs, outFileName, doc, opts) {
  const catalog = JSON.parse(await readFile(catalogAbs, "utf8"));
  if (!catalog || !Array.isArray(catalog.series)) throw new Error("catalog thiếu mảng series");

  const nums = doc.chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
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
    sqliteSeriesId: null,
    contentSyncComplete: false,
    contentSyncNote: "Nguồn dilib.vn.",
    coverUrl: doc.coverUrl || null,
    featured: opts.featured === true,
  };

  let idx = catalog.series.findIndex((s) => s && s.dataFile === outFileName);
  if (idx < 0) {
    idx = catalog.series.findIndex(
      (s) =>
        s &&
        String(s.title || "")
          .trim()
          .toLowerCase() === displayTitle.toLowerCase() &&
        normalizeSourceForMatch(s.source) === DEFAULT_SOURCE
    );
  }
  if (idx >= 0) {
    catalog.series[idx] = { ...catalog.series[idx], ...entry };
  } else {
    catalog.series.push(entry);
  }

  catalog.updatedAt = new Date().toISOString();
  await writeFile(catalogAbs, JSON.stringify(catalog, null, 2) + "\n", "utf8");
}

function normalizeSourceForMatch(source) {
  return String(source || "").trim().toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.chapterUrl) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const seedUrl = normalizeUrl(args.chapterUrl);
  console.error(`Fetch chapter page (danh sách): ${seedUrl}`);
  const seed = await fetchHtml(seedUrl);
  const meta = extractSeriesMeta(seed.html, seed.finalUrl);
  const chapterLinks = extractChaptersFromSelect(seed.html, seed.finalUrl);
  if (!chapterLinks.length) throw new Error("Không tìm thấy chapter trong <select>");

  const slug = seriesSlugFromUrl(seed.finalUrl);
  const outRel = args.outPath || defaultOutPath(slug, meta.title);
  const outAbs = resolve(process.cwd(), outRel);
  const outFileName = outRel.split(/[/\\]/).pop();

  const existing = args.force ? null : await readJsonIfExists(outAbs);
  const { byUrl, byKey } = existingChapterLookup(existing);
  const siteEmpty = siteEmptyChapterKeysSet(existing);

  let skipped = 0;
  let skippedSiteEmpty = 0;
  const targets = [];
  const carry = new Map();
  for (const ch of chapterLinks) {
    const keyUrl = canonicalChapterUrl(ch.url);
    if (!args.force && siteEmpty.has(String(ch.chapterKey))) {
      skippedSiteEmpty++;
      continue;
    }
    const old = byUrl.get(keyUrl) || byKey.get(ch.chapterKey) || null;
    if (!args.force && old && Array.isArray(old.images) && old.images.length > 0) {
      skipped++;
      carry.set(keyUrl, old);
      continue;
    }
    targets.push(ch);
  }

  if (skippedSiteEmpty > 0) {
    console.error(
      `Bỏ qua ${skippedSiteEmpty} mục trên dropdown site (đã biết chưa có ảnh, không có trong JSON).`
    );
  }

  if (skipped > 0) {
    console.error(`Merge mode: giữ lại ${skipped} chapter đã có ảnh.`);
  }
  if (!targets.length) {
    console.error(
      `Không có chương mới cần tải (${skipped}/${chapterLinks.length} chương đã có trong JSON).`
    );
    if (existing && Array.isArray(existing.chapters) && existing.chapters.length) {
      console.error("Skip write: không có chương mới cần cập nhật JSON.");
      return;
    }
  } else {
    console.error(
      `Cần fetch ${targets.length}/${chapterLinks.length} chapter (concurrency=${args.concurrency}).`
    );
  }

  let progress = 0;
  const fetched = targets.length
    ? await runPool(targets, args.concurrency, async (ch) => {
        const r = await fetchHtml(ch.url);
        const images = filterChapterImages(collectImageUrls(r.html, r.finalUrl));
        progress++;
        process.stderr.write(`\r[${progress}/${targets.length}] Ch.${ch.chapterTitle}`);
        return {
          ...ch,
          finalUrl: r.finalUrl,
          images,
          error: images.length ? null : "No chapter images",
        };
      })
    : [];
  if (targets.length > 0) process.stderr.write("\n");

  const newWithImages = fetched.filter(
    (r) => Array.isArray(r.images) && r.images.length > 0
  );
  if (
    targets.length > 0 &&
    !newWithImages.length &&
    existing &&
    Array.isArray(existing.chapters) &&
    existing.chapters.length
  ) {
    for (const r of fetched) {
      if (!Array.isArray(r.images) || !r.images.length) {
        console.error(`  ! Ch.${r.chapterTitle}: chương chưa có ảnh trên site`);
      }
    }
    const nextEmpty = new Set(siteEmpty);
    let addedEmpty = 0;
    for (const r of fetched) {
      if (Array.isArray(r.images) && r.images.length) continue;
      const k = String(r.chapterKey);
      if (!nextEmpty.has(k)) {
        nextEmpty.add(k);
        addedEmpty++;
      }
    }
    if (addedEmpty > 0) {
      const patched = {
        ...existing,
        siteEmptyChapterKeys: sortChapterKeyStrings([...nextEmpty]),
      };
      await writeFile(outAbs, JSON.stringify(patched, null, 2) + "\n", "utf8");
      console.error(
        `Skip write: ghi nhớ ${addedEmpty} mục site chưa có ảnh (lần sau không thử lại).`
      );
    } else {
      console.error("Skip write: không tải được ảnh chương mới — giữ nguyên JSON.");
    }
    return;
  }

  const fetchedByUrl = new Map(
    fetched.map((r) => [canonicalChapterUrl(r.url), r])
  );
  const chapters = [];
  for (const ch of chapterLinks) {
    const keyUrl = canonicalChapterUrl(ch.url);
    const fromFetch = fetchedByUrl.get(keyUrl);
    const fromCarry = carry.get(keyUrl);
    const r = fromFetch || fromCarry;
    if (!r) continue;

    if (fromFetch && (!Array.isArray(r.images) || !r.images.length)) {
      const msg =
        r.error === "No chapter images" ? "chương chưa có ảnh trên site" : r.error;
      if (msg) console.error(`\n  ! Ch.${ch.chapterTitle}: ${msg}`);
      if (fromCarry && Array.isArray(fromCarry.images) && fromCarry.images.length) {
        chapters.push({
          title: fromCarry.title || `Chapter ${ch.chapterTitle}`,
          chapter: Number.isFinite(ch.chapterNumber) ? ch.chapterNumber : fromCarry.chapter,
          chapterKey: ch.chapterKey,
          chapterLabel: ch.chapterLabel,
          url: ch.url,
          finalUrl: fromCarry.finalUrl || ch.url,
          total: fromCarry.images.length,
          images: fromCarry.images,
        });
      }
      continue;
    }

    const images = fromFetch ? r.images : r.images || [];
    if (!images.length) continue;

    chapters.push({
      title: `Chapter ${ch.chapterTitle}`,
      chapter: Number.isFinite(ch.chapterNumber) ? ch.chapterNumber : undefined,
      chapterKey: ch.chapterKey,
      chapterLabel: ch.chapterLabel,
      url: ch.url,
      finalUrl: (fromFetch && r.finalUrl) || r.finalUrl || ch.url,
      total: images.length,
      images,
    });
  }

  if (!chapters.length) throw new Error("Không lấy được ảnh chapter nào");

  const nums = chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
  const doc = {
    sampleUrl: seedUrl,
    homeUrl: DEFAULT_HOME,
    title: args.title || meta.title,
    fromChapter: nums.length ? Math.min(...nums) : 1,
    toChapter: nums.length ? Math.max(...nums) : nums.length,
    fetchedAt: new Date().toISOString(),
    source: DEFAULT_SOURCE,
    coverUrl: meta.coverUrl || "",
    ...(existing?.siteEmptyChapterKeys?.length
      ? { siteEmptyChapterKeys: sortChapterKeyStrings(existing.siteEmptyChapterKeys) }
      : siteEmpty.size
        ? { siteEmptyChapterKeys: sortChapterKeyStrings([...siteEmpty]) }
        : {}),
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
