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

/** CDN trang truyện Asura (không lấy /covers/); dừng tại đuôi ảnh để không nuốt chuỗi RSC (&quot;…). */
const ASURA_CHAPTER_IMG_RE =
  /https:\/\/cdn\.asurascans\.com\/asura-images\/chapters\/[a-z0-9/_.-]+\.(?:webp|jpe?g|png|gif)/gi;

function collectAsuraChapterUrlsFromEmbeddedHtml(html) {
  const seen = new Set();
  const ordered = [];
  let m;
  ASURA_CHAPTER_IMG_RE.lastIndex = 0;
  while ((m = ASURA_CHAPTER_IMG_RE.exec(html)) !== null) {
    const u = m[0];
    if (seen.has(u)) continue;
    seen.add(u);
    ordered.push(u);
  }
  return ordered;
}

/**
 * Asura-style reader: <div data-page="0"><img src="..."/></div>
 * Thứ tự theo số data-page; chỉ lấy img đầu tiên trong mỗi div.
 * Trang thật thường chỉ SSR vài ảnh — khi thiếu so với payload RSC thì bổ sung URL /chapters/ trong HTML.
 */
export function collectAsuraPageImages(html, pageUrl) {
  const $ = cheerio.load(html);
  const items = [];

  $("div[data-page]").each((_, el) => {
    const $wrap = $(el);
    const pageRaw = $wrap.attr("data-page");
    const pageNum = pageRaw != null && pageRaw !== "" ? Number(pageRaw, 10) : NaN;
    const $img = $wrap.find("img").first();
    if (!$img.length) return;

    let raw = null;
    for (const attr of ["src", ...LAZY_IMG_ATTRS]) {
      const v = $img.attr(attr);
      if (v && String(v).trim()) {
        raw = v;
        break;
      }
    }
    if (!raw) {
      const ss = $img.attr("srcset");
      if (ss) {
        const first = parseSrcset(ss)[0];
        if (first) raw = first;
      }
    }
    if (!raw || typeof raw !== "string") return;

    items.push({ page: pageNum, raw: raw.trim() });
  });

  items.sort((a, b) => {
    const ap = Number.isFinite(a.page) ? a.page : Number.MAX_SAFE_INTEGER;
    const bp = Number.isFinite(b.page) ? b.page : Number.MAX_SAFE_INTEGER;
    if (ap !== bp) return ap - bp;
    return 0;
  });

  const seen = new Set();
  const fromDivs = [];
  for (const { raw } of items) {
    if (!raw || isSkippableScheme(raw)) continue;
    const abs = normalizeUrl(raw, pageUrl);
    if (!abs || isSkippableScheme(abs) || seen.has(abs)) continue;
    seen.add(abs);
    fromDivs.push(abs);
  }

  const fromEmbed = collectAsuraChapterUrlsFromEmbeddedHtml(html);
  if (fromEmbed.length > fromDivs.length) return fromEmbed;
  return fromDivs.length ? fromDivs : fromEmbed;
}

export async function fetchAsuraImagesFromUrl(pageUrl) {
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
  const images = collectAsuraPageImages(html, finalUrl);

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

/** Lấy ảnh trong article img (site kiểu WordPress mirror). */
export function collectArticleImageUrls(html, pageUrl) {
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

  $("article img").each((_, el) => {
    const $img = $(el);
    add($img.attr("src"));
    for (const u of parseSrcset($img.attr("srcset"))) add(u);
    for (const u of parseSrcset($img.attr("data-srcset"))) add(u);
    for (const attr of LAZY_IMG_ATTRS) add($img.attr(attr));
  });

  return ordered;
}

export async function fetchArticleImagesFromUrl(pageUrl) {
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
  const images = collectArticleImageUrls(html, finalUrl);

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

/** Lấy ảnh trong #chapter-reader img (mgeko.cc). */
export function collectChapterReaderImageUrls(html, pageUrl) {
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

  $("#chapter-reader img").each((_, el) => {
    const $img = $(el);
    add($img.attr("src"));
    for (const u of parseSrcset($img.attr("srcset"))) add(u);
    for (const u of parseSrcset($img.attr("data-srcset"))) add(u);
    for (const attr of LAZY_IMG_ATTRS) add($img.attr(attr));
  });

  return ordered;
}

/**
 * @param {string} pageUrl
 * @param {{ cookie?: string }} [opts]
 */
export async function fetchMgekoImagesFromUrl(pageUrl, opts) {
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
  const images = collectChapterReaderImageUrls(html, finalUrl);

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
