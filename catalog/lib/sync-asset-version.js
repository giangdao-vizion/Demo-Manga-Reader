/**
 * Đồng bộ asset-version.js (browser) với token cache-bust.
 *
 * Usage (Node):
 *   import { writeBrowserAssetVersion, syncAssetVersionFromCatalogFile } from "./sync-asset-version.js";
 *   await writeBrowserAssetVersion(catalog.updatedAt);
 */
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSET_VERSION_PATH = resolve(ROOT, "asset-version.js");

function escapeForJsString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderAssetVersionSource(version) {
  const v = String(version || new Date().toISOString()).trim() || new Date().toISOString();
  const body =
    "/**\n" +
    " * Cache-bust token for static JSON (manhwa-catalog.json, data-json/*.json).\n" +
    " * Bump whenever catalog/content is published — see catalog/lib/sync-asset-version.js.\n" +
    " */\n" +
    "(function (global) {\n" +
    '  var VERSION = "' +
    escapeForJsString(v) +
    '";\n' +
    "\n" +
    "  function withVersion(url) {\n" +
    "    var v = VERSION || \"\";\n" +
    "    if (!v || !url) return url;\n" +
    "    try {\n" +
    "      var u = new URL(String(url), global.location.href);\n" +
    '      u.searchParams.set("v", v);\n' +
    "      return u.href;\n" +
    "    } catch (_) {\n" +
    "      var s = String(url);\n" +
    '      var sep = s.indexOf("?") >= 0 ? "&" : "?";\n' +
    '      return s + sep + "v=" + encodeURIComponent(v);\n' +
    "    }\n" +
    "  }\n" +
    "\n" +
    "  global.COMIC_HUB_ASSET_VERSION = VERSION;\n" +
    "  global.ComicHubAssets = {\n" +
    "    version: function () {\n" +
    "      return VERSION;\n" +
    "    },\n" +
    "    withVersion: withVersion,\n" +
    "  };\n" +
    "})(typeof window !== \"undefined\" ? window : globalThis);\n";
  return { version: v, body };
}

/**
 * @param {string} version ISO timestamp or opaque token
 * @param {string} [outPath]
 */
export function writeBrowserAssetVersionSync(version, outPath = ASSET_VERSION_PATH) {
  const { version: v, body } = renderAssetVersionSource(version);
  writeFileSync(outPath, body, "utf8");
  return v;
}

/**
 * @param {string} version ISO timestamp or opaque token
 * @param {string} [outPath]
 */
export async function writeBrowserAssetVersion(version, outPath = ASSET_VERSION_PATH) {
  const { version: v, body } = renderAssetVersionSource(version);
  await writeFile(outPath, body, "utf8");
  return v;
}

/**
 * @param {string} [catalogPath] relative to repo root or absolute
 */
export async function syncAssetVersionFromCatalogFile(catalogPath = "manhwa-catalog.json") {
  const abs = resolve(ROOT, catalogPath);
  const catalog = JSON.parse(await readFile(abs, "utf8"));
  const v = catalog && catalog.updatedAt ? String(catalog.updatedAt) : new Date().toISOString();
  await writeBrowserAssetVersion(v);
  return v;
}
