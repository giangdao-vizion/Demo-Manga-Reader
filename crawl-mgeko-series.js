#!/usr/bin/env node
/**
 * Crawl full series from one mgeko chapter URL.
 *
 * Flow:
 * - Parse chapter list from select#cars on the reader page.
 * - Resolve home URL from div.titles > h1 > a then fetch title + coverUrl.
 * - Merge with existing data-json file: only fetch missing chapters by default.
 * - Fetch chapter images in parallel (default concurrency = 5).
 * - Upsert manhwa-catalog.json entry.
 *
 * Usage:
 *   node crawl-mgeko-series.js "<chapter-url>"
 *   node crawl-mgeko-series.js "<chapter-url>" --out data-json/lightning-degree.json
 *   node crawl-mgeko-series.js "<chapter-url>" --concurrency 5 --force
 *   node crawl-mgeko-series.js "<chapter-url>" --out data-json/foo.json --featured
 *   node crawl-mgeko-series.js "<chapter-url>" --limit-chapters 10 --catalog-title "One-Punch Man (ENG)"
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { BROWSER_HEADERS, fetchMgekoImagesFromUrl } from "./extract.mjs";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_SOURCE = "mgeko";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <chapter-url> [options]

Options:
  --out PATH          Mặc định: data-json/<slug>.json
  --catalog PATH      Mặc định: manhwa-catalog.json
  --no-catalog        Không cập nhật catalog
  --concurrency N     Fetch song song N chapter (mặc định: ${DEFAULT_CONCURRENCY})
  --force             Fetch lại toàn bộ chapter (bỏ merge chapter cũ)
  --limit-chapters N  Chỉ crawl N chapter đầu (sau khi sort theo thứ tự đọc)
  --featured          Gắn featured=true trong catalog
  --catalog-title T   Tiêu đề catalog (tránh trùng bộ khác cùng tên)
  --cookie "a=b"      Hoặc env MGEKO_COOKIE
`);
}

function parseArgs(argv) {
  const out = {
    chapterUrl: "",
    outPath: "",
    catalogPath: "manhwa-catalog.json",
    updateCatalog: true,
    concurrency: DEFAULT_CONCURRENCY,
    force: false,
    limitChapters: null,
    featured: false,
    catalogTitle: "",
    cookie: "",
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
    else if (a === "--force") out.force = true;
    else if (a === "--limit-chapters" && argv[i + 1]) {
      out.limitChapters = Number(argv[++i], 10);
    } else if (a === "--featured") out.featured = true;
    else if (a === "--catalog-title" && argv[i + 1]) {
      out.catalogTitle = String(argv[++i]).trim();
    } else if (a === "--cookie" && argv[i + 1]) out.cookie = String(argv[++i]).trim();
    else if (!a.startsWith("-")) positional.push(a);
  }

  if (positional[0]) out.chapterUrl = positional[0];
  const envCookie = String(process.env.MGEKO_COOKIE || "").trim();
  if (!out.cookie && envCookie) out.cookie = envCookie;
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) {
    out.concurrency = DEFAULT_CONCURRENCY;
  }
  if (out.concurrency > 12) out.concurrency = 12;
  return out;
}

function normalizeUrl(urlString) {
  try {
    const u = new URL(urlString);
    u.hash = "";
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch {
    return String(urlString || "").trim();
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

function extractReaderSlugFromUrl(chapterUrl) {
  try {
    const p = new URL(chapterUrl).pathname;
    const m = p.match(/\/reader\/[^/]+\/(.+)-chapter-[^/]+\/?$/i);
    if (!m) return "";
    return String(m[1]).trim();
  } catch {
    return "";
  }
}

function chapterInfoFromUrl(chapterUrl) {
  const clean = normalizeUrl(chapterUrl);
  let key = "";
  try {
    const p = new URL(clean).pathname;
    let m = p.match(/-chapter-([^/]+?)-[a-z]{2,}(?:-[a-z]{2,})?\/?$/i);
    if (!m) m = p.match(/-chapter-([^/]+)\/?$/i);
    key = m ? String(m[1]).trim() : "";
  } catch {
    key = "";
  }
  const n = Number((key.match(/\d+/) || [])[0]);
  return {
    chapterKey: key || clean,
    chapterNumber: Number.isFinite(n) ? n : null,
  };
}

async function fetchHtml(url, cookie) {
  const headers = { ...BROWSER_HEADERS };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText || ""} @ ${url}`);
  }
  const html = await res.text();
  return {
    html,
    finalUrl: res.url || url,
  };
}

function extractChaptersFromReaderHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();

  $("#cars option").each((idx, el) => {
    const raw = String($(el).attr("value") || "").trim();
    if (!raw) return;
    let abs = "";
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      return;
    }
    const key = normalizeUrl(abs);
    if (!key || seen.has(key)) return;
    seen.add(key);

    const text = String($(el).text() || "").replace(/\s+/g, " ").trim();
    const cleanLabel = text.replace(/^chapter:\s*/i, "").trim();
    const info = chapterInfoFromUrl(abs);

    out.push({
      order: idx,
      label: cleanLabel || text || info.chapterKey,
      url: abs,
      chapterKey: info.chapterKey,
      chapterNumber: info.chapterNumber,
    });
  });

  const nums = out.map((c) => c.chapterNumber).filter(Number.isFinite);
  if (nums.length >= 2 && nums[0] > nums[nums.length - 1]) {
    out.reverse().forEach((c, idx) => {
      c.order = idx;
    });
  }

  return out;
}

function extractCurrentChapterFromReaderHtml(html, readerUrl) {
  const $ = cheerio.load(html);
  const headingRaw = String($("h2").first().text() || "")
    .replace(/\s+/g, " ")
    .trim();
  const label = headingRaw.replace(/^chapter[:\s-]*/i, "").trim();
  const info = chapterInfoFromUrl(readerUrl);
  return {
    order: -1,
    label: label || info.chapterKey,
    url: readerUrl,
    chapterKey: info.chapterKey,
    chapterNumber: info.chapterNumber,
  };
}

function injectCurrentChapterInOrder(chapterList, currentChapter) {
  if (!currentChapter || !currentChapter.url) return chapterList;
  const existed = chapterList.some(
    (c) => normalizeUrl(c.url) === normalizeUrl(currentChapter.url)
  );
  if (existed) return chapterList;

  const next = [...chapterList];
  let insertOrder =
    next.length > 0
      ? Math.max(...next.map((c) => (Number.isFinite(c.order) ? c.order : 0))) + 1
      : 0;

  const n = currentChapter.chapterNumber;
  if (Number.isFinite(n) && next.length > 0) {
    const same = next
      .filter((c) => Number.isFinite(c.chapterNumber) && c.chapterNumber === n)
      .sort((a, b) => a.order - b.order);
    if (same.length > 0) {
      insertOrder = same[same.length - 1].order + 0.01;
    } else {
      const greater = next
        .filter((c) => Number.isFinite(c.chapterNumber) && c.chapterNumber > n)
        .sort((a, b) => a.order - b.order)[0];
      if (greater) {
        insertOrder = greater.order - 0.01;
      } else {
        const smaller = next
          .filter((c) => Number.isFinite(c.chapterNumber) && c.chapterNumber < n)
          .sort((a, b) => a.order - b.order);
        if (smaller.length > 0) {
          insertOrder = smaller[smaller.length - 1].order + 0.01;
        }
      }
    }
  }

  next.push({ ...currentChapter, order: insertOrder });
  next.sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 0;
    const bo = Number.isFinite(b.order) ? b.order : 0;
    return ao - bo;
  });
  next.forEach((c, idx) => {
    c.order = idx;
  });
  return next;
}

function extractHomeUrlFromReaderHtml(html, readerUrl) {
  const $ = cheerio.load(html);
  const href = String($("div.titles > h1 > a").first().attr("href") || "").trim();
  if (!href) return null;
  try {
    return new URL(href, readerUrl).href;
  } catch {
    return null;
  }
}

function extractSeriesMetaFromHomeHtml(html, homeUrl) {
  const $ = cheerio.load(html);
  const title =
    String($("h1").first().text() || "")
      .replace(/\s+/g, " ")
      .trim() ||
    String($("meta[property='og:title']").attr("content") || "")
      .replace(/\s+/g, " ")
      .trim() ||
    null;

  const coverCandidates = [
    $("meta[property='og:image']").attr("content"),
    $("div.summary_image img").attr("src"),
    $("div.summary_image img").attr("data-src"),
    $("div.thumb img").attr("src"),
    $("img.wp-post-image").attr("src"),
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  let coverUrl = null;
  for (const c of coverCandidates) {
    try {
      coverUrl = new URL(c, homeUrl).href;
      break;
    } catch {
      /* keep trying */
    }
  }

  return { title, coverUrl };
}

function chooseDataFile({ chapterUrl, homeUrl, title }) {
  const fromHome = (() => {
    try {
      if (!homeUrl) return "";
      const parts = new URL(homeUrl).pathname.split("/").filter(Boolean);
      if (!parts.length) return "";
      return slugify(parts[parts.length - 1]);
    } catch {
      return "";
    }
  })();

  const fromReader = slugify(extractReaderSlugFromUrl(chapterUrl).replace(/-mg\d+$/i, ""));
  const fromTitle = slugify(title || "");
  const slug = fromHome || fromReader || fromTitle || "mgeko-series";
  return `${slug}.json`;
}

async function chooseExistingDataFileFromCatalog(catalogPath, title) {
  if (!title) return null;
  try {
    const abs = resolve(process.cwd(), catalogPath);
    const raw = await readFile(abs, "utf8");
    const cat = JSON.parse(raw);
    if (!cat || !Array.isArray(cat.series)) return null;
    const t = String(title).trim().toLowerCase();
    const matched = cat.series.find(
      (s) =>
        String(s.title || "")
          .trim()
          .toLowerCase() === t
    );
    if (!matched || !matched.dataFile) return null;
    return String(matched.dataFile).trim();
  } catch {
    return null;
  }
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function existingChapterLookup(existingDoc) {
  const byUrl = new Map();
  const byKey = new Map();
  if (!existingDoc || !Array.isArray(existingDoc.chapters)) return { byUrl, byKey };
  for (const ch of existingDoc.chapters) {
    if (ch && ch.url) byUrl.set(normalizeUrl(ch.url), ch);
    if (ch && ch.finalUrl) byUrl.set(normalizeUrl(ch.finalUrl), ch);
    if (ch && ch.chapterKey) byKey.set(String(ch.chapterKey), ch);
    else if (ch && ch.url) {
      const { chapterKey } = chapterInfoFromUrl(ch.url);
      if (chapterKey) byKey.set(chapterKey, ch);
    }
  }
  return { byUrl, byKey };
}

function runParallel(limit, items, worker) {
  if (!items.length) return Promise.resolve([]);
  const n = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  async function loop() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  }

  return Promise.all(Array.from({ length: n }, () => loop())).then(() => results);
}

async function upsertCatalog(catalogPath, entry) {
  const abs = resolve(process.cwd(), catalogPath);
  const raw = await readFile(abs, "utf8");
  const cat = JSON.parse(raw);
  if (!cat || !Array.isArray(cat.series)) {
    throw new Error("manhwa-catalog.json thiếu mảng series");
  }

  const dataFile = entry.dataFile;
  const titleNorm = String(entry.title || "").trim().toLowerCase();
  let idx = cat.series.findIndex((s) => s.dataFile === dataFile);
  if (idx < 0 && titleNorm) {
    idx = cat.series.findIndex((s) => String(s.title || "").trim().toLowerCase() === titleNorm);
  }

  const cleanEntry = Object.fromEntries(
    Object.entries(entry).filter(([, v]) => v !== undefined)
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
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.chapterUrl) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  let chapterUrl;
  try {
    chapterUrl = new URL(args.chapterUrl).href;
  } catch {
    throw new Error(`URL chapter không hợp lệ: ${args.chapterUrl}`);
  }
  const cookie = args.cookie || undefined;

  console.error(`Fetch reader page: ${chapterUrl}`);
  const reader = await fetchHtml(chapterUrl, cookie);
  const baseChapterList = extractChaptersFromReaderHtml(reader.html, reader.finalUrl);
  const currentChapter = extractCurrentChapterFromReaderHtml(reader.html, reader.finalUrl);
  const chapterList = injectCurrentChapterInOrder(baseChapterList, currentChapter);
  if (!chapterList.length) {
    throw new Error("Không tìm thấy chapter list trong select#cars.");
  }

  const homeUrl = extractHomeUrlFromReaderHtml(reader.html, reader.finalUrl);
  let title = null;
  let coverUrl = null;
  if (homeUrl) {
    console.error(`Fetch home page: ${homeUrl}`);
    try {
      const home = await fetchHtml(homeUrl, cookie);
      const meta = extractSeriesMetaFromHomeHtml(home.html, home.finalUrl);
      title = meta.title || null;
      coverUrl = meta.coverUrl || null;
    } catch (e) {
      console.error(`Cảnh báo: lỗi đọc home page (${String(e.message || e)})`);
    }
  }
  if (!title) {
    title = extractReaderSlugFromUrl(reader.finalUrl)
      .replace(/-mg\d+$/i, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  const guessedDataFile = chooseDataFile({ chapterUrl: reader.finalUrl, homeUrl, title });
  const existingDataFile = args.outPath
    ? null
    : await chooseExistingDataFileFromCatalog(args.catalogPath, title);
  const dataFile = existingDataFile || guessedDataFile;
  const outPath = resolve(process.cwd(), args.outPath || `data-json/${dataFile}`);
  const existing = args.force ? null : await readJsonIfExists(outPath);
  const { byUrl, byKey } = existingChapterLookup(existing);

  let ordered = chapterList.map((item, idx) => ({
    ...item,
    chapter: Number.isFinite(item.chapterNumber) ? item.chapterNumber : idx + 1,
  }));

  if (args.limitChapters != null && Number.isFinite(args.limitChapters) && args.limitChapters > 0) {
    ordered = ordered.slice(0, Math.floor(args.limitChapters));
    console.error(`--limit-chapters ${ordered.length}: chỉ crawl ${ordered.length} chapter đầu.`);
  }

  let skipped = 0;
  const targets = [];
  const carry = new Map();
  for (const item of ordered) {
    const keyUrl = normalizeUrl(item.url);
    const old = byUrl.get(keyUrl) || byKey.get(item.chapterKey) || null;
    if (!args.force && old && Array.isArray(old.images) && old.images.length > 0) {
      skipped++;
      carry.set(item.url, old);
      continue;
    }
    targets.push(item);
  }

  if (skipped > 0) {
    console.error(`Merge mode: giữ lại ${skipped} chapter đã có ảnh.`);
  }
  console.error(`Cần fetch ${targets.length}/${ordered.length} chapter (concurrency=${args.concurrency}).`);

  const fetched = await runParallel(args.concurrency, targets, async (item, idx) => {
    process.stderr.write(
      `\r[${idx + 1}/${targets.length}] Ch.${item.chapterKey || item.chapter} (${item.label})`
    );
    const result = await fetchMgekoImagesFromUrl(item.url, { cookie });
    const images = Array.isArray(result.images) ? result.images : [];
    const entry = {
      title: item.label ? `Chapter ${item.label}` : `Chapter ${item.chapter}`,
      chapter: item.chapter,
      chapterKey: item.chapterKey,
      chapterLabel: item.label,
      url: item.url,
      finalUrl: result.finalUrl || item.url,
      total: images.length,
      images,
    };
    if (!result.ok) {
      entry.error = `HTTP ${result.status} ${result.statusText || ""}`.trim();
    } else if (images.length === 0) {
      entry.error = "No images found (#chapter-reader img)";
    }
    return entry;
  });
  if (targets.length > 0) process.stderr.write("\n");

  const fetchedByUrl = new Map(fetched.map((c) => [normalizeUrl(c.url), c]));
  const finalChapters = [];
  for (const item of ordered) {
    const keyUrl = normalizeUrl(item.url);
    const take = fetchedByUrl.get(keyUrl) || carry.get(item.url);
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

  if (!finalChapters.length) {
    throw new Error("Không có chapter hợp lệ để ghi file.");
  }

  const nums = finalChapters
    .map((c) => Number(c.chapter))
    .filter((n) => Number.isFinite(n));
  const fromChapter = nums.length ? Math.min(...nums) : 1;
  const toChapter = nums.length ? Math.max(...nums) : finalChapters.length;
  const errors = finalChapters.filter((c) => c.error).length;

  const doc = {
    sampleUrl: reader.finalUrl,
    homeUrl: homeUrl || null,
    title,
    fromChapter,
    toChapter,
    fetchedAt: new Date().toISOString(),
    source: DEFAULT_SOURCE,
    chapters: finalChapters,
  };
  await writeFile(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.error(`Wrote ${finalChapters.length} chapter(s) -> ${outPath}`);
  if (errors > 0) console.error(`Cảnh báo: ${errors} chapter lỗi hoặc thiếu ảnh.`);

  if (args.updateCatalog) {
    const outFileName = outPath.split(/[/\\]/).pop();
    const catalogTitle =
      args.catalogTitle || title || outFileName.replace(/\.json$/i, "");
    const catalogEntry = {
      dataFile: outFileName,
      title: catalogTitle,
      displayTitle: catalogTitle,
      subtitle: `Ch. ${fromChapter}-${toChapter} · ${outFileName}`,
      source: DEFAULT_SOURCE,
      fromChapter,
      toChapter,
      chapterCount: finalChapters.length,
      coverUrl: coverUrl || undefined,
      featured: args.featured === true ? true : undefined,
    };
    await upsertCatalog(args.catalogPath, catalogEntry);
    console.error(`Updated catalog: ${args.catalogPath}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
