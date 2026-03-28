import * as cheerio from "cheerio";

export const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

function parseSrcset(srcset) {
  if (!srcset || typeof srcset !== "string") return [];
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

const LAZY_IMG_ATTRS = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-original-src",
  "data-url",
  "data-full-url",
  "data-large_image",
];

function normalizeUrl(raw, base) {
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

function isSkippableScheme(href) {
  const u = href.toLowerCase();
  return u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("javascript:");
}

export function collectImageUrls(html, pageUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const ordered = [];

  function add(raw) {
    if (!raw || typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed || isSkippableScheme(trimmed)) return;
    const abs = normalizeUrl(trimmed, pageUrl);
    if (!abs || isSkippableScheme(abs) || seen.has(abs)) return;
    seen.add(abs);
    ordered.push(abs);
  }

  function addFromImg($img) {
    add($img.attr("src"));
    for (const u of parseSrcset($img.attr("srcset"))) add(u);
    for (const u of parseSrcset($img.attr("data-srcset"))) add(u);
    for (const u of parseSrcset($img.attr("data-lazy-srcset"))) add(u);
    for (const attr of LAZY_IMG_ATTRS) add($img.attr(attr));
  }

  $("img").each((_, el) => addFromImg($(el)));

  $("picture source[srcset]").each((_, el) => {
    for (const u of parseSrcset($(el).attr("srcset"))) add(u);
  });
  $("picture source[src]").each((_, el) => add($(el).attr("src")));
  $("picture source[data-srcset]").each((_, el) => {
    for (const u of parseSrcset($(el).attr("data-srcset"))) add(u);
  });

  $("input[type=image][src]").each((_, el) => add($(el).attr("src")));

  return ordered;
}

export async function fetchImagesFromUrl(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
  });

  const finalUrl = res.url || pageUrl;
  const contentType = res.headers.get("content-type") || "";

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      statusText: res.statusText,
      sourceUrl: pageUrl,
      finalUrl,
      contentType,
      images: [],
    };
  }

  const html = await res.text();
  const images = collectImageUrls(html, finalUrl);

  return {
    ok: true,
    status: res.status,
    statusText: res.statusText,
    sourceUrl: pageUrl,
    finalUrl,
    contentType,
    images,
  };
}
