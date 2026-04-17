import cheerio from "cheerio";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Lấy số phiên bản Chrome từ UA để Sec-Ch-Ua khớp (Cloudflare hay so khớp). */
function chromeMajorFromUa(ua) {
  const m = String(ua || "").match(/Chrome\/(\d+)/);
  return m ? m[1] : "120";
}

function secChUaPlatform(ua) {
  const s = String(ua || "");
  if (/Mac OS X|Macintosh/i.test(s)) return '"macOS"';
  if (/Windows/i.test(s)) return '"Windows"';
  return '"Linux"';
}

function secChUaMobile(ua) {
  return /Mobile|Android/i.test(String(ua || "")) ? "?1" : "?0";
}

/**
 * Header gần với document navigation của Chrome (kèm cookie nếu có).
 * @param {{ userAgent: string, cookie?: string, url: string, referer: string|null }} p
 */
function chromeDocumentHeaders(p) {
  const ua = p.userAgent;
  const v = chromeMajorFromUa(ua);
  const secChUa = `"Not_A Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`;
  /** @type {Record<string, string>} */
  const h = {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    "Sec-Ch-Ua": secChUa,
    "Sec-Ch-Ua-Mobile": secChUaMobile(ua),
    "Sec-Ch-Ua-Platform": secChUaPlatform(ua),
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
  if (p.referer) {
    h.Referer = p.referer;
    h["Sec-Fetch-Site"] = "same-origin";
  } else {
    h["Sec-Fetch-Site"] = "none";
  }
  const c = p.cookie && String(p.cookie).trim();
  if (c) {
    h.Cookie = c;
  }
  return h;
}

/**
 * @param {string} html
 * @param {string} origin
 * @returns {{ seriesPath: string, title: string, seriesUrl: string, coverUrl: string|null, chapterCount: number|null, status: string|null, rating: number|null }[]}
 */
export function parseQimanhwaSeriesFromHtml(html, origin) {
  const fromNext = trySeriesFromNextData(html, origin);
  if (fromNext.length) return fromNext;

  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    let path = href.split("?")[0];
    if (path.startsWith("http")) {
      try {
        path = new URL(path).pathname;
      } catch {
        return;
      }
    }
    if (!path.startsWith("/")) path = "/" + path;
    const lower = path.toLowerCase();
    if (
      !/\/(series|manhwa|manga|title|comic)\//i.test(lower) &&
      !/\/(series|manhwa|manga)\/[^/]+$/i.test(lower)
    ) {
      return;
    }
    if (seen.has(path)) return;
    seen.add(path);

    const card = $(el).closest("[class*='card'], article, .group, li");
    let title = $(el).attr("title")?.trim() || "";
    if (!title) {
      title =
        card.find("h2, h3, .title, [class*='title']").first().text().trim() ||
        $(el).text().trim();
    }
    if (!title || title.length > 200) return;

    let coverUrl = null;
    const img = card.find("img").first();
    if (img.length) {
      coverUrl =
        img.attr("src") ||
        img.attr("data-src") ||
        img.attr("data-lazy-src") ||
        null;
    }
    if (coverUrl && !/^https?:/i.test(coverUrl)) {
      try {
        coverUrl = new URL(coverUrl, origin).href;
      } catch {
        coverUrl = null;
      }
    }

    let chapterCount = null;
    const meta = card.text().replace(/\s+/g, " ");
    const chM = meta.match(/(\d+)\s*(?:ch|chap|chapter|ep)/i);
    if (chM) chapterCount = parseInt(chM[1], 10);

    items.push({
      seriesPath: path,
      title,
      seriesUrl: origin.replace(/\/$/, "") + path,
      coverUrl,
      chapterCount: Number.isFinite(chapterCount) ? chapterCount : null,
      status: null,
      rating: null,
    });
  });

  return items;
}

function trySeriesFromNextData(html, origin) {
  const m = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    const acc = [];
    walkSeriesObjects(data, acc, origin, 0);
    return dedupeSeries(acc);
  } catch {
    return [];
  }
}

function walkSeriesObjects(o, acc, origin, depth) {
  if (depth > 22 || o == null) return;
  if (Array.isArray(o)) {
    for (const x of o) walkSeriesObjects(x, acc, origin, depth + 1);
    return;
  }
  if (typeof o !== "object") return;

  const slug = o.slug || o.seriesSlug || o.series_slug;
  const title = o.title || o.name || o.seriesTitle;
  const href = o.href || o.url || o.path;
  if (typeof title === "string" && title.trim()) {
    let path = null;
    if (typeof slug === "string" && slug.trim()) {
      path = slug.startsWith("/") ? slug : "/" + slug;
    } else if (typeof href === "string" && href.startsWith("/")) {
      path = href.split("?")[0];
    }
    if (path && path.length > 2) {
      const ch =
        o.chapterCount ??
        o.chaptersCount ??
        o.totalChapters ??
        o.chapter_count ??
        null;
      const chapterCount =
        typeof ch === "number" && Number.isFinite(ch) ? ch : null;
      let coverUrl =
        o.coverUrl ||
        o.cover ||
        o.thumbnail ||
        o.image ||
        (o.images && o.images[0]) ||
        null;
      if (coverUrl && !/^https?:/i.test(String(coverUrl))) {
        try {
          coverUrl = new URL(String(coverUrl), origin).href;
        } catch {
          coverUrl = null;
        }
      }
      acc.push({
        seriesPath: path,
        title: title.trim(),
        seriesUrl: origin.replace(/\/$/, "") + path,
        coverUrl,
        chapterCount,
        status: typeof o.status === "string" ? o.status : null,
        rating: typeof o.rating === "number" ? o.rating : null,
      });
    }
  }
  for (const k of Object.keys(o)) walkSeriesObjects(o[k], acc, origin, depth + 1);
}

function dedupeSeries(items) {
  const m = new Map();
  for (const it of items) {
    if (!m.has(it.seriesPath)) m.set(it.seriesPath, it);
  }
  return [...m.values()];
}

function buildBrowsePageUrl(baseListUrl, page) {
  const u = new URL(baseListUrl);
  if (page <= 1) {
    u.searchParams.delete("page");
  } else {
    u.searchParams.set("page", String(page));
  }
  return u.href;
}

/**
 * @param {object} opts
 * @param {string} opts.listUrl
 * @param {number} [opts.delayMs]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.cookie] — Cookie header (vd. từ biến môi trường khi vượt Cloudflare)
 * @param {boolean} [opts.usePlaywright] — dùng Chromium (Playwright) thay cho fetch; hoặc env QIMANHWA_USE_PLAYWRIGHT=1
 * @param {boolean} [opts.playwrightHeadless] — mặc định true; false để mở cửa sổ (xử lý challenge tay)
 * @param {string} [opts.playwrightChannel] — ví dụ "chrome" (Chrome hệ thống); hoặc env PLAYWRIGHT_CHANNEL
 * @param {string} [opts.playwrightCdpUrl] — http://127.0.0.1:9222 (Chrome --remote-debugging-port); env PLAYWRIGHT_CDP_URL
 * @param {string} [opts.playwrightUserDataDir] — profile persistent; env QIMANHWA_PLAYWRIGHT_USER_DATA
 * @param {(url: string) => Promise<string>} [opts.fetchHtml]
 */
export async function collectAllSeriesFromQimanhwaBrowse(opts) {
  const delayMs = opts.delayMs ?? 800;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const origin = new URL(opts.listUrl).origin;
  const cookie = opts.cookie && String(opts.cookie).trim();

  const usePlaywright =
    opts.usePlaywright === true ||
    String(process.env.QIMANHWA_USE_PLAYWRIGHT || "").trim() === "1";

  /** @type {(() => Promise<void>)|null} */
  let closePlaywright = null;
  /** @type {(url: string) => Promise<string>} */
  let fetchHtml = opts.fetchHtml;

  if (!fetchHtml && usePlaywright) {
    const { createQimanhwaPlaywrightFetcher } = await import(
      "./qimanhwa-playwright-fetch.js"
    );
    const pw = await createQimanhwaPlaywrightFetcher({
      baseUrl: opts.listUrl,
      userAgent,
      cookie: cookie || undefined,
      headless: opts.playwrightHeadless !== false,
      channel:
        (opts.playwrightChannel && String(opts.playwrightChannel).trim()) ||
        (process.env.PLAYWRIGHT_CHANNEL &&
          String(process.env.PLAYWRIGHT_CHANNEL).trim()) ||
        undefined,
      cdpUrl:
        (opts.playwrightCdpUrl && String(opts.playwrightCdpUrl).trim()) ||
        undefined,
      userDataDir:
        (opts.playwrightUserDataDir && String(opts.playwrightUserDataDir).trim()) ||
        undefined,
    });
    closePlaywright = () => pw.close();
    fetchHtml = (url) => pw.fetchHtml(url);
  }

  /** @type {string|null} */
  let prevNavUrl = null;

  async function defaultFetch(url) {
    const headers = chromeDocumentHeaders({
      userAgent,
      cookie,
      url,
      referer: prevNavUrl,
    });
    let res;
    try {
      res = await fetch(url, { headers, redirect: "follow" });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      throw new Error(`Không fetch được ${url}: ${msg}`);
    }
    prevNavUrl = res.url || url;
    if (!res.ok) {
      let hint = "";
      if (res.status === 403) {
        hint =
          " Cloudflare thường gắn cf_clearance với TLS + Chrome thật; Node fetch khác fingerprint nên cookie vẫn có thể bị 403. " +
          "Bật usePlaywright trong config (hoặc QIMANHWA_USE_PLAYWRIGHT=1) và chạy: npx playwright install chromium.";
      }
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}.${hint}`);
    }
    return res.text();
  }

  if (!fetchHtml) {
    fetchHtml = defaultFetch;
  }

  try {
    const firstHtml = await fetchHtml(opts.listUrl);
    const firstItems = parseQimanhwaSeriesFromHtml(firstHtml, origin);

    if (firstItems.length === 0) {
      return {
        items: [],
        pagesFetched: 1,
        totalReported: null,
        perPage: 0,
      };
    }

    const perPage = firstItems.length;
    const maxPage = inferMaxBrowsePage(firstHtml);

    const all = [...firstItems];
    const seen = new Set(firstItems.map((i) => i.seriesPath));

    const betweenPageDelay =
      usePlaywright && !opts.fetchHtml ? Math.max(delayMs, 2500) : delayMs;

    let pagesFetchedActual = 1;

    for (let p = 2; p <= maxPage; p++) {
      if (betweenPageDelay > 0) await sleep(betweenPageDelay);
      const url = buildBrowsePageUrl(opts.listUrl, p);
      let html;
      try {
        html = await fetchHtml(url);
      } catch (e) {
        const msg = String(e?.message || e);
        if (usePlaywright && !opts.fetchHtml && /\b403\b|HTTP 403/i.test(msg)) {
          break;
        }
        throw e;
      }
      pagesFetchedActual = p;
      const pageItems = parseQimanhwaSeriesFromHtml(html, origin);
      for (const it of pageItems) {
        if (!seen.has(it.seriesPath)) {
          seen.add(it.seriesPath);
          all.push(it);
        }
      }
    }

    if (
      pagesFetchedActual < maxPage &&
      maxPage > 1 &&
      usePlaywright &&
      !opts.fetchHtml
    ) {
      console.warn(
        `[qimanhwa-browse] Chỉ lấy được ${pagesFetchedActual}/${maxPage} trang browse (trang sau 403 hoặc không bấm được phân trang). Thử playwrightHeadless:false hoặc playwrightChannel:"chrome".`
      );
    }

    return {
      items: all,
      pagesFetched: pagesFetchedActual,
      totalReported: null,
      perPage,
    };
  } finally {
    if (closePlaywright) {
      try {
        await closePlaywright();
      } catch {
        /* ignore */
      }
    }
  }
}

function inferMaxBrowsePage(html) {
  const nums = [];
  for (const m of html.matchAll(/[?&]page=(\d+)/g)) {
    nums.push(parseInt(m[1], 10));
  }
  for (const m of html.matchAll(/aria-label=["']Page (\d+)["']/gi)) {
    nums.push(parseInt(m[1], 10));
  }
  const $ = cheerio.load(html);
  $("a[href*='page=']").each((_, el) => {
    const h = $(el).attr("href") || "";
    const m = h.match(/page=(\d+)/);
    if (m) nums.push(parseInt(m[1], 10));
  });
  if (nums.length === 0) return 1;
  return Math.min(Math.max(1, ...nums), 500);
}
