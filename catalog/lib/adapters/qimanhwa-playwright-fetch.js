/**
 * Fetch HTML qua Chromium (Playwright) để vượt Cloudflare.
 *
 * Cách ổn định nhất: mở Chrome với remote debugging rồi đặt playwrightCdpUrl / PLAYWRIGHT_CDP_URL.
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 * Vào qimanhwa.com trong cửa sổ đó (giải challenge), sau đó chạy sync — dùng đúng phiên trình duyệt đó.
 *
 * Hoặc: playwrightUserDataDir — profile lưu cookie giữa các lần (lần đầu chạy headed, đăng nhập/vượt CF).
 *
 * Cài browser: npx playwright install chromium
 */

import { resolve } from "node:path";

/**
 * @param {string} header
 * @param {string} origin - https://host (không path)
 * @returns {{ name: string, value: string, url: string }[]}
 */
export function parseCookieHeaderForPlaywright(header, origin) {
  const base = String(origin || "").replace(/\/$/, "");
  if (!base) return [];
  const url = base + "/";
  const out = [];
  for (const part of String(header).split(";")) {
    const pair = part.trim();
    if (!pair) continue;
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (!name) continue;
    out.push({ name, value, url });
  }
  return out;
}

async function applyStealthInit(context) {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    } catch {
      /* ignore */
    }
  });
}

async function scrollStabilize(page) {
  try {
    await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 400));
      window.scrollTo(0, 0);
      const max = Math.min(document.body?.scrollHeight || 0, 12000);
      for (let y = 0; y < max; y += 500) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
    });
  } catch {
    /* ignore */
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl - listUrl (origin cho cookie)
 * @param {string} [opts.userAgent]
 * @param {string} [opts.cookie]
 * @param {boolean} [opts.headless]
 * @param {string} [opts.channel] - "chrome" | ...
 * @param {string} [opts.cdpUrl] - http://127.0.0.1:9222 (hoặc PLAYWRIGHT_CDP_URL)
 * @param {string} [opts.userDataDir] - thư mục profile (hoặc QIMANHWA_PLAYWRIGHT_USER_DATA)
 */
export async function createQimanhwaPlaywrightFetcher(opts) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "Thiếu gói playwright. Chạy: npm install playwright && npx playwright install chromium"
    );
  }

  const u = new URL(opts.baseUrl);
  const origin = u.origin;
  const userAgent = opts.userAgent;

  const cdpUrl =
    (opts.cdpUrl && String(opts.cdpUrl).trim()) ||
    (process.env.PLAYWRIGHT_CDP_URL && String(process.env.PLAYWRIGHT_CDP_URL).trim()) ||
    "";

  const rawUserData =
    (opts.userDataDir && String(opts.userDataDir).trim()) ||
    (process.env.QIMANHWA_PLAYWRIGHT_USER_DATA &&
      String(process.env.QIMANHWA_PLAYWRIGHT_USER_DATA).trim()) ||
    "";

  const userDataDir = rawUserData ? resolve(process.cwd(), rawUserData) : "";

  const ch = opts.channel && String(opts.channel).trim();
  const channel = ch || undefined;

  const headless = opts.headless !== false;

  const stealthArgs = ["--disable-blink-features=AutomationControlled"];

  let browser = null;
  let context = null;
  /** @type {'cdp'|'persistent'|'launch'} */
  let mode = "launch";

  if (cdpUrl) {
    mode = "cdp";
    console.error(`[playwright] Kết nối CDP: ${cdpUrl} (dùng Chrome đang mở — đã vào qimanhwa trong cửa sổ đó).`);
    browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    context = contexts[0];
    if (!context) {
      await browser.close().catch(() => {});
      throw new Error(
        "CDP: không có browser context. Mở Chrome với --remote-debugging-port=9222 và mở ít nhất một tab."
      );
    }
  } else if (userDataDir) {
    mode = "persistent";
    console.error(`[playwright] Profile persistent: ${userDataDir}`);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      channel,
      locale: "en-US",
      viewport: { width: 1365, height: 900 },
      userAgent: userAgent || undefined,
      args: stealthArgs,
    });
    await applyStealthInit(context);
  } else {
    mode = "launch";
    browser = await chromium.launch({
      headless,
      channel,
      args: stealthArgs,
    });
    context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1365, height: 900 },
      userAgent: userAgent || undefined,
    });
    await applyStealthInit(context);
  }

  const cookieStr = opts.cookie && String(opts.cookie).trim();
  if (cookieStr) {
    const cookies = parseCookieHeaderForPlaywright(cookieStr, origin);
    if (cookies.length) {
      await context.addCookies(cookies);
    }
  }

  const page = await context.newPage();
  let loadedOk = false;

  async function finalizeHtmlCapture() {
    await scrollStabilize(page);
    try {
      await page.waitForSelector("script#__NEXT_DATA__", { timeout: 30000 });
    } catch {
      /* vẫn trả HTML */
    }
    return page.content();
  }

  /**
   * Trang browse: thử click phân trang thay cho goto ?page=N (ít 403 hơn).
   */
  async function tryClickPaginationPage(p, pageNum) {
    try {
      const n = String(pageNum);
      let clicked = false;
      const candidates = [
        p.locator(`a[href$="page=${n}"]`).first(),
        p.locator(`a[href*="page=${n}&"]`).first(),
        p.locator(`a[href*="?page=${n}&"]`).first(),
        p.getByRole("link", { name: new RegExp(`^\\s*${n}\\s*$`) }).first(),
      ];
      for (const loc of candidates) {
        try {
          if ((await loc.count()) > 0) {
            await loc.click({ timeout: 8000 });
            clicked = true;
            break;
          }
        } catch {
          /* next */
        }
      }
      if (!clicked) {
        clicked = await p.evaluate((num) => {
          const want = new RegExp(`[?&]page=${num}(?:&|$|#)`);
          for (const a of document.querySelectorAll('a[href*="page="], button a[href*="page="]')) {
            const h = a.getAttribute("href") || "";
            if (!want.test(h)) continue;
            a.dispatchEvent(
              new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
            );
            return true;
          }
          return false;
        }, pageNum);
      }
      if (!clicked) return false;
      try {
        await p.waitForURL(
          (urlStr) => {
            try {
              return new URL(urlStr).searchParams.get("page") === String(pageNum);
            } catch {
              return false;
            }
          },
          { timeout: 30000 }
        );
      } catch {
        await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1000));
      return true;
    } catch {
      return false;
    }
  }

  return {
    async fetchHtml(url) {
      const target = new URL(url);
      const pageStr = target.searchParams.get("page");
      const pageNum =
        pageStr != null && pageStr !== "" ? parseInt(pageStr, 10) : NaN;

      if (loadedOk && Number.isFinite(pageNum) && pageNum >= 2) {
        const byClick = await tryClickPaginationPage(page, pageNum);
        if (byClick) {
          return finalizeHtmlCapture();
        }
      }

      let lastStatus = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 8000));
        }
        const res = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 120000,
        });
        lastStatus = res ? res.status() : 0;
        if (lastStatus === 403 && attempt === 0) {
          continue;
        }
        break;
      }

      try {
        await page.waitForLoadState("load", { timeout: 45000 });
      } catch {
        /* ignore */
      }

      if (lastStatus === 403) {
        throw new Error(
          `Playwright: HTTP 403 for ${url}. ` +
            `Thử: (1) PLAYWRIGHT_CDP_URL=http://127.0.0.1:9222 + Chrome đã mở qimanhwa; ` +
            `(2) playwrightUserDataDir + lần đầu headed; (3) playwrightHeadless:false.`
        );
      }
      if (lastStatus >= 400) {
        throw new Error(`Playwright: HTTP ${lastStatus} for ${url}`);
      }

      loadedOk = true;
      return finalizeHtmlCapture();
    },

    async close() {
      try {
        await page.close().catch(() => {});
      } catch {
        /* ignore */
      }
      try {
        if (mode === "cdp" && browser) {
          await browser.close();
          return;
        }
        if (mode === "persistent" && context) {
          await context.close();
          return;
        }
        if (browser) {
          await browser.close();
        }
      } catch {
        /* ignore */
      }
    },
  };
}
