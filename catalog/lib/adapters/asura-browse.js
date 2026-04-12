import cheerio from "cheerio";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} html
 */
export function parseTotalReported(html) {
  const m = html.match(/Browse Series<\/h1>[\s\S]{0,1200}?<span[^>]*>(\d+)<\/span>/);
  if (!m) return null;
  const n = Number(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} baseListUrl
 * @param {number} page 1-based
 */
export function buildAsuraBrowsePageUrl(baseListUrl, page) {
  const u = new URL(baseListUrl);
  if (page <= 1) u.searchParams.delete("page");
  else u.searchParams.set("page", String(page));
  return u.href;
}

/**
 * @param {string} html
 * @param {string} origin e.g. https://asurascans.com
 */
export function parseSeriesCardsFromHtml(html, origin) {
  const $ = cheerio.load(html);
  const items = [];

  $(".series-card").each((_, el) => {
    const card = $(el);
    const link = card.find('a[href^="/comics/"]').first();
    const href = link.attr("href");
    if (!href || !href.startsWith("/comics/")) return;

    const seriesPath = href.split("?")[0];
    const seriesUrl = origin + seriesPath;

    const coverImg = card.find("img").first();
    const coverUrl = coverImg.attr("src") || null;
    const titleFromImg = (coverImg.attr("alt") || "").trim();

    const body = card.find(".p-3");
    const titleFromH3 = body.find("h3").first().text().trim();
    const title = titleFromH3 || titleFromImg || seriesPath;

    const metaRow = body.find(".flex.items-center.gap-2.mt-2");
    const chSpan = metaRow.find("span").first();
    const chText = chSpan.text().replace(/\s+/g, " ").trim();
    const chMatch = chText.match(/(\d+)/);
    const chapterCount = chMatch ? Number(chMatch[1], 10) : null;

    const status = metaRow.find("span").eq(1).text().trim() || null;

    const ratingText = card.find(".absolute .font-semibold").first().text().trim();
    const rating = ratingText ? Number(ratingText) : null;

    items.push({
      seriesPath,
      title,
      seriesUrl,
      coverUrl,
      chapterCount: Number.isFinite(chapterCount) ? chapterCount : null,
      status,
      rating: Number.isFinite(rating) ? rating : null,
    });
  });

  return items;
}

/**
 * @param {string} html
 * @param {number} cardsOnPage
 */
export function inferMaxPage(html, cardsOnPage) {
  const total = parseTotalReported(html);
  if (total != null && cardsOnPage > 0) {
    const cap = Math.max(1, Math.ceil(total / cardsOnPage));
    return Math.min(cap, 500);
  }
  const nums = [];
  for (const m of html.matchAll(/aria-label="Page (\d+)"/g)) {
    nums.push(Number(m[1], 10));
  }
  for (const m of html.matchAll(/[?&]page=(\d+)/g)) {
    nums.push(Number(m[1], 10));
  }
  if (nums.length === 0) return 1;
  return Math.max(1, ...nums);
}

/**
 * @param {object} opts
 * @param {string} opts.listUrl
 * @param {number} [opts.delayMs]
 * @param {string} [opts.userAgent]
 * @param {(url: string) => Promise<string>} [opts.fetchHtml] override for tests
 */
export async function collectAllSeriesFromBrowse(opts) {
  const delayMs = opts.delayMs ?? 600;
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const origin = new URL(opts.listUrl).origin;

  async function defaultFetch(url) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      throw new Error(`Không fetch được ${url}: ${msg}`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    return res.text();
  }

  const fetchHtml = opts.fetchHtml ?? defaultFetch;

  const firstHtml = await fetchHtml(opts.listUrl);
  const firstItems = parseSeriesCardsFromHtml(firstHtml, origin);
  const totalReported = parseTotalReported(firstHtml);

  if (firstItems.length === 0) {
    return {
      items: [],
      pagesFetched: 0,
      totalReported,
      perPage: 0,
    };
  }

  const perPage = firstItems.length;
  const maxPage = inferMaxPage(firstHtml, perPage);

  const all = [...firstItems];
  const seen = new Set(firstItems.map((i) => i.seriesPath));

  for (let p = 2; p <= maxPage; p++) {
    if (delayMs > 0) await sleep(delayMs);
    const url = buildAsuraBrowsePageUrl(opts.listUrl, p);
    const html = await fetchHtml(url);
    const pageItems = parseSeriesCardsFromHtml(html, origin);
    for (const it of pageItems) {
      if (!seen.has(it.seriesPath)) {
        seen.add(it.seriesPath);
        all.push(it);
      }
    }
  }

  return {
    items: all,
    pagesFetched: maxPage,
    totalReported,
    perPage,
  };
}
