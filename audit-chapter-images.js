#!/usr/bin/env node
/**
 * Kiểm tra chapter trùng ảnh theo nội dung (SHA-256), không theo URL.
 *
 * Usage:
 *   node audit-chapter-images.js --data data-json/one-punch-man-onepunchmantruyen.json
 *   node audit-chapter-images.js --data ... --pair 163,212
 *   node audit-chapter-images.js --data ... --min-overlap 0.9 --pages all
 *   node audit-chapter-images.js --data ... --out reports/opm-dupes.json
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_HEADERS } from "./extract.mjs";

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_MIN_OVERLAP = 0.88;
const DEFAULT_PAGES = "sample5";
const DEFAULT_METHOD = "sha256";
const PERCEPTUAL_BITS = 64;
const PERCEPTUAL_MAX_HAMMING = 10;

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} --data <series.json> [options]

Options:
  --pair A,B          Chỉ so 2 chapter (vd. 163,212)
  --chapters LIST     Giới hạn chapter (vd. 160-220 hoặc 163,212,300)
  --pages MODE        sample3 | sample5 | all (mặc định: ${DEFAULT_PAGES})
  --method MODE       sha256 | perceptual (dHash 8×8, cần sharp)
  --min-overlap N     Ngưỡng trùng 0–1 (mặc định: ${DEFAULT_MIN_OVERLAP})
  --max-hamming N     Với perceptual: tối đa bit khác / ảnh (mặc định: ${PERCEPTUAL_MAX_HAMMING})
  --concurrency N     Tải ảnh song song (mặc định: ${DEFAULT_CONCURRENCY})
  --out PATH          Ghi báo cáo JSON
  --any-page          So khớp hash trùng ở BẤT KỲ trang nào (không chỉ cùng index mẫu)
  --quiet             Chỉ in cặp trùng / báo cáo
`);
}

function parseArgs(argv) {
  const out = {
    dataPath: "",
    pair: null,
    chapterFilter: null,
    pages: DEFAULT_PAGES,
    method: DEFAULT_METHOD,
    maxHamming: PERCEPTUAL_MAX_HAMMING,
    minOverlap: DEFAULT_MIN_OVERLAP,
    concurrency: DEFAULT_CONCURRENCY,
    outPath: "",
    anyPage: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--data" && argv[i + 1]) out.dataPath = String(argv[++i]).trim();
    else if (a === "--pair" && argv[i + 1]) {
      const parts = String(argv[++i])
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length >= 2) out.pair = [parts[0], parts[1]];
    } else if (a === "--chapters" && argv[i + 1]) {
      out.chapterFilter = String(argv[++i]).trim();
    } else if (a === "--pages" && argv[i + 1]) out.pages = String(argv[++i]).trim();
    else if (a === "--method" && argv[i + 1]) out.method = String(argv[++i]).trim();
    else if (a === "--max-hamming" && argv[i + 1]) {
      out.maxHamming = Number(argv[++i], 10);
    } else if (a === "--min-overlap" && argv[i + 1]) {
      out.minOverlap = Number(argv[++i]);
    } else if (a === "--concurrency" && argv[i + 1]) {
      out.concurrency = Number(argv[++i], 10);
    } else if (a === "--out" && argv[i + 1]) out.outPath = String(argv[++i]).trim();
    else if (a === "--any-page") out.anyPage = true;
    else if (a === "--quiet") out.quiet = true;
  }
  if (!Number.isFinite(out.minOverlap) || out.minOverlap < 0 || out.minOverlap > 1) {
    out.minOverlap = DEFAULT_MIN_OVERLAP;
  }
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) {
    out.concurrency = DEFAULT_CONCURRENCY;
  }
  if (out.concurrency > 16) out.concurrency = 16;
  return out;
}

function chapterId(ch) {
  return String(ch.chapterKey ?? ch.chapterLabel ?? ch.chapter ?? "").trim();
}

function parseChapterFilter(spec, chapters) {
  if (!spec) return null;
  const allowed = new Set();
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      for (const ch of chapters) {
        const n = Number(ch.chapter);
        if (Number.isFinite(n) && n >= lo && n <= hi) allowed.add(chapterId(ch));
      }
      continue;
    }
    allowed.add(p);
  }
  return allowed;
}

function pickPageIndices(total, mode) {
  if (total <= 0) return [];
  if (mode === "all") {
    return Array.from({ length: total }, (_, i) => i);
  }
  const n = mode === "sample3" ? 3 : 5;
  if (total <= n) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const indices = new Set([0, total - 1]);
  for (let k = 1; k < n - 1; k++) {
    indices.add(Math.round((k * (total - 1)) / (n - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

let sharpModule = null;

async function getSharp() {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = (await import("sharp")).default;
    return sharpModule;
  } catch {
    throw new Error('Thiếu package "sharp". Chạy: npm install sharp --save-dev');
  }
}

async function fetchImageBuffer(url) {
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 32) {
    throw new Error(`body too small (${buf.length} bytes)`);
  }
  return buf;
}

async function hashImageSha256(url) {
  const buf = await fetchImageBuffer(url);
  return createHash("sha256").update(buf).digest("hex");
}

async function hashImagePerceptual(url) {
  const sharp = await getSharp();
  const buf = await fetchImageBuffer(url);
  const { data } = await sharp(buf)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      bits += left > right ? "1" : "0";
    }
  }
  return bits;
}

function hammingBits(a, b) {
  if (!a || !b || a.length !== b.length) return PERCEPTUAL_BITS;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) d++;
  }
  return d;
}

async function hashImageUrl(url, method) {
  if (method === "perceptual") return hashImagePerceptual(url);
  return hashImageSha256(url);
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

function validHashes(hashes) {
  return hashes.filter(Boolean);
}

function overlapRatio(hashesA, hashesB) {
  const a = validHashes(hashesA);
  const b = validHashes(hashesB);
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hit = 0;
  for (const h of a) {
    if (setB.has(h)) hit++;
  }
  return hit / Math.min(a.length, b.length);
}

function orderedMatchRatio(hashesA, hashesB) {
  const len = Math.min(hashesA.length, hashesB.length);
  if (!len) return 0;
  let compared = 0;
  let hit = 0;
  for (let i = 0; i < len; i++) {
    if (!hashesA[i] || !hashesB[i]) continue;
    compared++;
    if (hashesA[i] === hashesB[i]) hit++;
  }
  return compared ? hit / compared : 0;
}

function comparePairAnyPage(idA, dataA, idB, dataB) {
  const setB = new Set(validHashes(dataB.hashes));
  const a = validHashes(dataA.hashes);
  if (!a.length || !setB.size) {
    return { overlapRatio: 0, orderedMatchRatio: 0, exactSequence: false, sharedHashCount: 0 };
  }
  let shared = 0;
  for (const h of a) {
    if (setB.has(h)) shared++;
  }
  const overlap = shared / Math.min(a.length, setB.size);
  return {
    overlapRatio: Math.round(overlap * 1000) / 1000,
    orderedMatchRatio: Math.round(overlap * 1000) / 1000,
    exactSequence: false,
    sharedHashCount: shared,
  };
}

function comparePair(idA, dataA, idB, dataB, opts) {
  const method = opts.method || DEFAULT_METHOD;
  const maxHamming = opts.maxHamming ?? PERCEPTUAL_MAX_HAMMING;

  if (opts.anyPage && method === "sha256") {
    const any = comparePairAnyPage(idA, dataA, idB, dataB);
    return {
      chapterA: idA,
      chapterB: idB,
      pagesCheckedA: dataA.indices.length,
      pagesCheckedB: dataB.indices.length,
      pageCountA: dataA.totalPages,
      pageCountB: dataB.totalPages,
      ...any,
      sampleIndicesA: dataA.indices,
      sampleIndicesB: dataB.indices,
      method,
      anyPageMatch: true,
    };
  }

  let overlap;
  let ordered;
  if (method === "perceptual") {
    const pairs = Math.min(dataA.hashes.length, dataB.hashes.length);
    let similar = 0;
    let compared = 0;
    let hamSum = 0;
    for (let i = 0; i < pairs; i++) {
      if (!dataA.hashes[i] || !dataB.hashes[i]) continue;
      compared++;
      const d = hammingBits(dataA.hashes[i], dataB.hashes[i]);
      hamSum += d;
      if (d <= maxHamming) similar++;
    }
    overlap = compared ? similar / compared : 0;
    ordered = overlap;
  } else {
    overlap = overlapRatio(dataA.hashes, dataB.hashes);
    ordered = orderedMatchRatio(dataA.hashes, dataB.hashes);
  }

  const exact =
    method !== "perceptual" &&
    dataA.hashes.length === dataB.hashes.length &&
    dataA.hashes.length > 0 &&
    dataA.hashes.every((h, i) => h && h === dataB.hashes[i]);
  return {
    chapterA: idA,
    chapterB: idB,
    pagesCheckedA: dataA.indices.length,
    pagesCheckedB: dataB.indices.length,
    pageCountA: dataA.totalPages,
    pageCountB: dataB.totalPages,
    overlapRatio: Math.round(overlap * 1000) / 1000,
    orderedMatchRatio: Math.round(ordered * 1000) / 1000,
    exactSequence: exact,
    sampleIndicesA: dataA.indices,
    sampleIndicesB: dataB.indices,
    sharedHashCount: dataA.hashes.filter((h) => h && dataB.hashes.includes(h)).length,
    method,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dataPath) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const absData = resolve(process.cwd(), args.dataPath);
  const doc = JSON.parse(await readFile(absData, "utf8"));
  if (!doc || !Array.isArray(doc.chapters)) {
    throw new Error('JSON thiếu mảng "chapters"');
  }

  let chapters = doc.chapters.filter((ch) => Array.isArray(ch.images) && ch.images.length > 0);
  const filterSet = parseChapterFilter(args.chapterFilter, chapters);
  if (filterSet) {
    chapters = chapters.filter((ch) => filterSet.has(chapterId(ch)));
  }
  if (args.pair) {
    const [a, b] = args.pair;
    chapters = chapters.filter((ch) => {
      const id = chapterId(ch);
      return id === a || id === b;
    });
    if (chapters.length < 2) {
      throw new Error(`Không đủ 2 chapter cho --pair ${a},${b}`);
    }
  }

  if (args.anyPage && args.pages !== "all") {
    if (!args.quiet) {
      console.error("--any-page: tự chuyển sang --pages all (cần hash mọi trang).");
    }
    args.pages = "all";
  }

  const tasks = [];
  for (const ch of chapters) {
    const id = chapterId(ch);
    const urls = ch.images.filter((u) => typeof u === "string" && u.trim());
    const indices = pickPageIndices(urls.length, args.pages);
    for (const idx of indices) {
      tasks.push({ chapterId: id, pageIndex: idx, url: urls[idx] });
    }
  }

  const method = args.method === "perceptual" ? "perceptual" : "sha256";

  if (!args.quiet) {
    console.error(
      `Audit ${absData}: ${chapters.length} chapter(s), ${tasks.length} ảnh (${args.pages}, ${method}), concurrency=${args.concurrency}`
    );
  }

  const hashCache = new Map();
  let done = 0;
  const taskResults = await runParallel(args.concurrency, tasks, async (task) => {
    const key = task.url;
    if (!hashCache.has(key)) {
      try {
        const hash = await hashImageUrl(task.url, method);
        hashCache.set(key, { hash, error: null });
      } catch (e) {
        hashCache.set(key, { hash: null, error: String(e.message || e) });
      }
    }
    const entry = hashCache.get(key);
    done++;
    if (!args.quiet) {
      process.stderr.write(
        `\r[${done}/${tasks.length}] ch.${task.chapterId} p${task.pageIndex + 1}`
      );
    }
    return { ...task, hash: entry.hash, error: entry.error };
  });
  if (!args.quiet && tasks.length) process.stderr.write("\n");

  const byChapter = new Map();
  for (const ch of chapters) {
    byChapter.set(chapterId(ch), {
      totalPages: ch.images.length,
      indices: [],
      hashes: [],
      urls: [],
      errors: [],
    });
  }
  for (const r of taskResults) {
    const bag = byChapter.get(r.chapterId);
    if (!bag) continue;
    bag.indices.push(r.pageIndex);
    bag.hashes.push(r.hash);
    bag.urls.push(r.url);
    if (r.error) bag.errors.push({ page: r.pageIndex + 1, error: r.error });
  }
  for (const bag of byChapter.values()) {
    const order = bag.indices
      .map((idx, i) => ({ idx, i }))
      .sort((a, b) => a.idx - b.idx);
    bag.indices = order.map((o) => o.idx);
    bag.hashes = order.map((o) => bag.hashes[o.i]);
    bag.urls = order.map((o) => bag.urls[o.i]);
  }

  const ids = [...byChapter.keys()];
  const duplicates = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const cmp = comparePair(ids[i], byChapter.get(ids[i]), ids[j], byChapter.get(ids[j]), {
        method,
        maxHamming: args.maxHamming,
        anyPage: args.anyPage,
      });
      if (
        cmp.exactSequence ||
        cmp.overlapRatio >= args.minOverlap ||
        cmp.orderedMatchRatio >= args.minOverlap
      ) {
        duplicates.push(cmp);
      }
    }
  }
  duplicates.sort(
    (a, b) =>
      Math.max(b.overlapRatio, b.orderedMatchRatio) -
      Math.max(a.overlapRatio, a.orderedMatchRatio)
  );

  const report = {
    dataFile: args.dataPath,
    title: doc.title || null,
    pagesMode: args.pages,
    method,
    maxHamming: method === "perceptual" ? args.maxHamming : null,
    anyPage: args.anyPage,
    minOverlap: args.minOverlap,
    chaptersScanned: ids.length,
    imagesHashed: tasks.length,
    hashErrors: [...hashCache.values()].filter((v) => v.error).length,
    duplicatePairs: duplicates,
    generatedAt: new Date().toISOString(),
  };

  if (args.pair && duplicates.length === 1) {
    const d = duplicates[0];
    console.log(
      `Ch.${d.chapterA} vs Ch.${d.chapterB}: overlap=${d.overlapRatio}, ordered=${d.orderedMatchRatio}, exact=${d.exactSequence}, sharedHashes=${d.sharedHashCount}/${Math.min(d.pagesCheckedA, d.pagesCheckedB)} pages sampled`
    );
  } else if (duplicates.length) {
    console.log(`Phát hiện ${duplicates.length} cặp chapter có ảnh trùng (ngưỡng ≥ ${args.minOverlap}):`);
    for (const d of duplicates.slice(0, 50)) {
      console.log(
        `  Ch.${d.chapterA} ↔ Ch.${d.chapterB}  overlap=${d.overlapRatio}  ordered=${d.orderedMatchRatio}${d.exactSequence ? "  EXACT" : ""}`
      );
    }
    if (duplicates.length > 50) {
      console.log(`  … và ${duplicates.length - 50} cặp khác`);
    }
  } else {
    console.log(
      `Không có cặp trùng ở ngưỡng ${args.minOverlap} (mode=${args.pages}, ${ids.length} chapter).`
    );
  }

  if (args.outPath) {
    const outAbs = resolve(process.cwd(), args.outPath);
    await mkdir(dirname(outAbs), { recursive: true });
    await writeFile(outAbs, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.error(`Wrote ${outAbs}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
