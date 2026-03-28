#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchImagesFromUrl } from "./extract.mjs";

function usage() {
  const self = fileURLToPath(import.meta.url);
  console.error(`Usage: node ${self} <url> [output.json]

  url         Trang cần tải (http/https)
  output.json Tùy chọn, mặc định: image-links.json

  Ghi chú:
  - Ảnh lazy-load thường nằm ở data-src / data-lazy-src (đã hỗ trợ).
  - Một số site WordPress: URL .htm có thể 302 sang trang khác; thử .html
    và đối chiếu finalUrl trong JSON với trang bạn muốn.

  Nhiều chapter: node batch-chapters.js <chapter-url> <từ> <đến> [out.json]`);
}

async function main() {
  const [, , urlArg, outArg] = process.argv;
  if (!urlArg || urlArg === "-h" || urlArg === "--help") {
    usage();
    process.exit(urlArg ? 0 : 1);
  }

  let pageUrl;
  try {
    pageUrl = new URL(urlArg);
  } catch {
    console.error("Invalid URL:", urlArg);
    process.exit(1);
  }

  const outPath = resolve(process.cwd(), outArg || "image-links.json");

  const result = await fetchImagesFromUrl(pageUrl.href);

  if (!result.ok) {
    console.error(`HTTP ${result.status} ${result.statusText}`);
    process.exit(1);
  }

  const imageUrls = result.images;

  const payload = {
    sourceUrl: pageUrl.href,
    finalUrl: result.finalUrl,
    fetchedAt: new Date().toISOString(),
    contentType: result.contentType,
    count: imageUrls.length,
    images: imageUrls,
  };

  await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${imageUrls.length} image URL(s) to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
