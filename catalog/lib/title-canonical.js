/**
 * Khóa gom trùng theo tiêu đề (không hoàn hảo nhưng đủ cho cùng tên EN giữa nguồn).
 */
export function canonicalKeyFromTitle(title) {
  const s = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s ? s.slice(0, 200) : "";
}
