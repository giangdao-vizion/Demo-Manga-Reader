/**
 * Comic Hub — lưu vị trí đọc (localStorage) để resume từ trang Home.
 */
(function (global) {
  const KEY = "comic-hub-reading-history-v1";
  const INTENT_HOME_KEY = "comic-hub-intent-home";
  const CID = global.ComicHubChapterId;

  function now() {
    return Date.now();
  }

  function normalizeDataFile(name) {
    const s = String(name || "").trim();
    if (!s || s === "(nhúng)") return "";
    return s.split(/[/\\]/).pop() || s;
  }

  function normalizeChapterId(chapterId) {
    if (CID && CID.normalizeChapterId) {
      return CID.normalizeChapterId(chapterId);
    }
    return String(chapterId == null ? "" : chapterId).trim();
  }

  function chapterIdsMatch(a, b) {
    return normalizeChapterId(a) === normalizeChapterId(b);
  }

  function get() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object") return null;
      const dataFile = normalizeDataFile(j.dataFile);
      if (!dataFile) return null;
      const chapterId =
        j.chapterId != null && String(j.chapterId).trim()
          ? normalizeChapterId(j.chapterId)
          : Number.isFinite(Number(j.chapter))
            ? normalizeChapterId(String(j.chapter))
            : null;
      return {
        kind: j.kind === "reader" ? "reader" : "detail",
        dataFile,
        chapterId,
        scrollRatio:
          Number.isFinite(Number(j.scrollRatio)) && Number(j.scrollRatio) >= 0
            ? Math.min(1, Number(j.scrollRatio))
            : null,
        useMainScroll: j.useMainScroll === true,
        updatedAt: Number(j.updatedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  function save(entry) {
    const dataFile = normalizeDataFile(entry && entry.dataFile);
    if (!dataFile) return;
    const prev = get();
    const out = {
      v: 2,
      kind: entry.kind === "reader" ? "reader" : "detail",
      dataFile,
      updatedAt: now(),
    };

    let chapterId =
      entry.chapterId != null && String(entry.chapterId).trim()
        ? normalizeChapterId(entry.chapterId)
        : "";
    if (!chapterId && prev && prev.dataFile === dataFile && prev.chapterId) {
      chapterId = prev.chapterId;
    }
    if (chapterId) out.chapterId = chapterId;

    if (entry.kind === "reader") {
      let scrollRatio = null;
      let useMainScroll = false;
      if (Number.isFinite(Number(entry.scrollRatio))) {
        scrollRatio = Math.min(1, Math.max(0, Number(entry.scrollRatio)));
        useMainScroll = entry.useMainScroll === true;
      } else if (
        prev &&
        prev.dataFile === dataFile &&
        chapterId &&
        chapterIdsMatch(prev.chapterId, chapterId) &&
        prev.scrollRatio != null
      ) {
        scrollRatio = prev.scrollRatio;
        useMainScroll = prev.useMainScroll === true;
      }
      if (scrollRatio != null) {
        out.scrollRatio = scrollRatio;
        if (useMainScroll) out.useMainScroll = true;
      }
    } else if (
      prev &&
      prev.dataFile === dataFile &&
      prev.kind === "reader" &&
      chapterId &&
      prev.scrollRatio != null
    ) {
      out.scrollRatio = prev.scrollRatio;
      if (prev.useMainScroll) out.useMainScroll = true;
    }

    try {
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      /* quota */
    }
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  function saveDetail(dataFile) {
    const file = normalizeDataFile(dataFile);
    if (!file) return;
    const prev = get();
    const entry = { kind: "detail", dataFile: file };
    if (prev && prev.dataFile === file && prev.chapterId) {
      entry.chapterId = prev.chapterId;
    }
    save(entry);
  }

  function saveReader(dataFile, chapterId, metrics) {
    const id = normalizeChapterId(chapterId);
    if (!id) return;
    const payload = { kind: "reader", dataFile, chapterId: id };
    if (metrics && Number.isFinite(Number(metrics.scrollRatio))) {
      payload.scrollRatio = Math.min(1, Math.max(0, Number(metrics.scrollRatio)));
      payload.useMainScroll = metrics.useMainScroll === true;
    }
    save(payload);
  }

  function getResumeForReader(dataFile, chapterId) {
    const h = get();
    if (!h || h.kind !== "reader") return null;
    if (h.dataFile !== normalizeDataFile(dataFile)) return null;
    if (!chapterIdsMatch(h.chapterId, chapterId)) return null;
    if (h.scrollRatio == null) return null;
    return h;
  }

  /**
   * Chọn chapter cho dropdown detail: history reader > đã đọc (✓) > chapter cuối danh sách.
   * Trả về chapterId (chapterKey), không phải số chapter trùng nhau.
   */
  function pickDetailChapter(dataFile, chapters, readMap) {
    const file = normalizeDataFile(dataFile);
    if (!file || !Array.isArray(chapters) || !chapters.length) return null;

    const h = get();
    if (h && h.dataFile === file && h.chapterId) {
      if (CID && CID.findChapterIndex(chapters, h.chapterId) >= 0) {
        return h.chapterId;
      }
    }

    if (CID && CID.pickLatestReadChapterId) {
      const fromRead = CID.pickLatestReadChapterId(chapters, readMap, file);
      if (fromRead) return fromRead;
    }

    const last = chapters[chapters.length - 1];
    return CID ? CID.chapterReadId(last, chapters.length - 1) : String(chapters.length);
  }

  function readerUrl(dataFile, chapterId, resume) {
    const p = new URLSearchParams();
    p.set("data", normalizeDataFile(dataFile));
    p.set("c", normalizeChapterId(chapterId));
    if (resume) p.set("resume", "1");
    return "reader.html?" + p.toString();
  }

  function detailUrl(dataFile) {
    return "detail.html?data=" + encodeURIComponent(normalizeDataFile(dataFile));
  }

  function markIntentHome() {
    try {
      sessionStorage.setItem(INTENT_HOME_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  function consumeIntentHome() {
    try {
      if (sessionStorage.getItem(INTENT_HOME_KEY) === "1") {
        sessionStorage.removeItem(INTENT_HOME_KEY);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /** True khi user vừa bấm về Home — chặn pagehide/interval ghi đè history. */
  function shouldBlockHistoryWrite() {
    try {
      return sessionStorage.getItem(INTENT_HOME_KEY) === "1";
    } catch {
      return false;
    }
  }

  /** Chỉ gọi trên home.html — redirect nếu có history. */
  function tryRedirectFromHome() {
    if (consumeIntentHome()) return false;
    const h = get();
    if (!h) return false;
    if (h.kind === "reader" && h.chapterId) {
      const resume = h.scrollRatio != null;
      global.location.replace(readerUrl(h.dataFile, h.chapterId, resume));
      return true;
    }
    if (h.kind === "detail") {
      global.location.replace(detailUrl(h.dataFile));
      return true;
    }
    return false;
  }

  function clearAndNavigate(href) {
    markIntentHome();
    clear();
    global.location.href = href || "home.html";
  }

  function isHomeHref(href) {
    if (!href) return false;
    const s = String(href).trim();
    if (!s || s.startsWith("#")) return false;
    try {
      const u = new URL(s, global.location.href);
      const path = (u.pathname || "").toLowerCase();
      return path.endsWith("/home.html") || path.endsWith("home.html");
    } catch {
      return /home\.html/i.test(s);
    }
  }

  function bindClearOnHomeLinks(selector, homeHref) {
    const nodes = selector
      ? document.querySelectorAll(selector)
      : document.querySelectorAll("a[href]");
    nodes.forEach(function (node) {
      if (node.__comicHubHomeBound) return;
      const href = (node.getAttribute("href") || homeHref || "").trim();
      if (!isHomeHref(href)) return;
      node.__comicHubHomeBound = true;
      node.addEventListener("click", function (ev) {
        const target = ev.currentTarget;
        const linkHref = (target && target.getAttribute("href")) || homeHref || "home.html";
        if (!isHomeHref(linkHref)) return;
        ev.preventDefault();
        clearAndNavigate(linkHref);
      });
    });
  }

  global.ComicHubHistory = {
    KEY,
    get,
    save,
    clear,
    saveDetail,
    saveReader,
    getResumeForReader,
    pickDetailChapter,
    tryRedirectFromHome,
    clearAndNavigate,
    bindClearOnHomeLinks,
    shouldBlockHistoryWrite,
    normalizeDataFile,
  };
})(typeof window !== "undefined" ? window : globalThis);
