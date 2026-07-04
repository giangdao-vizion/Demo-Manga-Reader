/**
 * Thông báo terminal thân thiện cho featured:sync và crawler con.
 */

export function humanizeHttpStatus(status) {
  const n = Number(status);
  if (n === 404) return "chương không tồn tại trên site";
  if (n === 403) return "site từ chối truy cập (403)";
  if (n === 401) return "cần đăng nhập (401)";
  if (n === 429) return "quá nhiều request (429), thử lại sau";
  if (n >= 500) return `lỗi máy chủ site (${n})`;
  if (n >= 400) return `lỗi HTTP ${n}`;
  return `HTTP ${n}`;
}

export function humanizeErrorMessage(raw) {
  let s = String(raw || "").trim();
  if (!s) return "lỗi không xác định";

  let m = s.match(/HTTP\s+(\d{3})\b/i);
  if (m) {
    const rest = s.replace(/HTTP\s+\d{3}\s*/i, "").replace(/@\s*/g, "").trim();
    const hint = humanizeHttpStatus(m[1]);
    return rest ? `${hint} (${rest})` : hint;
  }

  m = s.match(/\b404\b/);
  if (m) return "chương hoặc trang không tồn tại trên site";

  if (/no chapter images/i.test(s)) return "chương chưa có ảnh trên site";
  if (/no images found/i.test(s)) return "không tìm thấy ảnh trong trang";
  if (/missing sampleurl/i.test(s)) return "thiếu URL mẫu trong file JSON";
  if (/không tìm thấy chapter/i.test(s)) return "không lấy được danh sách chương";
  if (/ENOENT/i.test(s)) return "không tìm thấy file";

  return s;
}

/**
 * Chuyển một dòng log từ crawler → tiếng Việt dễ đọc, hoặc null để bỏ qua.
 * Trả về { kind: 'progress', text } | { kind: 'line', text } | null
 */
export function formatCrawlerLine(raw) {
  const line = String(raw || "")
    .replace(/^\r+/, "")
    .trim();
  if (!line) return null;

  let m = line.match(/^\[(\d+)\/(\d+)\]\s*(.*)$/);
  if (m) {
    const cur = m[1];
    const total = m[2];
    const extra = String(m[3] || "").trim();
    const detail = extra ? ` · ${extra}` : "";
    return {
      kind: "progress",
      text: `  ⏳ Đang tải chương ${cur}/${total}${detail}`,
    };
  }

  if (/^Fetch reader page:/i.test(line)) {
    const url = line.replace(/^Fetch reader page:\s*/i, "").trim();
    return { kind: "line", text: `  · Mở trang đọc mẫu: ${url}` };
  }
  if (/^Fetch home page:/i.test(line)) {
    const url = line.replace(/^Fetch home page:\s*/i, "").trim();
    return { kind: "line", text: `  · Mở trang truyện: ${url}` };
  }
  if (/^Fetch series page:/i.test(line)) {
    const url = line.replace(/^Fetch series page:\s*/i, "").trim();
    return { kind: "line", text: `  · Mở trang danh sách: ${url}` };
  }
  if (/^Fetch chapter page/i.test(line)) {
    return { kind: "line", text: "  · Đang lấy danh sách chương từ trang mẫu…" };
  }

  m = line.match(/^Merge mode:\s*giữ lại\s+(\d+)\s+chapter/i);
  if (m) {
    return {
      kind: "line",
      text: `  · Giữ nguyên ${m[1]} chương đã có ảnh (không tải lại)`,
    };
  }

  m = line.match(/^Cần fetch\s+(\d+)\/(\d+)\s+chapter/i);
  if (m) {
    return {
      kind: "line",
      text: `  · Sẽ tải ${m[1]} chương (tổng ${m[2]} trên danh sách)`,
    };
  }

  m = line.match(/^Cần fetch\s+(\d+)\s+chapter/i);
  if (m) {
    return { kind: "line", text: `  · Sẽ tải ${m[1]} chương` };
  }

  if (/^Không có chương mới cần tải/i.test(line)) {
    return {
      kind: "line",
      text: `  ✓ ${line.charAt(0).toUpperCase()}${line.slice(1)}`,
    };
  }

  if (/^Skip write:/i.test(line)) {
    const msg = line.replace(/^Skip write:\s*/i, "").trim();
    return {
      kind: "line",
      text: `  ✓ Không ghi JSON${msg ? `: ${msg}` : ""}`,
    };
  }

  if (/^Fetch chapter page \(danh sách\)/i.test(line)) {
    return { kind: "line", text: "  · Đang lấy danh sách chương từ trang mẫu…" };
  }

  m = line.match(/^Wrote\s+(\d+)\s+chapter/i);
  if (m) {
    return { kind: "line", text: `  ✓ Đã ghi ${m[1]} chương vào file JSON` };
  }

  m = line.match(/^Cảnh báo:\s*(\d+)\s+chapter/i);
  if (m) {
    return {
      kind: "line",
      text: `  ⚠ ${m[1]} chương lỗi hoặc thiếu ảnh`,
    };
  }

  if (/^Updated catalog:/i.test(line)) {
    return null;
  }
  if (/^Removed legacy/i.test(line)) {
    return null;
  }

  m = line.match(/^!\s*Ch\.([^:]+):\s*(.+)$/i);
  if (m) {
    return {
      kind: "line",
      text: `  ⚠ Ch.${m[1].trim()}: ${humanizeErrorMessage(m[2])}`,
    };
  }

  if (/^Cảnh báo:/i.test(line)) {
    return {
      kind: "line",
      text: `  ⚠ ${humanizeErrorMessage(line.replace(/^Cảnh báo:\s*/i, ""))}`,
    };
  }

  if (/^HTTP\s+\d+/i.test(line) || /\b404\b/.test(line)) {
    return { kind: "line", text: `  ⚠ ${humanizeErrorMessage(line)}` };
  }

  if (/^--limit-chapters/i.test(line)) {
    return { kind: "line", text: `  · ${line}` };
  }

  return null;
}

/** Gộp stderr crawler: giữ dòng tiến độ cuối, format phần còn lại. */
export function formatCrawlerOutput(blob) {
  const parts = String(blob || "").split(/\r|\n/);
  let lastProgress = null;
  const lines = [];

  for (const part of parts) {
    const formatted = formatCrawlerLine(part);
    if (!formatted) continue;
    if (formatted.kind === "progress") {
      lastProgress = formatted.text;
    } else {
      lines.push(formatted.text);
    }
  }
  if (lastProgress) lines.push(lastProgress);
  return lines;
}

export function logLine(text, stream = process.stderr) {
  stream.write(String(text) + "\n");
}

export function logSeriesHeader(index, total, title, source, dataFile) {
  logLine("");
  logLine(`━━━ [${index}/${total}] ${title} ━━━`);
  logLine(`  Nguồn: ${source} · File: ${dataFile}`);
}

/** @returns {{ sourceOk: boolean, newChapterLabels: string[], loaded: { label: string, status: string, error?: string }[], retryWithoutImages: string[], jsonUpdated: boolean, jsonSkipped: boolean, error: string|null }} */
export function createSeriesSyncReport() {
  return {
    sourceOk: false,
    newChapterLabels: [],
    loaded: [],
    retryWithoutImages: [],
    jsonUpdated: false,
    jsonSkipped: false,
    error: null,
  };
}

export function chapterLabelFromCrawlerExtra(extra) {
  const s = String(extra || "").trim();
  const m = s.match(/Ch\.([^\s(]+)/i);
  if (m) return m[1];
  const m2 = s.match(/^Ch\.([^\s(]+)/i);
  if (m2) return m2[1];
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim() || "?";
}

export function logSeriesSyncReport(report) {
  const checked = report.sourceOk ? "yes" : "no";
  logLine(`  Kiểm tra dữ liệu từ nguồn: ${checked}`);

  if (report.newChapterLabels.length) {
    logLine(`  Chương mới: ${report.newChapterLabels.join(", ")}`);
  } else {
    logLine("  Chương mới: N/A");
  }

  for (const row of report.loaded) {
    if (row.status === "done") {
      logLine(`  Load chương ${row.label}: Done`);
    } else {
      logLine(
        `  Load chương ${row.label}: ${row.error || "Failed"}`
      );
    }
  }

  if (report.retryWithoutImages && report.retryWithoutImages.length) {
    logLine(
      `  Site có mục chương chưa có ảnh (chưa trong JSON): ${report.retryWithoutImages.join(", ")}`
    );
  }

  if (report.jsonUpdated) {
    logLine("  Đã cập nhật JSON");
  } else {
    logLine("  Ko cần cập nhật JSON");
  }

  if (report.error) {
    logLine(`  Lỗi: ${humanizeErrorMessage(report.error)}`);
  }
}

export function describeAsuraStop(reason) {
  const s = String(reason || "").trim();
  let m = s.match(/^HTTP\s+(\d+)\s+at\s+chapter\s+(\d+)/i);
  if (m) {
    return `Dừng tại ch.${m[2]}: ${humanizeHttpStatus(m[1])} (coi như hết chương mới)`;
  }
  if (/redirect mismatch/i.test(s)) {
    m = s.match(/chapter\s+(\d+)/i);
    return m
      ? `Dừng tại ch.${m[1]}: site chuyển sang URL khác (không phải chương kế tiếp)`
      : "Dừng: site chuyển hướng bất thường";
  }
  if (/no images at chapter/i.test(s)) {
    m = s.match(/chapter\s+(\d+)/i);
    return m
      ? `Dừng tại ch.${m[1]}: chương chưa có ảnh`
      : "Dừng: không có ảnh";
  }
  if (/no new chapter/i.test(s)) return "Không có chương mới";
  if (/missing sampleurl/i.test(s)) return "Thiếu sampleUrl trong JSON";
  return humanizeErrorMessage(s);
}

export function summarizeChapterDelta(beforeTo, afterTo, beforeCount, afterCount) {
  const addedByTo = Math.max(0, afterTo - beforeTo);
  const addedByCount = Math.max(0, afterCount - beforeCount);
  const added = Math.max(addedByTo, addedByCount);
  if (added > 0) {
    return `Đã thêm ${added} chương mới (Ch.1–${afterTo}, tổng ${afterCount} chương)`;
  }
  if (afterCount > 0) {
    return `Đã đồng bộ lại · Ch.1–${afterTo} · ${afterCount} chương · không có chương mới`;
  }
  return "Không thay đổi số chương";
}

export const SOURCE_LABELS = {
  asura: "Asura Scans",
  mgeko: "MGEKO",
  kunmanga: "KunManga",
  onepunchmantruyen: "OnePunchManTruyen (cũ)",
  onepunchmanmau: "OnePunchManMau.com",
  truyenonepiece: "Truyen-One-Piece.com",
  dilib: "dilib.vn",
};
