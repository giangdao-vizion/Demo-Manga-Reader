#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { BROWSER_HEADERS, collectArticleImageUrls } from "./extract.mjs";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_SOURCE = "truyenonepiece";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <series-url> [options]

Options:
  --out PATH          Mặc định: data-json/<slug>.json
  --catalog PATH      Mặc định: manhwa-catalog.json
  --no-catalog        Không cập nhật catalog
  --concurrency N     Fetch song song N chapter (mặc định: ${DEFAULT_CONCURRENCY})
  --featured          Gắn featured=true trong catalog
  --limit-chapters N   Chỉ crawl N chapter đầu (sau khi sort)
  --from-chapter N    Bắt đầu từ chapter number >= N (mặc định: 1)
  --force             Tải lại toàn bộ, bỏ qua chapter đã có ảnh trong JSON
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
    limitChapters: null,
    fromChapter: 1,
    force: false,
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
    else if (a === "--limit-chapters" && argv[i + 1]) out.limitChapters = Number(argv[++i], 10);
    else if (a === "--from-chapter" && argv[i + 1]) out.fromChapter = Number(argv[++i], 10);
    else if (a === "--force") out.force = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  if (positional[0]) out.seriesUrl = positional[0];
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = DEFAULT_CONCURRENCY;
  if (out.concurrency > 20) out.concurrency = 20;
  if (!Number.isFinite(out.fromChapter) || out.fromChapter < 1) out.fromChapter = 1;
  if (out.limitChapters != null && (!Number.isInteger(out.limitChapters) || out.limitChapters < 1)) {
    out.limitChapters = null;
  }
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
    let path = u.pathname || "/";
    if (!path.endsWith("/")) path += "/";
    u.pathname = path;
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
  const ogTitle = String($('meta[property="og:title"]').attr("content") || "").trim();
  const h1 = String($("h1").first().text() || "")
    .replace(/\s+/g, " ")
    .trim();
  const title =
    h1 ||
    ogTitle.replace(/\s*\[.*$/, "").trim() ||
    "One Piece - Đảo Hải Tặc";

  let coverUrl = "";
  $("img").each((_, el) => {
    if (coverUrl) return;
    const candidates = [
      $(el).attr("data-src"),
      $(el).attr("data-lazy-src"),
      $(el).attr("src"),
    ].filter(Boolean);
    for (const raw of candidates) {
      const src = String(raw).trim();
      if (!src || src.startsWith("data:")) continue;
      if (!/\/wp-content\/uploads\//i.test(src)) continue;
      if (/logo/i.test(src)) continue;
      try {
        coverUrl = new URL(src, baseUrl).href;
        return false;
      } catch {
        /* ignore */
      }
    }
  });
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
    if (!/\/doc-truyen-tranh-one-piece-dao-hai-tac-chapter-/i.test(abs)) return;
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
  const byStem = new Map();
  for (const u of urls) {
    if (!u) continue;
    let ok = false;
    let pathname = "";
    try {
      const p = new URL(u).pathname.toLowerCase();
      ok =
        p.includes("/wp-content/uploads/") &&
        /\.(jpe?g|png|webp)$/.test(p) &&
        !p.endsWith("/chapter.gif");
      pathname = p;
    } catch {
      ok = false;
    }
    if (!ok) continue;

    const file = pathname.split("/").pop() || "";
    const stem = file.replace(/-\d+x\d+\.(jpe?g|png|webp)$/i, ".$1");
    const prev = byStem.get(stem);
    if (!prev) {
      byStem.set(stem, u);
      continue;
    }
    const prevScore = prev.includes("-768x") || prev.includes("-1024x") ? 2 : 0;
    const score = pathname.includes("-768x") || pathname.includes("-1024x") ? 2 : 1;
    if (score > prevScore) byStem.set(stem, u);
  }

  const out = [];
  const seen = new Set();
  for (const u of byStem.values()) {
    if (!seen.has(u)) {
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
    title: doc.title || "One Piece - Đảo Hải Tặc",
    displayTitle: doc.title || "One Piece - Đảo Hải Tặc",
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
  console.error(`Fetch series page: ${seriesUrl}`);
  const seriesRes = await fetchHtml(seriesUrl);
  const meta = extractSeriesMeta(seriesRes.html, seriesRes.finalUrl);
  let chapterLinks = extractChapterLinks(seriesRes.html, seriesRes.finalUrl);

  chapterLinks = chapterLinks.filter((ch) => {
    if (!Number.isFinite(ch.chapterNumber)) return true;
    if (ch.chapterNumber < args.fromChapter) return false;
    return true;
  });
  if (args.limitChapters != null) {
    chapterLinks = chapterLinks.slice(0, args.limitChapters);
  }

  if (!chapterLinks.length) throw new Error("Không tìm thấy chapter links");

  const slug = slugify(meta.title) || "one-piece-dao-hai-tac";
  const outRel = args.outPath || `data-json/${slug}.json`;
  const outAbs = resolve(process.cwd(), outRel);
  const outFileName = outRel.split(/[/\\]/).pop();

  const existing = args.force ? null : await readJsonIfExists(outAbs);
  const { byUrl, byKey } = existingChapterLookup(existing);

  let skipped = 0;
  const targets = [];
  const carry = new Map();
  for (const ch of chapterLinks) {
    const keyUrl = canonicalChapterUrl(ch.url);
    const old = byUrl.get(keyUrl) || byKey.get(ch.chapterKey) || null;
    if (!args.force && old && Array.isArray(old.images) && old.images.length > 0) {
      skipped++;
      carry.set(keyUrl, old);
      continue;
    }
    targets.push(ch);
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
      `Cần fetch ${targets.length}/${chapterLinks.length} chapter (concurrency=${args.concurrency}, from=${args.fromChapter})${
        args.limitChapters != null ? `, limit=${args.limitChapters}` : ""
      }`
    );
  }

  let progress = 0;
  const results = targets.length
    ? await runPool(targets, args.concurrency, async (ch) => {
        const r = await fetchHtml(ch.url);
        const images = filterChapterImages(collectArticleImageUrls(r.html, r.finalUrl));
        progress++;
        process.stderr.write(
          `\r[${progress}/${targets.length}] Ch.${ch.chapterTitle} (${images.length} ảnh)`
        );
        return { ...ch, finalUrl: r.finalUrl, images };
      })
    : [];
  if (targets.length > 0) process.stderr.write("\n");

  const newWithImages = results.filter(
    (r) => r && Array.isArray(r.images) && r.images.length > 0
  );
  if (
    targets.length > 0 &&
    !newWithImages.length &&
    existing &&
    Array.isArray(existing.chapters) &&
    existing.chapters.length
  ) {
    console.error("Skip write: không tải được ảnh chương mới — giữ nguyên JSON.");
    return;
  }

  const fetchedByUrl = new Map(
    results
      .filter((r) => r && !r.error)
      .map((r) => [canonicalChapterUrl(r.url), r])
  );

  const chapters = [];
  for (const ch of chapterLinks) {
    const keyUrl = canonicalChapterUrl(ch.url);
    const fromFetch = fetchedByUrl.get(keyUrl);
    const fromCarry = carry.get(keyUrl);
    const r = fromFetch || fromCarry;
    if (!r) continue;

    const images = fromFetch
      ? Array.isArray(r.images)
        ? r.images
        : []
      : Array.isArray(r.images)
        ? r.images
        : [];
    if (!images.length) {
      if (fromFetch) {
        console.error(`\n  ! Ch.${ch.chapterTitle}: chương chưa có ảnh trên site`);
      }
      continue;
    }

    const base = fromCarry || {};
    chapters.push({
      title: base.title || ch.chapterTitle,
      chapter: Number.isFinite(ch.chapterNumber)
        ? ch.chapterNumber
        : Number.isFinite(base.chapter)
          ? base.chapter
          : undefined,
      chapterKey: ch.chapterKey,
      chapterLabel: ch.chapterLabel,
      url: ch.url,
      finalUrl: (fromFetch && r.finalUrl) || base.finalUrl || ch.url,
      total: images.length,
      images,
    });
  }

  if (!chapters.length) throw new Error("Không lấy được ảnh chapter nào");

  const nums = chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
  const doc = {
    sampleUrl: existing?.sampleUrl || chapters[0].url,
    homeUrl: seriesUrl,
    title: meta.title || existing?.title || "One Piece",
    fromChapter: nums.length ? Math.min(...nums) : 1,
    toChapter: nums.length ? Math.max(...nums) : nums.length,
    fetchedAt: new Date().toISOString(),
    source: DEFAULT_SOURCE,
    coverUrl: meta.coverUrl || existing?.coverUrl || "",
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
