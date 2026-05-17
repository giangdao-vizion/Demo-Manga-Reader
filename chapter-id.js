/**
 * ID chapter ổn định cho đánh dấu đã đọc, URL ?c=, history (ưu tiên chapterKey).
 */
(function (global) {
  function normalizeChapterId(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    if (/^\d+\.\d+$/.test(s)) {
      const parts = s.split(".");
      return parts[0] + "-" + parts[1];
    }
    const m = s.match(/^(\d+)[._-](\d+)$/);
    if (m) return m[1] + "-" + m[2];
    return s;
  }

  /** ID lưu localStorage / query ?c= */
  function chapterReadId(ch, index) {
    if (!ch || typeof ch !== "object") return String((index | 0) + 1);
    const key = String(ch.chapterKey || "").trim();
    if (key) return key;
    const label = String(ch.chapterLabel || "").trim();
    if (label) {
      const m = label.match(/^(\d+(?:\.\d+)?|\d+-\d+)/);
      if (m) return normalizeChapterId(m[1]);
    }
    if (ch.chapter != null && Number.isFinite(Number(ch.chapter))) {
      const n = Number(ch.chapter);
      if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
      return String(n);
    }
    const title = String(ch.title || "").trim();
    if (title) {
      const m = title.match(/^(\d+(?:\.\d+)?)/);
      if (m) return normalizeChapterId(m[1]);
    }
    return String((index | 0) + 1);
  }

  function parseChapterQuery(raw) {
    if (raw == null || raw === "") return null;
    const s = String(raw).trim();
    if (!s) return null;
    return normalizeChapterId(s) || s;
  }

  function findChapterIndex(chapters, queryRaw) {
    if (!Array.isArray(chapters) || !chapters.length) return -1;
    const q = parseChapterQuery(queryRaw);
    if (!q) return -1;

    for (let i = 0; i < chapters.length; i++) {
      if (chapterReadId(chapters[i], i) === q) return i;
    }
    const normQ = normalizeChapterId(q);
    for (let i = 0; i < chapters.length; i++) {
      if (normalizeChapterId(chapterReadId(chapters[i], i)) === normQ) return i;
    }

    const qNum = parseFloat(String(q).replace("-", "."));
    if (Number.isFinite(qNum)) {
      const matches = [];
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i];
        if (ch.chapter != null && Number(ch.chapter) === qNum) matches.push(i);
      }
      if (matches.length === 1) return matches[0];
    }
    return -1;
  }

  function pickLatestReadChapterId(chapters, readMap, dataFile) {
    const file = String(dataFile || "").trim();
    const book = readMap && readMap[file];
    if (!book || typeof book !== "object") return null;
    let bestIdx = -1;
    let bestId = null;
    for (const k of Object.keys(book)) {
      if (!book[k]) continue;
      const idx = findChapterIndex(chapters, k);
      if (idx > bestIdx) {
        bestIdx = idx;
        bestId = chapterReadId(chapters[idx], idx);
      }
    }
    return bestId;
  }

  global.ComicHubChapterId = {
    chapterReadId,
    parseChapterQuery,
    normalizeChapterId,
    findChapterIndex,
    pickLatestReadChapterId,
  };
})(typeof window !== "undefined" ? window : globalThis);
