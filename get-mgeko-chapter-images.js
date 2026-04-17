#!/usr/bin/env node
/**
 * Lấy danh sách URL ảnh từ trang reader mgeko.cc (#chapter-reader img).
 *
 * Mặc định: chapter 89 (eng-li) của "The Investor Who Sees The Future".
 *
 * Usage:
 *   node get-mgeko-chapter-images.js [reader-url] [output.json]
 *
 * Cookie (tuỳ chọn):
 *   --cookie "name=value"   hoặc env MGEKO_COOKIE
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMgekoImagesFromUrl } from "./extract.mjs";

const DEFAULT_READER_URL =
  "https://www.mgeko.cc/reader/en/the-investor-who-sees-the-future-chapter-89-eng-li/";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} [options] [reader-url] [output.json]

  reader-url   Mặc định: ${DEFAULT_READER_URL}
  output.json  Mặc định: mgeko-chapter-images.json

  Ảnh lấy theo selector #chapter-reader img (lazy: data-src, v.v.).

Options:
  --cookie "a=b"     Gửi Cookie (hoặc MGEKO_COOKIE)
`);
}

function parseArgs(argv) {
  const out = {
    url: DEFAULT_READER_URL,
    outPath: "mgeko-chapter-images.json",
    cookie: "",
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cookie" && argv[i + 1]) {
      out.cookie = String(argv[++i]).trim();
    } else if (a === "-h" || a === "--help") {
      out.help = true;
    } else if (!a.startsWith("-")) {
      positional.push(a);
    }
  }
  const envCookie = String(process.env.MGEKO_COOKIE || "").trim();
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
  const result = await fetchMgekoImagesFromUrl(pageUrl.href, {
    cookie: args.cookie || undefined,
  });

  if (!result.ok) {
    console.error(`HTTP ${result.status} ${result.statusText}`);
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
