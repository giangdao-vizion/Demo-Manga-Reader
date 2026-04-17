/**
 * Logic đồng bộ chapter/ảnh (dùng chung CLI + catalog view-server).
 * Thứ tự chapter trong scope: nhỏ → lớn. Khi tải ảnh (không --force), bỏ qua hẳn các chương đã
 * có ảnh OK trong DB — chỉ fetch các chương chưa có / lỗi trước đó (thường là chương mới).
 * `cfg.chapterConcurrency` (1–8, mặc định 1): fetch nhiều trang chapter song song; ghi SQLite vẫn tuần tự.
 */
import { join } from "node:path";
import { openCatalogDb } from "./db.js";
import { acquireCatalogContentLock } from "./content-sync-lock.js";
import {
  catalogDirFromMainDbPath,
  openSeriesDbAbsWritable,
  prepareSeriesChapterStatements,
  updateSeriesSummaryFromChaptersDb,
  seriesDbRelativePath,
} from "./series-db.js";
import { BROWSER_HEADERS } from "../../extract.mjs";
import { getContentSource } from "./content-sources/registry.js";
import { fetchQimanhwaImagesFromUrl } from "./content-sources/qimanhwa-chapter.js";

const SYNC_ABORT_CODE = "ECATALOGSYNCABORTED";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkSyncAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("Đã dừng theo yêu cầu.");
    err.code = SYNC_ABORT_CODE;
    throw err;
  }
}

function resolveContentCookie(cfg) {
  const name = cfg.contentCookieEnv && String(cfg.contentCookieEnv).trim();
  if (!name) return "";
  return String(process.env[name] || "").trim();
}

async function fetchSeriesHtml(seriesUrl, userAgent, cookie) {
  const headers = {
    ...BROWSER_HEADERS,
    "user-agent": userAgent || BROWSER_HEADERS["user-agent"],
  };
  const c = cookie && String(cookie).trim();
  if (c) headers.Cookie = c;
  const res = await fetch(seriesUrl, {
    headers,
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Series page HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function markSeriesContentComplete(db, seriesId, note) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE catalog_series SET content_sync_complete = 1, content_sync_completed_at = ?, content_sync_note = ? WHERE id = ?`
  ).run(now, note || null, seriesId);
}

/**
 * @param {object} p
 * @param {object} p.cfg - config đã merge (dbPath, sourceIdFilter, delays, …)
 * @param {object} p.flags
 * @param {boolean} [p.flags.fetchImages]
 * @param {boolean} [p.flags.force]
 * @param {number|null} [p.flags.limitSeries]
 * @param {number|null} [p.flags.maxChapters]
 * @param {number|null} [p.flags.seriesId]
 * @param {number} [p.flags.offsetSeries]
 * @param {boolean} [p.flags.includeSynced]
 * @param {boolean} [p.flags.resetSeriesSync]
 * @param {boolean} [p.flags.nextSeries] - một bộ tiếp theo trong hàng đợi (complete=0)
 * @param {(e: Record<string, unknown>) => void} [p.onProgress]
 * @param {AbortSignal} [p.abortSignal] - hủy hợp tác (kiểm tra giữa chapter / sau fetch)
 * @returns {Promise<{ ok: boolean, message: string, seriesProcessed: number, chaptersDiscovered: number, chaptersImaged: number, lastError: string|null, aborted?: boolean }>}
 */
export async function runCatalogContentSync({ cfg, flags, onProgress, abortSignal }) {
  const delaySeries = cfg.delayMsSeriesPage ?? 700;
  const delayChapter = cfg.delayMsChapter ?? 550;
  const rawChapterConc =
    cfg.chapterConcurrency != null ? cfg.chapterConcurrency : cfg.parallelChapters;
  const chapterConcurrency = Math.max(
    1,
    Math.min(8, Math.floor(Number(rawChapterConc)) || 1)
  );
  const userAgent = cfg.userAgent || BROWSER_HEADERS["user-agent"];
  const contentCookie = resolveContentCookie(cfg);
  const fetchImages =
    flags.fetchImages === false
      ? false
      : flags.fetchImages === true
        ? true
        : cfg.fetchImages !== false;
  const force = flags.force || cfg.force;
  let limitSeries =
    flags.limitSeries ?? cfg.limitSeries ?? cfg.seriesPerRun ?? null;
  const maxChapters = flags.maxChapters ?? cfg.maxChaptersPerSeries ?? null;
  let onlySeriesId = flags.seriesId ?? cfg.seriesId ?? null;
  const offsetSeries =
    flags.offsetSeries != null ? flags.offsetSeries : (cfg.offsetSeries ?? 0);
  const nextSeries = !!flags.nextSeries;

  if (nextSeries && onlySeriesId == null) {
    limitSeries = 1;
  }

  const includeSynced = !!flags.includeSynced;
  const skipCompleted =
    cfg.skipCompletedSeries !== false && !includeSynced && onlySeriesId == null;

  let lock = null;
  try {
    lock = acquireCatalogContentLock(cfg.dbPath);
  } catch (e) {
    if (e && e.code === "ECATALOGCONTENTLOCK") {
      onProgress?.({ type: "lock_busy", message: e.message });
      throw e;
    }
    throw e;
  }

  let db = null;
  let lastError = null;
  let seriesProcessed = 0;
  let chaptersDiscovered = 0;
  let chaptersImaged = 0;

  try {
    db = openCatalogDb(cfg.dbPath);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 10000");
    const catalogDir = catalogDirFromMainDbPath(cfg.dbPath);

    if (flags.resetSeriesSync && onlySeriesId != null) {
      db.prepare(
        `UPDATE catalog_series SET content_sync_complete = 0, content_sync_completed_at = NULL, content_sync_note = NULL WHERE id = ?`
      ).run(onlySeriesId);
      onProgress?.({
        type: "log",
        level: "info",
        message: `Đã reset cờ đồng bộ nội dung cho series id=${onlySeriesId}.`,
      });
    }

    let sql = `SELECT s.id AS id, s.source_id AS source_id, s.series_url AS series_url, s.series_path AS series_path,
                      s.title AS title, s.chapter_count AS chapter_count, s.series_db_file AS series_db_file,
                      s.content_sync_complete AS content_sync_complete,
                      s.content_sync_completed_at AS content_sync_completed_at,
                      s.content_sync_note AS content_sync_note,
                      COALESCE(f.series_url, s.series_url) AS fetch_series_url,
                      COALESCE(f.series_path, s.series_path) AS fetch_series_path,
                      COALESCE(f.source_id, s.source_id) AS fetch_source_id
               FROM catalog_series s
               LEFT JOIN catalog_series f ON f.id = COALESCE(s.preferred_fetch_catalog_id, s.id)
               WHERE 1=1`;
    const params = [];
    if (cfg.sourceIdFilter !== "" && cfg.sourceIdFilter != null) {
      sql += ` AND s.source_id = ?`;
      params.push(cfg.sourceIdFilter);
    }
    if (onlySeriesId != null) {
      sql += ` AND s.id = ?`;
      params.push(onlySeriesId);
    }
    if (skipCompleted) {
      sql += ` AND s.content_sync_complete = 0`;
    }
    sql += ` ORDER BY s.id ASC`;
    if (limitSeries != null && limitSeries > 0) {
      sql += ` LIMIT ? OFFSET ?`;
      params.push(limitSeries, offsetSeries);
    } else if (offsetSeries > 0) {
      sql += ` LIMIT -1 OFFSET ?`;
      params.push(offsetSeries);
    }
    const seriesList = db.prepare(sql).all(...params);

    if (skipCompleted && seriesList.length === 0 && !onlySeriesId) {
      onProgress?.({
        type: "log",
        level: "warn",
        message:
          "Không có bộ nào chờ đồng bộ (content_sync_complete=0). Dùng sync một bộ cụ thể hoặc reset cờ.",
      });
    }

    if (nextSeries && onlySeriesId == null && seriesList.length === 0) {
      onProgress?.({
        type: "log",
        level: "warn",
        message: "Không còn bộ tiếp theo trong hàng đợi.",
      });
    }

    const insertRun = db.prepare(`
      INSERT INTO catalog_content_runs (started_at, ok, message, series_processed, chapters_discovered, chapters_imaged)
      VALUES (?, 0, '', 0, 0, 0)
    `);
    const started = new Date().toISOString();
    const runIns = insertRun.run(started);
    const runId = Number(runIns.lastInsertRowid);

    onProgress?.({ type: "run_start", runId, seriesTotal: seriesList.length });
    checkSyncAborted(abortSignal);

    const finishRun = db.prepare(`
      UPDATE catalog_content_runs SET ended_at = ?, ok = ?, message = ?, series_processed = ?, chapters_discovered = ?, chapters_imaged = ?
      WHERE id = ?
    `);

    try {
      for (let si = 0; si < seriesList.length; si++) {
        checkSyncAborted(abortSignal);
        const s = seriesList[si];
        const fetchSourceId = s.fetch_source_id;
        const src = getContentSource(fetchSourceId);
        const fetchChapterImages = async (url) => {
          const sid = String(fetchSourceId || "").toLowerCase();
          if (contentCookie && sid === "qimanhwa") {
            return fetchQimanhwaImagesFromUrl(url, { cookie: contentCookie });
          }
          return src.fetchChapterImages(url);
        };

        onProgress?.({
          type: "series_start",
          runId,
          seriesIndex: si + 1,
          seriesTotal: seriesList.length,
          seriesId: s.id,
          title: s.title,
          seriesPath: s.series_path,
          sourceId: s.source_id,
          fetchSourceId,
        });

        let html;
        try {
          html = await fetchSeriesHtml(s.fetch_series_url, userAgent, contentCookie);
        } catch (e) {
          lastError = String(e.message || e);
          onProgress?.({
            type: "series_fetch_error",
            seriesId: s.id,
            message: lastError,
          });
          if (si < seriesList.length - 1 && delaySeries > 0) {
            checkSyncAborted(abortSignal);
            await sleep(delaySeries);
          }
          continue;
        }
        checkSyncAborted(abortSignal);

        onProgress?.({ type: "series_page_ok", seriesId: s.id });

        let nums = src.extractChapterNumbersFromSeriesHtml(html, s.fetch_series_path);
        if (nums.length === 0) {
          const relEmpty = seriesDbRelativePath(s.id);
          db.prepare(
            `UPDATE catalog_series SET series_db_file = COALESCE(NULLIF(TRIM(COALESCE(series_db_file,'')), ''), ?),
                 chapters_stored_count = 0, latest_chapter_num = NULL WHERE id = ?`
          ).run(relEmpty, s.id);
          markSeriesContentComplete(
            db,
            s.id,
            "Không có link chapter trong HTML (đánh dấu để không lặp vô hạn)."
          );
          onProgress?.({
            type: "series_marked_complete",
            seriesId: s.id,
            note: "Không có link chapter trong HTML.",
          });
          seriesProcessed++;
          if (si < seriesList.length - 1 && delaySeries > 0) {
            checkSyncAborted(abortSignal);
            await sleep(delaySeries);
          }
          continue;
        }

        if (maxChapters != null && maxChapters > 0 && nums.length > maxChapters) {
          const fromStart = cfg.chapterSlice === "first";
          nums = fromStart ? nums.slice(0, maxChapters) : nums.slice(-maxChapters);
        }

        chaptersDiscovered += nums.length;
        seriesProcessed++;

        /** Trong scope: số chapter tăng dần (cũ → mới). */
        const ascendingNums = [...nums].sort((a, b) => a - b);

        let rel =
          s.series_db_file && String(s.series_db_file).trim()
            ? s.series_db_file
            : null;
        if (!rel) {
          rel = seriesDbRelativePath(s.id);
          db.prepare(`UPDATE catalog_series SET series_db_file = ? WHERE id = ?`).run(rel, s.id);
        }
        const seriesAbs = join(catalogDir, rel);
        onProgress?.({ type: "series_db_path", seriesId: s.id, relativePath: rel });

        let seriesDb = null;
        try {
          seriesDb = openSeriesDbAbsWritable(seriesAbs);
          const { saveChapterWithImages, saveChapterStub } =
            prepareSeriesChapterStatements(seriesDb);

          const existingStmt = seriesDb.prepare(
            `SELECT fetch_ok, image_count FROM chapters WHERE chapter_num = ?`
          );
          const chapterCompleteInDb = (n) => {
            const ex = existingStmt.get(n);
            return !!(ex && ex.fetch_ok && ex.image_count > 0);
          };

          let iterationList;
          if (!fetchImages) {
            iterationList = ascendingNums;
          } else if (force) {
            iterationList = ascendingNums;
          } else {
            iterationList = ascendingNums.filter((n) => !chapterCompleteInDb(n));
          }

          const skippedAlreadySynced =
            fetchImages && !force ? ascendingNums.length - iterationList.length : 0;
          let chapterSkipped = skippedAlreadySynced;
          let chapterImgOk = 0;
          let chapterImgFail = 0;

          onProgress?.({
            type: "chapters_scope",
            seriesId: s.id,
            count: nums.length,
            order: "oldest_first",
            pendingInRun: iterationList.length,
            alreadyCompleteInDb: skippedAlreadySynced,
            chapterNumsSample: ascendingNums.slice(0, 5),
            chapterConcurrency,
          });

          const now = new Date().toISOString();

          let ci = 0;
          while (ci < iterationList.length) {
            checkSyncAborted(abortSignal);
            const n = iterationList[ci];
            const chapterUrl = src.buildChapterUrl(
              s.fetch_series_url,
              s.fetch_series_path,
              n
            );
            const title = "Chapter " + n;

            onProgress?.({
              type: "chapter_begin",
              seriesId: s.id,
              chapterNum: n,
              index: ci + 1,
              total: iterationList.length,
            });

            if (!fetchImages) {
              saveChapterStub({
                chapter_num: n,
                title,
                chapter_url: chapterUrl,
                final_url: null,
                image_count: 0,
                fetch_ok: 0,
                error_message: null,
                chapters_list_fetched_at: now,
                images_fetched_at: null,
              });
              onProgress?.({
                type: "chapter_done",
                seriesId: s.id,
                chapterNum: n,
                index: ci + 1,
                total: iterationList.length,
                action: "stub",
                images: 0,
              });
              if (ci < iterationList.length - 1 && delayChapter > 0) {
                checkSyncAborted(abortSignal);
                await sleep(delayChapter);
              }
              ci++;
              continue;
            }

            if (force) {
              const existing = existingStmt.get(n);
              if (existing && existing.fetch_ok && existing.image_count > 0) {
                chapterSkipped++;
                onProgress?.({
                  type: "chapter_done",
                  seriesId: s.id,
                  chapterNum: n,
                  index: ci + 1,
                  total: iterationList.length,
                  action: "skip",
                  images: existing.image_count,
                });
                ci++;
                continue;
              }
            }

            const batch = [{ n, ci, chapterUrl, title }];
            ci++;
            while (batch.length < chapterConcurrency && ci < iterationList.length) {
              checkSyncAborted(abortSignal);
              const nn = iterationList[ci];
              if (force) {
                const ex = existingStmt.get(nn);
                if (ex && ex.fetch_ok && ex.image_count > 0) {
                  break;
                }
              }
              const urlNn = src.buildChapterUrl(
                s.fetch_series_url,
                s.fetch_series_path,
                nn
              );
              const titleNn = "Chapter " + nn;
              onProgress?.({
                type: "chapter_begin",
                seriesId: s.id,
                chapterNum: nn,
                index: ci + 1,
                total: iterationList.length,
              });
              batch.push({ n: nn, ci, chapterUrl: urlNn, title: titleNn });
              ci++;
            }

            const fetched = await Promise.all(
              batch.map(async ({ n: bn, chapterUrl: bu }) => {
                checkSyncAborted(abortSignal);
                const result = await fetchChapterImages(bu);
                checkSyncAborted(abortSignal);
                return { n: bn, chapterUrl: bu, result };
              })
            );
            const resultByN = new Map(fetched.map((x) => [x.n, x]));

            for (let bi = 0; bi < batch.length; bi++) {
              const { n: bn, ci: bc, chapterUrl: bu, title: bt } = batch[bi];
              const { result } = resultByN.get(bn);
              const images = result.images || [];
              let err = null;
              let ok = result.ok ? 1 : 0;
              if (!result.ok) {
                err = `HTTP ${result.status} ${result.statusText || ""}`.trim();
              } else {
                const final = result.finalUrl || "";
                const m = final.match(/(?:\/|^)(?:chapter|ch)[/-](\d+)/i);
                const finalCh = m ? Number(m[1], 10) : NaN;
                if (Number.isFinite(finalCh) && finalCh !== bn) {
                  ok = 0;
                  err = `Redirect chapter ${finalCh} ≠ ${bn}`;
                } else if (images.length === 0) {
                  ok = 0;
                  err = "Không parse được ảnh (data-page / CDN embed)";
                }
              }

              if (ok) {
                chaptersImaged++;
                chapterImgOk++;
              } else {
                chapterImgFail++;
              }

              saveChapterWithImages(
                {
                  chapter_num: bn,
                  title: bt,
                  chapter_url: bu,
                  final_url: result.finalUrl || null,
                  image_count: images.length,
                  fetch_ok: ok,
                  error_message: err,
                  chapters_list_fetched_at: now,
                  images_fetched_at: ok ? now : null,
                },
                ok ? images : []
              );

              onProgress?.({
                type: "chapter_done",
                seriesId: s.id,
                chapterNum: bn,
                index: bc + 1,
                total: iterationList.length,
                action: ok ? "fetch_ok" : "fetch_fail",
                images: images.length,
                error: err || undefined,
              });

              if (bc < iterationList.length - 1 && delayChapter > 0) {
                checkSyncAborted(abortSignal);
                await sleep(delayChapter);
              }
            }
          }

          updateSeriesSummaryFromChaptersDb(db, s.id, seriesDb);

          const note = fetchImages
            ? `${chapterImgOk} tải OK, ${chapterSkipped} đã có trong DB, ${chapterImgFail} lỗi / ${nums.length} ch trong scope`
            : `Chỉ index URL chapter (${nums.length} ch), chưa tải ảnh`;
          if (fetchImages) {
            markSeriesContentComplete(db, s.id, note);
            onProgress?.({
              type: "series_complete",
              seriesId: s.id,
              note,
              contentSyncComplete: true,
            });
          } else {
            onProgress?.({
              type: "series_complete",
              seriesId: s.id,
              note,
              contentSyncComplete: false,
            });
          }
        } finally {
          if (seriesDb) {
            try {
              seriesDb.close();
            } catch {
              /* ignore */
            }
          }
        }

        if (si < seriesList.length - 1 && delaySeries > 0) {
          checkSyncAborted(abortSignal);
          await sleep(delaySeries);
        }
      }

      const msg = `Xong · ${seriesProcessed} bộ · ${chaptersDiscovered} chapter (lần đếm) · ${chaptersImaged} chapter có ảnh OK`;
      finishRun.run(
        new Date().toISOString(),
        1,
        msg,
        seriesProcessed,
        chaptersDiscovered,
        chaptersImaged,
        runId
      );
      onProgress?.({
        type: "run_finish",
        ok: true,
        message: msg,
        seriesProcessed,
        chaptersDiscovered,
        chaptersImaged,
        runId,
      });
      return {
        ok: true,
        message: msg,
        seriesProcessed,
        chaptersDiscovered,
        chaptersImaged,
        lastError: null,
      };
    } catch (e) {
      const aborted = !!(e && e.code === SYNC_ABORT_CODE);
      lastError = String(e.message || e);
      finishRun.run(
        new Date().toISOString(),
        0,
        lastError,
        seriesProcessed,
        chaptersDiscovered,
        chaptersImaged,
        runId
      );
      if (aborted) {
        onProgress?.({
          type: "run_aborted",
          runId,
          message: lastError,
          seriesProcessed,
          chaptersDiscovered,
          chaptersImaged,
        });
      }
      onProgress?.({
        type: "run_finish",
        ok: false,
        message: lastError,
        seriesProcessed,
        chaptersDiscovered,
        chaptersImaged,
        runId,
        aborted,
      });
      return {
        ok: false,
        message: lastError,
        seriesProcessed,
        chaptersDiscovered,
        chaptersImaged,
        lastError,
        aborted,
      };
    }
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
    if (lock) lock.release();
  }
}
