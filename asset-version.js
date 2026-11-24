/**
 * Cache-bust token for static JSON (manhwa-catalog.json, data-json/*.json).
 * Bump whenever catalog/content is published — see catalog/lib/sync-asset-version.js.
 */
(function (global) {
  var VERSION = "2026-11-24T00:07:05.089Z";

  function withVersion(url) {
    var v = VERSION || "";
    if (!v || !url) return url;
    try {
      var u = new URL(String(url), global.location.href);
      u.searchParams.set("v", v);
      return u.href;
    } catch (_) {
      var s = String(url);
      var sep = s.indexOf("?") >= 0 ? "&" : "?";
      return s + sep + "v=" + encodeURIComponent(v);
    }
  }

  global.COMIC_HUB_ASSET_VERSION = VERSION;
  global.ComicHubAssets = {
    version: function () {
      return VERSION;
    },
    withVersion: withVersion,
  };
})(typeof window !== "undefined" ? window : globalThis);
