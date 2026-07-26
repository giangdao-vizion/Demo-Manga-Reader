#!/usr/bin/env node
/**
 * Crawl full series from Qi Manga (api.qimanga.com).
 *
 * Usage:
 *   node crawl-qimanga-series.js "https://qimanga.com/series/<slug>"
 *   node crawl-qimanga-series.js "<slug>"
 *   node crawl-qimanga-series.js "<slug>" --out data-json/foo-qimanga.json --concurrency 8
 *   node crawl-qimanga-series.js --from-browse qimanga-completed-browse.json
 *   node crawl-qimanga-series.js --from-browse qimanga-completed-browse.json --series-concurrency 2
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.qimanga.com/api/v1";
const SITE = "https://qimanga.com";
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_SOURCE = "qimanga";
const DEFAULT_HEADERS = {
  Accept: "application/json",
  Origin: SITE,
  Referer: `${SITE}/`,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage:
  node ${self} <series-url-or-slug> [options]
  node ${self} --from-browse <browse.json> [options]

Options:
  --out PATH               Default: data-json/<slug>-qimanga.json
  --catalog PATH           Default: manhwa-catalog.json
  --no-catalog             Skip catalog update
  --concurrency N          Parallel chapter fetches (default: ${DEFAULT_CONCURRENCY})
  --series-concurrency N   Parallel series when using --from-browse (default: 1)
  --force                  Re-fetch chapters that already have images
  --limit-chapters N       Only first N chapters (reading order)
  --featured               Set featured=true in catalog
  --catalog-title T        Override catalog title
  --from-browse PATH       Crawl every series listed in browse JSON
`);
}

function parseArgs(argv) {
  const out = {
    seriesArg: "",
    outPath: "",
    catalogPath: "manhwa-catalog.json",
    updateCatalog: true,
    concurrency: DEFAULT_CONCURRENCY,
    seriesConcurrency: 1,
    force: false,
    limitChapters: null,
    featured: false,
    catalogTitle: "",
    fromBrowse: "",
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
    else if (a === "--series-concurrency" && argv[i + 1]) {
      out.seriesConcurrency = Number(argv[++i], 10);
    } else if (a === "--force") out.force = true;
    else if (a === "--limit-chapters" && argv[i + 1]) {
      out.limitChapters = Number(argv[++i], 10);
    } else if (a === "--featured") out.featured = true;
    else if (a === "--catalog-title" && argv[i + 1]) {
      out.catalogTitle = String(argv[++i]).trim();
    } else if (a === "--from-browse" && argv[i + 1]) {
      out.fromBrowse = String(argv[++i]).trim();
    } else if (!a.startsWith("-")) positional.push(a);
  }
  if (positional[0]) out.seriesArg = positional[0];
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) {
    out.concurrency = DEFAULT_CONCURRENCY;
  }
  if (out.concurrency > 16) out.concurrency = 16;
  if (!Number.isInteger(out.seriesConcurrency) || out.seriesConcurrency < 1) {
    out.seriesConcurrency = 1;
  }
  if (out.seriesConcurrency > 4) out.seriesConcurrency = 4;
  return out;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "’");
}

function slugFromArg(arg) {
  const s = String(arg || "").trim();
  if (!s) return "";
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const m = u.pathname.match(/\/series\/([^/]+)/i);
      return m ? decodeURIComponent(m[1]) : "";
    }
  } catch {
    /* ignore */
  }
  return s.replace(/^\/+|\/+$/g, "");
}

function dataFileForSlug(slug) {
  const clean = String(slug || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return `${clean || "qimanga-series"}-qimanga.json`;
}

function chapterKeyFromNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  return String(n);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiGet(path, { retries = 4 } = {}) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        await sleep(500 * (attempt + 1) * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const msg = json?.message || res.statusText || "";
        throw new Error(`HTTP ${res.status} ${url}${msg ? `: ${msg}` : ""}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`Failed ${url}`);
}

async function runParallel(concurrency, items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function loop() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => loop()));
  return results;
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function fetchAllChapters(seriesSlug) {
  const chapters = [];
  const seen = new Set();
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const j = await apiGet(
      `/series/${encodeURIComponent(seriesSlug)}/chapters?page=${page}`
    );
    totalPages = Number(j.totalPages) || page;
    for (const ch of j.data || []) {
      const id = ch.id ?? `${ch.slug}:${ch.number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      chapters.push(ch);
    }
    page += 1;
    if (page > 500) break;
  }
  chapters.sort((a, b) => Number(a.number) - Number(b.number));
  return chapters;
}

async function fetchChapterImages(seriesSlug, chapterSlug) {
  const j = await apiGet(
    `/series/${encodeURIComponent(seriesSlug)}/chapters/${encodeURIComponent(chapterSlug)}`
  );
  const images = Array.isArray(j.images)
    ? [...j.images]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((img) => img.url)
        .filter(Boolean)
    : [];
  return {
    ok: true,
    images,
    requiresPurchase: Boolean(j.requiresPurchase),
    isFree: j.isFree !== false,
    number: j.number,
    title: j.title,
    totalImages: j.totalImages ?? images.length,
  };
}

function existingChapterLookup(existing) {
  const byUrl = new Map();
  const byKey = new Map();
  const list = Array.isArray(existing?.chapters) ? existing.chapters : [];
  for (const ch of list) {
    if (ch?.url) byUrl.set(String(ch.url), ch);
    const key = ch?.chapterKey != null ? String(ch.chapterKey) : null;
    if (key) byKey.set(key, ch);
  }
  return { byUrl, byKey };
}

let catalogWriteChain = Promise.resolve();

async function upsertCatalog(catalogPath, entry) {
  const run = async () => {
    const abs = resolve(process.cwd(), catalogPath);
    const cat = (await readJsonIfExists(abs)) || { version: 1, updatedAt: null, series: [] };
    if (!Array.isArray(cat.series)) {
      throw new Error("manhwa-catalog.json thiếu mảng series");
    }

    const cleanEntry = { ...entry };
    Object.keys(cleanEntry).forEach((k) => {
      if (cleanEntry[k] === undefined) delete cleanEntry[k];
    });

    const idx = cat.series.findIndex(
      (s) =>
        (s.dataFile && s.dataFile === cleanEntry.dataFile) ||
        (cleanEntry.title && s.title === cleanEntry.title && s.source === cleanEntry.source)
    );

    if (idx >= 0) {
      const prev = cat.series[idx] || {};
      const merged = { ...prev, ...cleanEntry };
      if (cleanEntry.coverUrl == null && prev.coverUrl != null) {
        merged.coverUrl = prev.coverUrl;
      }
      cat.series[idx] = merged;
    } else {
      cat.series.push({
        sqliteSeriesId: null,
        contentSyncComplete: false,
        contentSyncNote: null,
        ...cleanEntry,
      });
    }

    cat.updatedAt = new Date().toISOString();
    await writeFile(abs, JSON.stringify(cat, null, 2) + "\n", "utf8");
  };

  const next = catalogWriteChain.then(run, run);
  catalogWriteChain = next.catch(() => {});
  await next;
}

async function upsertFromDoc(args, doc, outPath, title, coverUrl, homeUrl, seriesSlug) {
  const outFileName = outPath.split(/[/\\]/).pop();
  const catalogTitle = args.catalogTitle || title || outFileName.replace(/\.json$/i, "");
  const fromChapter = doc.fromChapter;
  const toChapter = doc.toChapter;
  const chapterCount = Array.isArray(doc.chapters) ? doc.chapters.length : 0;
  await upsertCatalog(args.catalogPath, {
    dataFile: outFileName,
    title: catalogTitle,
    displayTitle: catalogTitle,
    subtitle: `Ch. ${fromChapter}-${toChapter} · ${outFileName}`,
    source: DEFAULT_SOURCE,
    fromChapter,
    toChapter,
    chapterCount,
    coverUrl: coverUrl || undefined,
    homeUrl: homeUrl || undefined,
    seriesSlug: seriesSlug || undefined,
    featured: args.featured === true ? true : undefined,
  });
  console.error(`Updated catalog: ${args.catalogPath}`);
}

async function crawlOneSeries(seriesArg, args) {
  const slug = slugFromArg(seriesArg);
  if (!slug) throw new Error(`Không parse được series slug từ: ${seriesArg}`);

  console.error(`\n=== Qi Manga: ${slug} ===`);
  const detailWrap = await apiGet(`/series/${encodeURIComponent(slug)}`);
  const detail = detailWrap?.data || detailWrap;
  if (!detail?.slug && !detail?.title) {
    throw new Error(`Series không tìm thấy: ${slug}`);
  }

  const seriesSlug = detail.slug || slug;
  const title = decodeEntities(args.catalogTitle || detail.title || seriesSlug);
  const coverUrl = detail.cover || null;
  const homeUrl = `${SITE}/series/${seriesSlug}`;
  const dataFile = dataFileForSlug(seriesSlug);
  const outPath = resolve(process.cwd(), args.outPath || `data-json/${dataFile}`);
  await mkdir(dirname(outPath), { recursive: true });

  const chapterList = await fetchAllChapters(seriesSlug);
  if (!chapterList.length) throw new Error(`Không có chapter: ${seriesSlug}`);
  console.error(`Chapter list: ${chapterList.length}`);

  let ordered = chapterList.map((ch) => {
    const number = Number(ch.number);
    const chapterKey = chapterKeyFromNumber(number);
    const label = chapterKey;
    const url = `${homeUrl}/${ch.slug}`;
    return {
      id: ch.id,
      slug: ch.slug,
      number,
      chapter: number,
      chapterKey,
      label,
      url,
      requiresPurchase: Boolean(ch.requiresPurchase),
      isFree: ch.isFree !== false,
      price: ch.price ?? 0,
    };
  });

  if (args.limitChapters != null && Number.isFinite(args.limitChapters) && args.limitChapters > 0) {
    ordered = ordered.slice(0, Math.floor(args.limitChapters));
    console.error(`--limit-chapters ${ordered.length}`);
  }

  const existing = args.force ? null : await readJsonIfExists(outPath);
  const { byUrl, byKey } = existingChapterLookup(existing);

  let skipped = 0;
  const targets = [];
  const carry = new Map();
  for (const item of ordered) {
    const old = byUrl.get(item.url) || byKey.get(item.chapterKey) || null;
    if (!args.force && old && Array.isArray(old.images) && old.images.length > 0) {
      skipped++;
      carry.set(item.url, old);
      continue;
    }
    targets.push(item);
  }

  if (skipped > 0) console.error(`Merge: giữ ${skipped} chapter đã có ảnh.`);
  if (!targets.length) {
    console.error(`Không có chương mới (${skipped}/${ordered.length} đã có).`);
    if (existing?.chapters?.length) {
      if (args.updateCatalog) {
        await upsertFromDoc(args, existing, outPath, title, coverUrl, homeUrl, seriesSlug);
      }
      return { slug: seriesSlug, title, chapters: existing.chapters.length, skipped: true };
    }
  } else {
    console.error(`Fetch ${targets.length}/${ordered.length} (concurrency=${args.concurrency})`);
  }

  const fetched = await runParallel(args.concurrency, targets, async (item, idx) => {
    process.stderr.write(`\r[${idx + 1}/${targets.length}] Ch.${item.chapterKey}`);
    try {
      const result = await fetchChapterImages(seriesSlug, item.slug);
      const images = result.images || [];
      const entry = {
        title: item.label ? `Chapter ${item.label}` : `Chapter ${item.chapter}`,
        chapter: item.chapter,
        chapterKey: item.chapterKey,
        chapterLabel: item.label,
        url: item.url,
        finalUrl: item.url,
        total: images.length,
        images,
      };
      if (result.requiresPurchase && images.length === 0) {
        entry.error = "Requires purchase / locked";
      } else if (images.length === 0) {
        entry.error = "No images";
      }
      return entry;
    } catch (e) {
      return {
        title: `Chapter ${item.chapterKey}`,
        chapter: item.chapter,
        chapterKey: item.chapterKey,
        chapterLabel: item.label,
        url: item.url,
        finalUrl: item.url,
        total: 0,
        images: [],
        error: String(e.message || e),
      };
    }
  });
  if (targets.length > 0) process.stderr.write("\n");

  const fetchedByUrl = new Map(fetched.map((c) => [c.url, c]));
  const finalChapters = [];
  for (const item of ordered) {
    const take = fetchedByUrl.get(item.url) || carry.get(item.url);
    if (!take) continue;
    finalChapters.push({
      ...take,
      title: item.label ? `Chapter ${item.label}` : take.title,
      chapter: item.chapter,
      chapterKey: item.chapterKey,
      chapterLabel: item.label,
      url: item.url,
    });
  }

  if (!finalChapters.length) throw new Error(`Không ghi được chapter cho ${seriesSlug}`);

  const nums = finalChapters.map((c) => Number(c.chapter)).filter((n) => Number.isFinite(n));
  const fromChapter = nums.length ? Math.min(...nums) : 1;
  const toChapter = nums.length ? Math.max(...nums) : finalChapters.length;
  const errors = finalChapters.filter((c) => c.error).length;
  const withImages = finalChapters.filter((c) => Array.isArray(c.images) && c.images.length > 0).length;

  const doc = {
    sampleUrl: `${homeUrl}/chapter-1`,
    homeUrl,
    title,
    fromChapter,
    toChapter,
    fetchedAt: new Date().toISOString(),
    source: DEFAULT_SOURCE,
    seriesSlug,
    chapters: finalChapters,
  };
  await writeFile(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.error(
    `Wrote ${finalChapters.length} chapter(s) (${withImages} có ảnh, ${errors} lỗi) -> ${outPath}`
  );

  if (args.updateCatalog) {
    await upsertFromDoc(args, doc, outPath, title, coverUrl, homeUrl, seriesSlug);
  }

  return {
    slug: seriesSlug,
    title,
    chapters: finalChapters.length,
    withImages,
    errors,
    outPath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.seriesArg && !args.fromBrowse)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  if (args.fromBrowse) {
    const browsePath = resolve(process.cwd(), args.fromBrowse);
    const browse = JSON.parse(await readFile(browsePath, "utf8"));
    const list = Array.isArray(browse.series) ? browse.series : [];
    if (!list.length) throw new Error(`Browse JSON không có series: ${browsePath}`);
    console.error(
      `Batch crawl ${list.length} series (series-concurrency=${args.seriesConcurrency})`
    );

    const results = [];
    const queue = list.map((s, i) => ({ s, i }));
    let cursor = 0;
    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const { s, i } = queue[idx];
        const label = s.slug || s.url || s.title || `#${i + 1}`;
        try {
          const oneArgs = {
            ...args,
            outPath: "",
            catalogTitle: decodeEntities(s.title || ""),
          };
          const r = await crawlOneSeries(s.slug || s.url, oneArgs);
          results.push({ ok: true, index: i + 1, ...r });
          console.error(`[batch ${i + 1}/${list.length}] OK ${r.title} (${r.chapters} ch)`);
        } catch (e) {
          results.push({ ok: false, index: i + 1, slug: label, error: String(e.message || e) });
          console.error(`[batch ${i + 1}/${list.length}] FAIL ${label}: ${e.message || e}`);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(args.seriesConcurrency, list.length) }, () => worker())
    );

    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok);
    console.error(`\nBatch done: ${ok}/${list.length} OK`);
    if (fail.length) {
      console.error("Failures:");
      for (const f of fail) console.error(`  - ${f.slug}: ${f.error}`);
      process.exitCode = 1;
    }
    await writeFile(
      resolve(process.cwd(), "qimanga-completed-crawl-report.json"),
      JSON.stringify({ fetchedAt: new Date().toISOString(), results }, null, 2) + "\n",
      "utf8"
    );
    return;
  }

  await crawlOneSeries(args.seriesArg, args);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
