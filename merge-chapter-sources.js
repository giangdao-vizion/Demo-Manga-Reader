#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FEW_IMAGES_THRESHOLD = 2;

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <source1.json> <source2.json> [output.json]

Merge rule:
  - Chapter chỉ có ở 1 nguồn: lấy nguồn đó
  - Chapter có ở cả 2 nguồn, một bên chỉ 1-2 ảnh: lấy bên còn lại
  - Chapter có ở cả 2 nguồn, cả 2 bên đều >2 ảnh: lấy nguồn 1

Output mặc định: chapters-merged.json`);
}

function parseJson(text, label) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} không phải JSON hợp lệ: ${e.message || e}`);
  }
  if (!j || !Array.isArray(j.chapters)) {
    throw new Error(`${label} thiếu mảng "chapters".`);
  }
  return j;
}

function chapterNumOf(ch, i) {
  if (ch && Number.isFinite(ch.chapter)) return Number(ch.chapter);
  return i + 1;
}

function imageCountOf(ch) {
  if (!ch || !Array.isArray(ch.images)) return 0;
  return ch.images.length;
}

function withUpdatedTotal(ch) {
  if (!ch) return ch;
  const images = Array.isArray(ch.images) ? ch.images : [];
  return { ...ch, total: images.length };
}

function buildChapterMap(chapters) {
  const map = new Map();
  chapters.forEach((ch, i) => {
    const n = chapterNumOf(ch, i);
    if (!Number.isFinite(n)) return;
    if (!map.has(n)) map.set(n, ch);
  });
  return map;
}

async function main() {
  const [, , src1Arg, src2Arg, outArg] = process.argv;
  if (!src1Arg || !src2Arg || src1Arg === "-h" || src1Arg === "--help") {
    usage();
    process.exit(src1Arg ? 0 : 1);
  }

  const src1Path = resolve(process.cwd(), src1Arg);
  const src2Path = resolve(process.cwd(), src2Arg);
  const outPath = resolve(process.cwd(), outArg || "chapters-merged.json");

  const [raw1, raw2] = await Promise.all([
    readFile(src1Path, "utf8"),
    readFile(src2Path, "utf8"),
  ]);
  const j1 = parseJson(raw1, "Nguồn 1");
  const j2 = parseJson(raw2, "Nguồn 2");

  const m1 = buildChapterMap(j1.chapters);
  const m2 = buildChapterMap(j2.chapters);
  const chapterNums = Array.from(new Set([...m1.keys(), ...m2.keys()])).sort(
    (a, b) => a - b
  );

  const chapters = [];
  let from1Only = 0;
  let from2Only = 0;
  let from1Preferred = 0;
  let from2FixedFew = 0;
  let from1FixedFew = 0;

  for (const n of chapterNums) {
    const c1 = m1.get(n);
    const c2 = m2.get(n);
    let chosen;
    let pickedFrom = "";

    if (c1 && !c2) {
      chosen = c1;
      pickedFrom = "source1-only";
      from1Only++;
    } else if (!c1 && c2) {
      chosen = c2;
      pickedFrom = "source2-only";
      from2Only++;
    } else {
      const k1 = imageCountOf(c1);
      const k2 = imageCountOf(c2);
      const c1Few = k1 <= FEW_IMAGES_THRESHOLD;
      const c2Few = k2 <= FEW_IMAGES_THRESHOLD;

      if (c1Few && !c2Few) {
        chosen = c2;
        pickedFrom = "source2-fix-source1-few-images";
        from2FixedFew++;
      } else if (!c1Few && c2Few) {
        chosen = c1;
        pickedFrom = "source1-fix-source2-few-images";
        from1FixedFew++;
      } else {
        chosen = c1;
        pickedFrom = "source1-preferred";
        from1Preferred++;
      }
    }

    const outCh = withUpdatedTotal(chosen);
    outCh.mergePickedFrom = pickedFrom;
    chapters.push(outCh);
  }

  const fromChapter = chapters.length
    ? Math.min(...chapters.map((c, i) => chapterNumOf(c, i)))
    : null;
  const toChapter = chapters.length
    ? Math.max(...chapters.map((c, i) => chapterNumOf(c, i)))
    : null;

  const payload = {
    mergedFrom: [
      {
        path: src1Arg,
        sampleUrl: j1.sampleUrl || null,
        source: j1.source || "source1",
      },
      {
        path: src2Arg,
        sampleUrl: j2.sampleUrl || null,
        source: j2.source || "source2",
      },
    ],
    rule: "prefer source1 unless one side has <=2 images and the other side has >2 images",
    fromChapter,
    toChapter,
    fetchedAt: new Date().toISOString(),
    summary: {
      totalChapters: chapters.length,
      from1Only,
      from2Only,
      from1Preferred,
      from2FixedFew,
      from1FixedFew,
    },
    chapters,
  };

  await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.error(`Wrote ${chapters.length} merged chapter(s) to ${outPath}`);
  console.error(
    `Stats: source1-only=${from1Only}, source2-only=${from2Only}, source1-preferred=${from1Preferred}, source2-fixed-few=${from2FixedFew}, source1-fixed-few=${from1FixedFew}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
