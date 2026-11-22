#!/usr/bin/env node
/**
 * Crawl lần lượt các series Asura trong queue JSON.
 *
 * Usage:
 *   node batch-crawl-asura-missing.js [queue.json] [--start N] [--concurrency 5]
 *
 * Ghi status vào reports/asura-55-crawl-status.jsonl sau mỗi bộ.
 */
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    queuePath: "reports/asura-55-crawl-queue.json",
    start: 1,
    concurrency: 5,
    statusPath: "reports/asura-55-crawl-status.jsonl",
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start" && argv[i + 1]) out.start = Number(argv[++i], 10);
    else if (a === "--concurrency" && argv[i + 1]) out.concurrency = Number(argv[++i], 10);
    else if (a === "--status" && argv[i + 1]) out.statusPath = String(argv[++i]).trim();
    else if (!a.startsWith("-")) positional.push(a);
  }
  if (positional[0]) out.queuePath = positional[0];
  if (!Number.isInteger(out.start) || out.start < 1) out.start = 1;
  if (!Number.isInteger(out.concurrency) || out.concurrency < 1) out.concurrency = 5;
  if (out.concurrency > 10) out.concurrency = 10;
  return out;
}

function runCrawl(seriesUrl, title, concurrency) {
  return new Promise((resolveDone) => {
    const args = [
      resolve(ROOT, "crawl-asura-series.js"),
      seriesUrl,
      "--title",
      title,
      "--concurrency",
      String(concurrency),
    ];
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf) => {
      const s = buf.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (buf) => {
      const s = buf.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on("close", (code) => {
      resolveDone({ code: code ?? 1, stdout, stderr });
    });
  });
}

function slugFromUrl(seriesUrl) {
  try {
    const p = new URL(seriesUrl).pathname.replace(/\/$/, "");
    const m = p.match(/\/comics\/([^/]+)/i);
    if (!m) return "";
    return m[1].replace(/-[0-9a-f]{6,}$/i, "").toLowerCase();
  } catch {
    return "";
  }
}

async function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queueAbs = resolve(ROOT, args.queuePath);
  const statusAbs = resolve(ROOT, args.statusPath);
  await mkdir(dirname(statusAbs), { recursive: true });

  const queue = await readJsonSafe(queueAbs, null);
  if (!queue || !Array.isArray(queue.series)) {
    throw new Error(`Queue không hợp lệ: ${args.queuePath}`);
  }

  const summaryPath = resolve(ROOT, "reports/asura-55-crawl-summary.json");
  const summary = (await readJsonSafe(summaryPath, null)) || {
    startedAt: new Date().toISOString(),
    total: queue.series.length,
    results: [],
  };

  const doneIndexes = new Set(
    (summary.results || [])
      .filter((r) => r && r.ok)
      .map((r) => Number(r.index))
  );

  console.error(
    `Batch crawl ${queue.series.length} series (start=${args.start}, concurrency=${args.concurrency})`
  );

  for (const item of queue.series) {
    if (item.index < args.start) continue;
    if (doneIndexes.has(item.index)) {
      console.error(`\n[${item.index}/${queue.series.length}] SKIP already ok: ${item.title}`);
      continue;
    }

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    console.error(`\n========== [${item.index}/${queue.series.length}] ${item.title} ==========`);
    console.error(`URL: ${item.seriesUrl}`);
    console.error(`Expected chapters (browse): ${item.chapterCount}`);

    const result = await runCrawl(item.seriesUrl, item.title, args.concurrency);
    const elapsedMs = Date.now() - t0;
    const slug = slugFromUrl(item.seriesUrl);
    const dataFile = slug ? `${slug}.json` : null;
    let chapterCount = null;
    let fromChapter = null;
    let toChapter = null;
    if (dataFile) {
      const doc = await readJsonSafe(resolve(ROOT, "data-json", dataFile), null);
      if (doc && Array.isArray(doc.chapters)) {
        chapterCount = doc.chapters.length;
        const nums = doc.chapters.map((c) => Number(c.chapter)).filter(Number.isFinite);
        if (nums.length) {
          fromChapter = Math.min(...nums);
          toChapter = Math.max(...nums);
        }
      }
    }

    const ok = result.code === 0 && chapterCount > 0;
    const row = {
      index: item.index,
      title: item.title,
      seriesUrl: item.seriesUrl,
      expectedChapters: item.chapterCount,
      dataFile,
      chapterCount,
      fromChapter,
      toChapter,
      ok,
      exitCode: result.code,
      elapsedMs,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: ok
        ? null
        : (result.stderr || result.stdout || `exit ${result.code}`).slice(-500),
    };

    await appendFile(statusAbs, JSON.stringify(row) + "\n", "utf8");

    summary.results = (summary.results || []).filter((r) => r.index !== item.index);
    summary.results.push(row);
    summary.updatedAt = new Date().toISOString();
    summary.okCount = summary.results.filter((r) => r.ok).length;
    summary.failCount = summary.results.filter((r) => !r.ok).length;
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

    const statusLabel = ok ? "OK" : "FAIL";
    console.error(
      `\n>>> STATUS [${item.index}/${queue.series.length}] ${statusLabel}: ${item.title} | ch=${chapterCount ?? "?"} (expect ~${item.chapterCount}) | ${(elapsedMs / 1000).toFixed(1)}s`
    );
  }

  summary.finishedAt = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.error(
    `\nDone. ok=${summary.okCount || 0} fail=${summary.failCount || 0} / ${queue.series.length}`
  );
  if ((summary.failCount || 0) > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
