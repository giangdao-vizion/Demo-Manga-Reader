import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Lock quá cũ (tiến trình chết / kill -9) thì cho phép chiếm lại. */
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * @param {string} dbPath - relative hoặc absolute (chưa resolve cwd)
 * @returns {{ lockPath: string, release: () => void }}
 */
export function acquireCatalogContentLock(dbPath) {
  const absDir = dirname(resolve(process.cwd(), dbPath));
  const lockPath = join(absDir, ".catalog-content.lock");
  const staleMs = Number(process.env.CATALOG_CONTENT_LOCK_STALE_MS || DEFAULT_STALE_MS);
  const breakStale = process.env.CATALOG_CONTENT_BREAK_STALE_LOCK === "1";

  function writeLock() {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        started: new Date().toISOString(),
      }),
      { flag: "wx" }
    );
  }

  function tryRemoveStale() {
    if (!existsSync(lockPath)) return false;
    try {
      const raw = readFileSync(lockPath, "utf8");
      const j = JSON.parse(raw);
      const t = j.started ? new Date(j.started).getTime() : 0;
      const stale = !Number.isFinite(t) || Date.now() - t > staleMs;
      if (stale || breakStale) {
        unlinkSync(lockPath);
        return true;
      }
    } catch {
      if (breakStale) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        return true;
      }
    }
    return false;
  }

  try {
    writeLock();
  } catch (e) {
    if (e && e.code === "EEXIST") {
      if (tryRemoveStale()) {
        try {
          writeLock();
        } catch (e2) {
          throw lockBusyError(lockPath, e2);
        }
      } else {
        throw lockBusyError(lockPath, e);
      }
    } else {
      throw e;
    }
  }

  let released = false;
  function release() {
    if (released) return;
    released = true;
    try {
      if (existsSync(lockPath)) {
        const raw = readFileSync(lockPath, "utf8");
        const j = JSON.parse(raw);
        if (Number(j.pid) === process.pid) {
          unlinkSync(lockPath);
        }
      }
    } catch {
      /* ignore */
    }
  }

  process.once("exit", release);
  process.once("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    release();
    process.exit(143);
  });

  return { lockPath, release };
}

function lockBusyError(lockPath, cause) {
  const err = new Error(
    "Đã có một lệnh catalog:content đang chạy (hoặc file lock còn sót). " +
      `Lock: ${lockPath}. Đợi xong, hoặc nếu chắc không còn tiến trình: xóa file lock hoặc ` +
      "CATALOG_CONTENT_BREAK_STALE_LOCK=1 npm run catalog:content"
  );
  err.code = "ECATALOGCONTENTLOCK";
  err.cause = cause;
  return err;
}
