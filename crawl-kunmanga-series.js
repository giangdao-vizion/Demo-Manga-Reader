#!/usr/bin/env node
/**
 * Crawl toàn bộ (hoặc một đoạn) chapter KunManga (Madara API + HTML reader),
 * ghi JSON kiểu data-json/*.json và cập nhật manhwa-catalog.json.
 *
 * Usage:
 *   node crawl-kunmanga-series.js --slug murim-rpg-simulation
 *   node crawl-kunmanga-series.js --slug murim-rpg-simulation --from 1 --to 10
 *   node crawl-kunmanga-series.js --slug murim-rpg-simulation --out data-json/murim-rpg-simulation.json
 *
 * Options:
 *   --origin URL        Mặc định https://www.kunmanga.online
 *   --from N            Chapter số tối thiểu (chapter_num API)
 *   --to N              Chapter số tối đa
 *   --delay MS          Chờ giữa mỗi chapter (mặc định 400)
 *   --out PATH          Mặc định data-json/<slug>.json
 *   --no-catalog        Không sửa manhwa-catalog.json
 *   --catalog PATH      Mặc định manhwa-catalog.json
 *   --cover-url URL     Ảnh bìa trong catalog (mặc định lấy og:image từ trang chapter đầu tiên)
 *   --cookie "a=b"      hoặc env KUNMANGA_COOKIE
 *   --merge             Giữ chapter đã có trong file --out, chỉ tải các số còn thiếu trong khoảng --from/--to
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { BROWSER_HEADERS, fetchKunMangaImagesFromUrl } from "./extract.mjs";

const DEFAULT_ORIGIN = "https://www.kunmanga.online";
const DEFAULT_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} --slug <comic-slug> [options]

Bắt buộc: --slug (vd. murim-rpg-simulation từ /manga/murim-rpg-simulation/chapter-51)

Options:
  --origin ${DEFAULT_ORIGIN}
  --from N --to N
  --delay ${DEFAULT_DELAY_MS}
  --out data-json/<slug>.json
  --no-catalog
  --catalog manhwa-catalog.json
  --cover-url URL
  --cookie / KUNMANGA_COOKIE
  --merge
`);
}

function parseArgs(argv) {
  const out = {
    slug: "",
    origin: DEFAULT_ORIGIN,
    fromChapter: null,
    toChapter: null,
    delayMs: DEFAULT_DELAY_MS,
    outPath: null,
    updateCatalog: true,
    catalogPath: "manhwa-catalog.json",
    coverUrl: null,
    cookie: "",
    merge: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--slug" && argv[i + 1]) out.slug = String(argv[++i]).trim();
    else if (a === "--origin" && argv[i + 1])
      out.origin = String(argv[++i]).replace(/\/$/, "");
    else if (a === "--from" && argv[i + 1])
      out.fromChapter = Number(argv[++i], 10);
    else if (a === "--to" && argv[i + 1])
      out.toChapter = Number(argv[++i], 10);
    else if (a === "--delay" && argv[i + 1])
      out.delayMs = Number(argv[++i], 10);
    else if (a === "--out" && argv[i + 1]) out.outPath = String(argv[++i]).trim();
    else if (a === "--no-catalog") out.updateCatalog = false;
    else if (a === "--catalog" && argv[i + 1])
      out.catalogPath = String(argv[++i]).trim();
    else if (a === "--cover-url" && argv[i + 1])
      out.coverUrl = String(argv[++i]).trim();
    else if (a === "--cookie" && argv[i + 1])
      out.cookie = String(argv[++i]).trim();
    else if (a === "--merge") out.merge = true;
  }
  const envCookie = String(process.env.KUNMANGA_COOKIE || "").trim();
  if (envCookie && !out.cookie) out.cookie = envCookie;
  return out;
}

async function fetchJson(url, cookie) {
  const headers = { ...BROWSER_HEADERS, accept: "application/json" };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, redirect: "follow" });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`JSON lỗi ${res.status} ${url}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || !j || j.success !== true) {
    throw new Error(`API lỗi ${res.status} ${url}: ${text.slice(0, 300)}`);
  }
  return j;
}

async function fetchAllChapterRows(origin, slug, cookie) {
  const base = `${origin}/api/comics/${encodeURIComponent(slug)}/chapters`;
  const first = await fetchJson(`${base}?page=1`, cookie);
  const data = first.data;
  const rows = [...(data.chapters || [])];
  const lastPage = Number(data.last_page, 10) || 1;
  for (let p = 2; p <= lastPage; p++) {
    const j = await fetchJson(`${base}?page=${p}`, cookie);
    rows.push(...(j.data.chapters || []));
  }
  rows.sort((a, b) => a.chapter_num - b.chapter_num);
  return rows;
}

function chapterPageUrl(origin, slug, chapterSlug) {
  return `${origin}/manga/${encodeURIComponent(slug)}/${encodeURIComponent(chapterSlug)}`;
}

async function metaFromChapterHtml(url, cookie) {
  const headers = { ...BROWSER_HEADERS };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) return { coverUrl: null, title: null };
  const html = await res.text();
  const $ = cheerio.load(html);
  const og = $('meta[property="og:image"]').attr("content");
  const coverUrl = og && String(og).trim() ? String(og).trim() : null;
  const h1 = ($("#chapter-heading").text() || "").trim();
  let title = null;
  const dash = h1.indexOf(" - ");
  if (dash > 0) title = h1.slice(0, dash).trim();
  return { coverUrl, title };
}

function displayTitleFromSlug(slug) {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

async function updateCatalogFile(catalogPath, seriesEntry) {
  const abs = resolve(process.cwd(), catalogPath);
  const raw = await readFile(abs, "utf8");
  const cat = JSON.parse(raw);
  if (!cat.series || !Array.isArray(cat.series)) {
    throw new Error("manhwa-catalog.json thiếu mảng series");
  }
  const dataFile = seriesEntry.dataFile;
  const idx = cat.series.findIndex((s) => s.dataFile === dataFile);
  if (idx >= 0) cat.series[idx] = { ...cat.series[idx], ...seriesEntry };
  else {
    const murimIdx = cat.series.findIndex((s) => s.dataFile === "murim-login.json");
    const insertAt = murimIdx >= 0 ? murimIdx + 1 : cat.series.length;
    cat.series.splice(insertAt, 0, seriesEntry);
  }
  cat.updatedAt = new Date().toISOString();
  await writeFile(abs, JSON.stringify(cat, null, 2) + "\n", "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.slug) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const slug = args.slug;
  const origin = args.origin;
  const cookie = args.cookie || undefined;

  console.error(`Listing chapters: ${slug} …`);
  const rows = await fetchAllChapterRows(origin, slug, cookie);
  if (!rows.length) {
    console.error("Không có chapter nào từ API.");
    process.exit(1);
  }

  const minNum = rows[0].chapter_num;
  const maxNum = rows[rows.length - 1].chapter_num;
  let fromN =
    Number.isFinite(args.fromChapter) && args.fromChapter > 0
      ? args.fromChapter
      : minNum;
  let toN =
    Number.isFinite(args.toChapter) && args.toChapter > 0
      ? args.toChapter
      : maxNum;
  if (fromN > toN) [fromN, toN] = [toN, fromN];

  const inRange = rows.filter(
    (r) => r.chapter_num >= fromN && r.chapter_num <= toN
  );
  if (!inRange.length) {
    console.error(`Không chapter nào trong khoảng ${fromN}–${toN}.`);
    process.exit(1);
  }

  const outPath = resolve(
    process.cwd(),
    args.outPath || `data-json/${slug}.json`
  );

  let existingByNum = new Map();
  if (args.merge) {
    try {
      const prev = JSON.parse(await readFile(outPath, "utf8"));
      if (Array.isArray(prev.chapters)) {
        for (const ch of prev.chapters) {
          if (Number.isFinite(ch.chapter)) existingByNum.set(ch.chapter, ch);
        }
      }
    } catch {
      /* file mới */
    }
  }

  const newEntries = new Map();
  let errors = 0;
  const toFetch = inRange.filter((r) => !existingByNum.has(r.chapter_num));
  const skipped = inRange.length - toFetch.length;
  if (skipped) console.error(`--merge: bỏ qua ${skipped} chapter đã có trong file.`);

  if (!toFetch.length && existingByNum.size > 0) {
    console.error("Skip write: không có chương mới cần cập nhật JSON.");
    return;
  }

  for (let i = 0; i < toFetch.length; i++) {
    const row = toFetch[i];
    const pageUrl = chapterPageUrl(origin, slug, row.chapter_slug);
    process.stderr.write(
      `\r[${i + 1}/${toFetch.length}] Chapter ${row.chapter_num} …`
    );

    const result = await fetchKunMangaImagesFromUrl(pageUrl, { cookie });
    if (!result.ok) {
      console.error(`\nHTTP ${result.status} ${pageUrl}`);
      errors++;
      continue;
    }
    const images = Array.isArray(result.images) ? result.images : [];
    if (images.length === 0) {
      console.error(`\nKhông có ảnh: ${pageUrl}`);
      errors++;
      continue;
    }

    newEntries.set(row.chapter_num, {
      title: row.chapter_name || `Chapter ${row.chapter_num}`,
      chapter: row.chapter_num,
      url: pageUrl,
      finalUrl: result.finalUrl,
      total: images.length,
      images,
    });

    if (i < toFetch.length - 1 && args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  process.stderr.write("\n");

  if (toFetch.length > 0 && newEntries.size === 0 && existingByNum.size > 0) {
    console.error("Skip write: không tải được ảnh chương mới — giữ nguyên JSON.");
    return;
  }

  const sorted = [];
  for (const row of inRange) {
    const n = row.chapter_num;
    if (newEntries.has(n)) sorted.push(newEntries.get(n));
    else if (existingByNum.has(n)) sorted.push(existingByNum.get(n));
  }

  if (!sorted.length) {
    console.error("Không ghi file: không có chapter hợp lệ.");
    process.exit(1);
  }
  const lo = sorted[0].chapter;
  const hi = sorted[sorted.length - 1].chapter;
  const sampleUrl = sorted[sorted.length - 1].url;

  const doc = {
    sampleUrl,
    fromChapter: lo,
    toChapter: hi,
    fetchedAt: new Date().toISOString(),
    source: "kunmanga",
    chapters: sorted,
  };

  await writeFile(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.error(`Wrote ${sorted.length} chapter(s) → ${outPath}`);
  if (errors) console.error(`Cảnh báo: ${errors} chapter bỏ qua do lỗi.`);

  if (args.updateCatalog) {
    const meta = await metaFromChapterHtml(sorted[0].url, cookie);
    const cover = args.coverUrl || meta.coverUrl || null;
    const dataFile = outPath.split(/[/\\]/).pop();
    const titleGuess = meta.title || displayTitleFromSlug(slug);
    await updateCatalogFile(args.catalogPath, {
      dataFile,
      title: titleGuess,
      displayTitle: titleGuess,
      subtitle: `Ch. ${lo}–${hi} · ${dataFile}`,
      source: "kunmanga",
      fromChapter: lo,
      toChapter: hi,
      chapterCount: sorted.length,
      sqliteSeriesId: null,
      contentSyncComplete: false,
      contentSyncNote: null,
      coverUrl: cover,
    });
    console.error(`Updated catalog: ${args.catalogPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
