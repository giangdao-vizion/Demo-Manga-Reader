#!/usr/bin/env node
/**
 * Retry qimanga chapters that failed with recoverable errors (429 / 5xx / No images).
 * Skips paywalled chapters ("Requires purchase / locked").
 *
 * Usage:
 *   node retry-qimanga-failed.js
 *   node retry-qimanga-failed.js --concurrency 4
 *   node retry-qimanga-failed.js --file data-json/martial-peak-qimanga.json
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const API = "https://api.qimanga.com/api/v1";
const SITE = "https://qimanga.com";
const DEFAULT_CONCURRENCY = 4;
const HEADERS = {
  Accept: "application/json",
  Origin: SITE,
  Referer: `${SITE}/`,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function parseArgs(argv) {
  const out = { concurrency: DEFAULT_CONCURRENCY, file: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--concurrency" && argv[i + 1]) out.concurrency = Number(argv[++i], 10);
    else if (a === "--file" && argv[i + 1]) out.file = String(argv[++i]).trim();
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = DEFAULT_CONCURRENCY;
  if (out.concurrency > 8) out.concurrency = 8;
  return out;
}

function isLockedError(err) {
  return /Requires purchase|locked/i.test(String(err || ""));
}

function isRetryableChapter(ch) {
  const empty = !Array.isArray(ch.images) || ch.images.length === 0;
  if (!empty) return false;
  if (isLockedError(ch.error)) return false;
  return true;
}

function chapterSlugFromUrl(url, seriesSlug) {
  try {
    const p = new URL(url).pathname.replace(/\/$/, "");
    const prefix = `/series/${seriesSlug}/`;
    if (p.startsWith(prefix)) return p.slice(prefix.length);
    const parts = p.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch {
    return "";
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiGet(path, { retries = 8 } = {}) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* ignore */
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        // Longer backoff for rate limits
        const wait = res.status === 429
          ? 1500 * (attempt + 1) * (attempt + 1)
          : 600 * (attempt + 1) * (attempt + 1);
        await sleep(Math.min(wait, 20000));
        continue;
      }
      if (!res.ok) {
        const msg = json?.message || res.statusText || "";
        throw new Error(`HTTP ${res.status} ${url}${msg ? `: ${msg}` : ""}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * (attempt + 1));
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
    images,
    requiresPurchase: Boolean(j.requiresPurchase),
    isFree: j.isFree !== false,
    totalImages: j.totalImages ?? images.length,
  };
}

async function retryFile(absPath, concurrency) {
  const doc = JSON.parse(await readFile(absPath, "utf8"));
  const seriesSlug = doc.seriesSlug || "";
  if (!seriesSlug || !Array.isArray(doc.chapters)) {
    return { file: absPath, skipped: true, reason: "invalid doc" };
  }

  const targets = [];
  for (let i = 0; i < doc.chapters.length; i++) {
    const ch = doc.chapters[i];
    if (!isRetryableChapter(ch)) continue;
    const chapterSlug = chapterSlugFromUrl(ch.url, seriesSlug) || `chapter-${ch.chapterKey || ch.chapter}`;
    targets.push({ index: i, chapterSlug, chapterKey: ch.chapterKey || String(ch.chapter) });
  }
  if (!targets.length) return { file: absPath, title: doc.title, targets: 0, fixed: 0, stillBad: 0, lockedNow: 0 };

  console.error(`\n=== ${doc.title || seriesSlug}: retry ${targets.length} chapter(s) ===`);
  let fixed = 0;
  let lockedNow = 0;
  let stillBad = 0;

  await runParallel(concurrency, targets, async (item, idx) => {
    process.stderr.write(`\r[${idx + 1}/${targets.length}] Ch.${item.chapterKey}`);
    try {
      const result = await fetchChapterImages(seriesSlug, item.chapterSlug);
      const ch = doc.chapters[item.index];
      if (result.requiresPurchase && result.images.length === 0) {
        ch.images = [];
        ch.total = 0;
        ch.error = "Requires purchase / locked";
        lockedNow++;
        return;
      }
      if (result.images.length > 0) {
        ch.images = result.images;
        ch.total = result.images.length;
        delete ch.error;
        fixed++;
      } else {
        ch.images = [];
        ch.total = 0;
        ch.error = "No images";
        stillBad++;
      }
    } catch (e) {
      doc.chapters[item.index].error = String(e.message || e);
      stillBad++;
    }
  });
  process.stderr.write("\n");

  doc.fetchedAt = new Date().toISOString();
  await writeFile(absPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.error(`Fixed ${fixed}, locked-now ${lockedNow}, still-bad ${stillBad} -> ${absPath}`);
  return {
    file: absPath,
    title: doc.title,
    targets: targets.length,
    fixed,
    lockedNow,
    stillBad,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.error("Usage: node retry-qimanga-failed.js [--concurrency N] [--file PATH]");
    process.exit(0);
  }

  let files;
  if (args.file) {
    files = [resolve(process.cwd(), args.file)];
  } else {
    const names = (await readdir("data-json")).filter((f) => f.endsWith("-qimanga.json")).sort();
    files = names.map((f) => join(process.cwd(), "data-json", f));
  }

  console.error(`Retry recoverable failed chapters (concurrency=${args.concurrency})`);
  const results = [];
  for (const f of files) {
    const r = await retryFile(f, args.concurrency);
    if (r.targets > 0 || r.skipped) results.push(r);
  }

  const summary = {
    fetchedAt: new Date().toISOString(),
    seriesProcessed: results.filter((r) => r.targets > 0).length,
    targets: results.reduce((n, r) => n + (r.targets || 0), 0),
    fixed: results.reduce((n, r) => n + (r.fixed || 0), 0),
    lockedNow: results.reduce((n, r) => n + (r.lockedNow || 0), 0),
    stillBad: results.reduce((n, r) => n + (r.stillBad || 0), 0),
    results: results.filter((r) => r.targets > 0),
  };
  await writeFile(
    resolve(process.cwd(), "qimanga-retry-report.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf8"
  );
  console.error(
    `\nDone: fixed ${summary.fixed}/${summary.targets}, locked-now ${summary.lockedNow}, still-bad ${summary.stillBad}`
  );
  if (summary.stillBad > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
