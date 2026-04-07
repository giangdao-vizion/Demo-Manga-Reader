#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMgekoImagesFromUrl } from "./extract.mjs";

const CHAPTER_IN_PATH = /(.*-chapter-)(\d+)(-[^/]+)\/?$/i;
const DEFAULT_DELAY_MS = 450;
const DEFAULT_MAX_CHECKS = 25;

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <existing.json> [sampleChapterUrl] [maxChecks]

  existing.json      File JSON hiện có (ví dụ murim-login.json)
  sampleChapterUrl   Tùy chọn, ví dụ https://www.mgeko.cc/reader/en/murim-login-chapter-250-eng-li/
                     Nếu bỏ qua sẽ dùng sampleUrl trong JSON.
  maxChecks          Tùy chọn, số chapter kế tiếp tối đa cần thử (mặc định ${DEFAULT_MAX_CHECKS})

Logic:
  - Lấy chapter lớn nhất đang có (toChapter hoặc max chapter trong mảng)
  - Thử chapter +1, +2, ...
  - Nếu chapter mới hợp lệ (HTTP ok, redirect đúng chapter, có ảnh) => append vào JSON
  - Dừng khi gặp chapter không hợp lệ đầu tiên
`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseChapterFromSampleUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  const m = u.pathname.match(CHAPTER_IN_PATH);
  if (!m) return null;
  return { base: u, prefix: m[1], suffix: m[3], chapterInUrl: Number(m[2], 10) };
}

function chapterUrlFromNumber(parsed, chapterNum) {
  const u = new URL(parsed.base.href);
  u.pathname = `${parsed.prefix}${chapterNum}${parsed.suffix}/`;
  return u.href;
}

function chapterNumFromFinalUrl(finalUrl) {
  try {
    const p = new URL(finalUrl).pathname;
    const m = p.match(/-chapter-(\d+)(?:-[^/]+)?\/?$/i);
    return m ? Number(m[1], 10) : NaN;
  } catch {
    return NaN;
  }
}

function parseExistingJson(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON không hợp lệ: ${e.message || e}`);
  }
  if (!j || !Array.isArray(j.chapters)) {
    throw new Error('File thiếu mảng "chapters".');
  }
  return j;
}

function chapterNumberOf(ch, idx) {
  if (ch && Number.isFinite(ch.chapter)) return Number(ch.chapter);
  return idx + 1;
}

function detectCurrentMaxChapter(j) {
  const nums = j.chapters.map((c, i) => chapterNumberOf(c, i)).filter(Number.isFinite);
  const fromToMax = Number.isFinite(j.toChapter) ? Number(j.toChapter) : -Infinity;
  const arrMax = nums.length ? Math.max(...nums) : -Infinity;
  return Math.max(fromToMax, arrMax);
}

function hasChapter(j, chapterNum) {
  return j.chapters.some((c, i) => chapterNumberOf(c, i) === chapterNum);
}

async function main() {
  const [, , jsonArg, sampleArg, maxChecksArg] = process.argv;
  if (!jsonArg || jsonArg === "-h" || jsonArg === "--help") {
    usage();
    process.exit(jsonArg ? 0 : 1);
  }

  const jsonPath = resolve(process.cwd(), jsonArg);
  const raw = await readFile(jsonPath, "utf8");
  const doc = parseExistingJson(raw);

  const sampleUrl = (sampleArg && String(sampleArg).trim()) || doc.sampleUrl;
  if (!sampleUrl) {
    throw new Error("Không có sampleUrl. Hãy truyền tham số sampleChapterUrl.");
  }

  const parsed = parseChapterFromSampleUrl(sampleUrl);
  if (!parsed) {
    throw new Error(
      "sampleChapterUrl không khớp pattern ...-chapter-<số>-.../ (mgeko)."
    );
  }

  const maxChecks = (() => {
    const n = Number(maxChecksArg, 10);
    if (Number.isInteger(n) && n > 0) return n;
    return DEFAULT_MAX_CHECKS;
  })();

  let currentMax = detectCurrentMaxChapter(doc);
  if (!Number.isFinite(currentMax) || currentMax < 1) {
    currentMax = parsed.chapterInUrl;
  }

  let added = 0;
  for (let step = 1; step <= maxChecks; step++) {
    const n = currentMax + step;
    if (hasChapter(doc, n)) continue;

    const pageUrl = chapterUrlFromNumber(parsed, n);
    const result = await fetchMgekoImagesFromUrl(pageUrl);

    if (!result.ok) {
      process.stderr.write(`Stop at chapter ${n}: HTTP ${result.status}\n`);
      break;
    }

    const finalChapterNum = chapterNumFromFinalUrl(result.finalUrl);
    if (!Number.isFinite(finalChapterNum) || finalChapterNum !== n) {
      process.stderr.write(
        `Stop at chapter ${n}: redirect to chapter ${finalChapterNum}\n`
      );
      break;
    }

    const images = Array.isArray(result.images) ? result.images : [];
    if (images.length === 0) {
      process.stderr.write(`Stop at chapter ${n}: no images found\n`);
      break;
    }

    const entry = {
      title: `Chapter ${n}`,
      chapter: n,
      url: pageUrl,
      finalUrl: result.finalUrl,
      total: images.length,
      images,
    };
    doc.chapters.push(entry);
    added++;
    process.stderr.write(`Added chapter ${n}: ${images.length} image(s)\n`);
    await sleep(DEFAULT_DELAY_MS);
  }

  if (added > 0) {
    const nums = doc.chapters
      .map((c, i) => chapterNumberOf(c, i))
      .filter(Number.isFinite);
    if (nums.length) {
      doc.fromChapter = Number.isFinite(doc.fromChapter)
        ? Math.min(doc.fromChapter, ...nums)
        : Math.min(...nums);
      doc.toChapter = Math.max(...nums);
    }
    doc.fetchedAt = new Date().toISOString();
    if (!doc.sampleUrl) doc.sampleUrl = sampleUrl;
    if (!doc.source) doc.source = "mgeko";
    await writeFile(jsonPath, JSON.stringify(doc, null, 2), "utf8");
    console.error(`Updated ${jsonArg}: appended ${added} chapter(s).`);
  } else {
    console.error(`No new chapters found for ${jsonArg}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
