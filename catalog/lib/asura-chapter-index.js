/**
 * Trang series Asura: href="/comics/{slug}/chapter/{n}"
 */
export function extractChapterNumbersFromSeriesHtml(html, seriesPath) {
  const base = String(seriesPath || "").replace(/\/$/, "");
  if (!base.startsWith("/")) {
    return [];
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "/chapter/(\\d+)", "g");
  const s = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = Number(m[1], 10);
    if (Number.isFinite(n)) s.add(n);
  }
  return [...s].sort((a, b) => a - b);
}

export function buildAsuraChapterUrl(seriesUrl, seriesPath, chapterNum) {
  const origin = new URL(seriesUrl).origin;
  const path = String(seriesPath).replace(/\/$/, "") + "/chapter/" + chapterNum;
  return new URL(path, origin).href;
}
