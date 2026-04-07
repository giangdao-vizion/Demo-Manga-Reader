#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchArticleImagesFromUrl } from "./extract.mjs";

/** Path ...-chapter-96 hoặc ...-chapter-96/ */
const CHAPTER_IN_PATH = /-chapter-(\d+)\/?$/i;

function parseChapterFromSampleUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  const m = u.pathname.match(CHAPTER_IN_PATH);
  if (!m) return null;
  return { base: u, chapterInUrl: Number(m[1], 10) };
}

function chapterUrlFromNumber(parsed, chapterNum) {
  const u = new URL(parsed.base.href);
  u.pathname = u.pathname.replace(CHAPTER_IN_PATH, `-chapter-${chapterNum}/`);
  return u.href;
}

function chapterNumFromFinalUrl(finalUrl) {
  try {
    const p = new URL(finalUrl).pathname;
    const m = p.match(/-chapter-(\d+)/i);
    return m ? Number(m[1], 10) : NaN;
  } catch {
    return NaN;
  }
}

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <chapter-url> <fromChapter> <toChapter> [output.json]

  chapter-url    Ví dụ: https://w8.returnersmagicshould.com/manga/a-returners-magic-should-be-special-chapter-96/
  fromChapter    Số chapter bắt đầu (ví dụ 96)
  toChapter      Số chapter kết thúc (ví dụ 110), bao gồm cả hai đầu
  output.json    Mặc định: chapters-returnersmagic-batch.json

  Ảnh lấy theo selector: article img
  Mỗi phần tử trong "chapters" có: title, chapter, url, finalUrl, total, images
  (và error nếu request thất bại hoặc redirect sai).`);
}

const DELAY_MS = 450;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const [, , urlArg, fromArg, toArg, outArg] = process.argv;
  if (!urlArg || urlArg === "-h" || urlArg === "--help") {
    usage();
    process.exit(urlArg ? 0 : 1);
  }

  const fromChapter = Number(fromArg, 10);
  const toChapter = Number(toArg, 10);
  if (
    !Number.isInteger(fromChapter) ||
    !Number.isInteger(toChapter) ||
    fromChapter < 1 ||
    toChapter < fromChapter
  ) {
    console.error("fromChapter / toChapter phải là số nguyên và from <= to.");
    process.exit(1);
  }

  const parsed = parseChapterFromSampleUrl(urlArg);
  if (!parsed) {
    console.error(
      "URL không khớp pattern ...-chapter-<số>/ (ví dụ ...-chapter-96/)."
    );
    process.exit(1);
  }

  if (parsed.chapterInUrl !== fromChapter) {
    console.warn(
      `Cảnh báo: URL mẫu là chapter ${parsed.chapterInUrl} nhưng fromChapter=${fromChapter}. Vẫn tiếp tục với range ${fromChapter}–${toChapter}.`
    );
  }

  const outPath = resolve(
    process.cwd(),
    outArg || "chapters-returnersmagic-batch.json"
  );
  const chapters = [];

  for (let n = fromChapter; n <= toChapter; n++) {
    const pageUrl = chapterUrlFromNumber(parsed, n);
    const result = await fetchArticleImagesFromUrl(pageUrl);

    const finalChapterNum = chapterNumFromFinalUrl(result.finalUrl);
    const redirectedAway =
      result.ok && (Number.isNaN(finalChapterNum) || finalChapterNum !== n);

    const entry = {
      title: `Chapter ${n}`,
      chapter: n,
      url: pageUrl,
      finalUrl: result.finalUrl,
      total: result.images.length,
      images: result.images,
    };

    if (!result.ok) {
      entry.error = `HTTP ${result.status} ${result.statusText || ""}`.trim();
    } else if (redirectedAway) {
      entry.error = `Unexpected redirect (chapter in finalUrl !== ${n}, got ${finalChapterNum})`;
    } else if (result.images.length === 0) {
      entry.error = "No images found (selector article img)";
    }

    chapters.push(entry);
    process.stderr.write(
      `Chapter ${n}: ${result.images.length} image(s)${
        entry.error ? ` — ${entry.error}` : ""
      }\n`
    );

    if (n < toChapter) await sleep(DELAY_MS);
  }

  const payload = {
    sampleUrl: urlArg,
    fromChapter,
    toChapter,
    fetchedAt: new Date().toISOString(),
    source: "returnersmagicshould",
    chapters,
  };

  await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.error(`\nWrote ${chapters.length} chapter(s) to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
