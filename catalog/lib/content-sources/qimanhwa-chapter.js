import cheerio from "cheerio";
import {
  BROWSER_HEADERS,
  collectAsuraPageImages,
  collectImageUrls,
} from "../../../extract.mjs";

/**
 * Lấy số chapter từ trang series QiManhwa / theme tương tự.
 * Thử __NEXT_DATA__, link chapter, rồi fallback regex.
 */
export function extractChapterNumbersFromQimanhwaHtml(html, seriesPath) {
  const fromNext = tryChaptersFromNextData(html);
  if (fromNext.length) return fromNext;

  const $ = cheerio.load(html);
  const nums = new Set();

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) return;
    const abs = href.startsWith("http") ? href : "";
    const target = abs || href;
    const patterns = [
      /\/chapter[/-](\d+)/i,
      /\/ch(?:apter)?[-.](\d+)/i,
      /\/ep(?:isode)?[-.]?(\d+)/i,
      /[?&]chapter=(\d+)/i,
    ];
    for (const re of patterns) {
      const m = target.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0 && n < 50000) nums.add(n);
      }
    }
  });

  const base = String(seriesPath || "").replace(/\/$/, "");
  if (base.startsWith("/")) {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped + "/(?:chapter|ch)[/-]?(\\d+)", "gi");
    let m;
    while ((m = re.exec(html)) !== null) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) nums.add(n);
    }
  }

  return [...nums].sort((a, b) => a - b);
}

function tryChaptersFromNextData(html) {
  const m = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    const nums = new Set();
    walkNextData(data, nums, 0);
    return [...nums].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function walkNextData(o, nums, depth) {
  if (depth > 18 || o == null) return;
  if (typeof o === "number" && Number.isFinite(o) && o > 0 && o < 50000) {
    /* có thể là chapterNum trong object — bỏ qua số đơn lẻ */
  }
  if (Array.isArray(o)) {
    for (const x of o) walkNextData(x, nums, depth + 1);
    return;
  }
  if (typeof o === "object") {
    const ch =
      o.chapterNumber ??
      o.chapter_num ??
      o.number ??
      o.chapterNo ??
      o.chapter;
    if (typeof ch === "number" && Number.isFinite(ch) && ch > 0 && ch < 50000) {
      nums.add(ch);
    }
    if (typeof ch === "string" && /^\d+$/.test(ch)) {
      nums.add(parseInt(ch, 10));
    }
    for (const k of Object.keys(o)) walkNextData(o[k], nums, depth + 1);
  }
}

/**
 * URL chapter: cùng pattern kiểu Asura /path/chapter/N (nhiều site fork dùng vậy).
 */
export function buildQimanhwaChapterUrl(seriesUrl, seriesPath, chapterNum) {
  const origin = new URL(seriesUrl).origin;
  const path = String(seriesPath || new URL(seriesUrl).pathname).replace(/\/$/, "");
  if (!path.startsWith("/")) {
    return new URL(`/chapter/${chapterNum}`, seriesUrl).href;
  }
  return new URL(`${path}/chapter/${chapterNum}`, origin).href;
}

/**
 * @param {string} html
 * @param {string} pageUrl - base URL (final sau redirect)
 * @returns {string[]}
 */
export function extractQimanhwaImagesFromHtml(html, pageUrl) {
  let images = collectAsuraPageImages(html, pageUrl);
  if (!images.length) {
    images = collectImageUrls(html, pageUrl);
  }
  return images;
}

/**
 * @param {string} pageUrl
 * @param {{ cookie?: string }} [opts]
 */
export async function fetchQimanhwaImagesFromUrl(pageUrl, opts) {
  const headers = { ...BROWSER_HEADERS };
  const c = opts && opts.cookie && String(opts.cookie).trim();
  if (c) headers.Cookie = c;
  const res = await fetch(pageUrl, {
    headers,
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
  const images = extractQimanhwaImagesFromHtml(html, finalUrl);
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
