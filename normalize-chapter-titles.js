#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function normalizeChapterLabel(value) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return "";
  if (/^\d+(?:\.\d+)?$/.test(s)) return s;

  const m = s.match(/^(\d+)(?:[._-](\d+))?/);
  if (!m) return "";
  if (m[2] != null) return `${m[1]}.${m[2]}`;
  return m[1];
}

function chapterLabelFromChapter(chapterValue) {
  const n = Number(chapterValue);
  if (Number.isFinite(n)) {
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return String(n);
  }
  return normalizeChapterLabel(chapterValue);
}

function getNormalizedChapterTitle(ch, idx) {
  const fromKey = normalizeChapterLabel(ch && ch.chapterKey);
  if (fromKey) return fromKey;

  const fromLabel = normalizeChapterLabel(ch && ch.chapterLabel);
  if (fromLabel) return fromLabel;

  const fromChapter = chapterLabelFromChapter(ch && ch.chapter);
  if (fromChapter) return fromChapter;

  const fromTitle = normalizeChapterLabel(ch && ch.title);
  if (fromTitle) return fromTitle;

  return String(idx + 1);
}

async function main() {
  const root = process.cwd();
  const dataDir = resolve(root, "data-json");
  const all = await readdir(dataDir);
  const files = all.filter((name) => name.toLowerCase().endsWith(".json")).sort();

  let touchedFiles = 0;
  let touchedTitles = 0;

  for (const name of files) {
    const fullPath = resolve(dataDir, name);
    let doc;
    try {
      doc = JSON.parse(await readFile(fullPath, "utf8"));
    } catch (err) {
      console.error(`Skip ${name}: invalid JSON (${err.message || err})`);
      continue;
    }
    if (!doc || !Array.isArray(doc.chapters)) continue;

    let changed = 0;
    doc.chapters.forEach((ch, idx) => {
      if (!ch || typeof ch !== "object") return;
      const nextTitle = getNormalizedChapterTitle(ch, idx);
      if (String(ch.title || "") !== nextTitle) {
        ch.title = nextTitle;
        changed++;
      }
    });

    if (changed > 0) {
      await writeFile(fullPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
      touchedFiles++;
      touchedTitles += changed;
      console.log(`${name}: updated ${changed} title(s)`);
    }
  }

  console.log(`Done. Updated ${touchedTitles} chapter title(s) in ${touchedFiles} file(s).`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

