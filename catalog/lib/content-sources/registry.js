import {
  extractChapterNumbersFromSeriesHtml as asuraExtract,
  buildAsuraChapterUrl,
} from "../asura-chapter-index.js";
import { collectAsuraPageImages, fetchAsuraImagesFromUrl } from "../../../extract.mjs";
import {
  extractChapterNumbersFromQimanhwaHtml,
  buildQimanhwaChapterUrl,
  fetchQimanhwaImagesFromUrl,
} from "./qimanhwa-chapter.js";

const asuraSource = {
  id: "asura",
  extractChapterNumbersFromSeriesHtml: asuraExtract,
  buildChapterUrl: buildAsuraChapterUrl,
  fetchChapterImages: fetchAsuraImagesFromUrl,
  collectPageImages: collectAsuraPageImages,
};

const qimanhwaSource = {
  id: "qimanhwa",
  extractChapterNumbersFromSeriesHtml: extractChapterNumbersFromQimanhwaHtml,
  buildChapterUrl: buildQimanhwaChapterUrl,
  fetchChapterImages: fetchQimanhwaImagesFromUrl,
  collectPageImages: null,
};

const BY_ID = {
  asura: asuraSource,
  asurascans: asuraSource,
  qimanhwa: qimanhwaSource,
};

/**
 * @param {string} [sourceId]
 */
export function getContentSource(sourceId) {
  const k = String(sourceId || "asura")
    .trim()
    .toLowerCase();
  return BY_ID[k] || asuraSource;
}
