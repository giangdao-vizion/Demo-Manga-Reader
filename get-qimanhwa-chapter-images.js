#!/usr/bin/env node
/**
 * Lấy danh sách URL ảnh từ một trang chapter qimanhwa.com (reader kiểu Asura: div[data-page]).
 *
 * Mặc định: chapter 89 của "The Investor Who Sees the Future".
 *
 * Usage:
 *   node get-qimanhwa-chapter-images.js [chapter-url] [output.json]
 *
 * Cloudflare / 403:
 *   node get-qimanhwa-chapter-images.js --playwright [url] [out.json]
 *   PLAYWRIGHT_CDP_URL=http://127.0.0.1:9222 node get-qimanhwa-chapter-images.js -p [url]
 *   QIMANHWA_PLAYWRIGHT_USER_DATA=.cache/qimanhwa-profile node get-qimanhwa-chapter-images.js -p --headed
 *
 * Cookie (tuỳ chọn):
 *   --cookie "name=value"   hoặc env QIMANHWA_COOKIE
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractQimanhwaImagesFromHtml,
  fetchQimanhwaImagesFromUrl,
} from "./catalog/lib/content-sources/qimanhwa-chapter.js";
import { createQimanhwaPlaywrightFetcher } from "./catalog/lib/adapters/qimanhwa-playwright-fetch.js";

const DEFAULT_CHAPTER_URL =
  "https://qimanhwa.com/series/the-investor-who-sees-the-future/chapter-89";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} [options] [chapter-url] [output.json]

  chapter-url   Mặc định: ${DEFAULT_CHAPTER_URL}
  output.json   Mặc định: qimanhwa-chapter-images.json

Options:
  --playwright, -p   Tải HTML bằng Playwright (khi fetch thường bị 403 / challenge)
  --headed           Với Playwright: mở cửa sổ (headless=false), hữu ích lần đầu vượt CF
  --cookie "a=b"     Gửi Cookie (hoặc QIMANHWA_COOKIE)

Env:
  QIMANHWA_USE_PLAYWRIGHT=1   Bật --playwright
  PLAYWRIGHT_CDP_URL          Chrome đang mở + remote debugging
  QIMANHWA_PLAYWRIGHT_USER_DATA  Thư mục profile Playwright persistent
`);
}

function parseArgs(argv) {
  const out = {
    url: DEFAULT_CHAPTER_URL,
    outPath: "qimanhwa-chapter-images.json",
    playwright: false,
    headed: false,
    cookie: "",
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--playwright" || a === "-p") {
      out.playwright = true;
    } else if (a === "--headed") {
      out.headed = true;
    } else if (a === "--cookie" && argv[i + 1]) {
      out.cookie = String(argv[++i]).trim();
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    } else if (!a.startsWith("-")) {
      positional.push(a);
    }
  }
  if (process.env.QIMANHWA_USE_PLAYWRIGHT === "1") {
    out.playwright = true;
  }
  const envCookie = String(process.env.QIMANHWA_COOKIE || "").trim();
  if (envCookie && !out.cookie) {
    out.cookie = envCookie;
  }
  if (positional[0]) {
    out.url = positional[0];
  }
  if (positional[1]) {
    out.outPath = positional[1];
  }
  return out;
}

async function fetchViaPlaywright(pageUrl, cookie, headed) {
  const fetcher = await createQimanhwaPlaywrightFetcher({
    baseUrl: pageUrl.origin,
    cookie: cookie || undefined,
    headless: !headed,
  });
  try {
    const html = await fetcher.fetchHtml(pageUrl.href);
    const images = extractQimanhwaImagesFromHtml(html, pageUrl.href);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      sourceUrl: pageUrl.href,
      finalUrl: pageUrl.href,
      contentType: "text/html",
      images,
    };
  } finally {
    await fetcher.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  let pageUrl;
  try {
    pageUrl = new URL(args.url);
  } catch {
    console.error("Invalid URL:", args.url);
    process.exit(1);
  }

  const outPath = resolve(process.cwd(), args.outPath);

  const result = args.playwright
    ? await fetchViaPlaywright(pageUrl, args.cookie, args.headed)
    : await fetchQimanhwaImagesFromUrl(pageUrl.href, {
        cookie: args.cookie || undefined,
      });

  if (!result.ok) {
    console.error(`HTTP ${result.status} ${result.statusText}`);
    console.error(
      "Nếu là Cloudflare: chạy lại với --playwright (và/hoặc PLAYWRIGHT_CDP_URL, --headed)."
    );
    process.exit(1);
  }

  const payload = {
    sourceUrl: pageUrl.href,
    finalUrl: result.finalUrl,
    fetchedAt: new Date().toISOString(),
    contentType: result.contentType,
    count: result.images.length,
    images: result.images,
  };

  await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${result.images.length} image URL(s) to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
