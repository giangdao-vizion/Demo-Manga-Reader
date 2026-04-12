(function () {
      const PARAM_SERIES_ID = "seriesId";
      const PARAM_CHAPTER = "c";
      const PARAM_CHAPTER_ALT = "chapter";
      const LS_LOAD_CONCURRENCY = "reader-load-concurrency";
      const LS_PREFETCH_AHEAD = "reader-prefetch-chapters-ahead";
      const LS_READ_CHAPTERS = "reader-read-chapters-v1";

      function readChaptersLoadMap() {
        try {
          const raw = localStorage.getItem(LS_READ_CHAPTERS);
          if (!raw) return {};
          const j = JSON.parse(raw);
          return j && typeof j === "object" && !Array.isArray(j) ? j : {};
        } catch {
          return {};
        }
      }

      function readChaptersSaveMap(map) {
        try {
          localStorage.setItem(LS_READ_CHAPTERS, JSON.stringify(map));
        } catch {
          /* quota / private mode */
        }
      }

      function readChaptersMarkRead(manifestKey, chapterNum) {
        const k = String(manifestKey || "").trim() || "_";
        const c = String(chapterNum);
        const map = readChaptersLoadMap();
        if (!map[k]) map[k] = Object.create(null);
        map[k][c] = 1;
        readChaptersSaveMap(map);
      }

      function readChaptersIsRead(manifestKey, chapterNum) {
        const k = String(manifestKey || "").trim() || "_";
        const c = String(chapterNum);
        const map = readChaptersLoadMap();
        const book = map[k];
        return !!(book && book[c]);
      }

      function refreshNavReadMarks() {
        if (!data) return;
        el.nav.querySelectorAll("button.chap").forEach((btn, i) => {
          const ch = data.chapters[i];
          if (!ch) return;
          const num = ch.chapter != null ? ch.chapter : i + 1;
          const has = readChaptersIsRead(manifestKey, num);
          const existing = btn.querySelector(".read-check");
          if (has && !existing) {
            const sp = document.createElement("span");
            sp.className = "read-check";
            sp.setAttribute("aria-hidden", "true");
            sp.textContent = "✓";
            btn.insertBefore(sp, btn.firstChild);
          } else if (!has && existing) {
            existing.remove();
          }
        });
      }

      function getLoadConcurrency() {
        const raw = localStorage.getItem(LS_LOAD_CONCURRENCY);
        const n = parseInt(raw, 10);
        if (n === 2 || n === 3 || n === 5) return n;
        return 1;
      }

      function setLoadConcurrency(n) {
        const v = n === 2 || n === 3 || n === 5 ? n : 1;
        localStorage.setItem(LS_LOAD_CONCURRENCY, String(v));
        return v;
      }

      function getPrefetchChaptersAhead() {
        const raw = localStorage.getItem(LS_PREFETCH_AHEAD);
        const n = parseInt(raw, 10);
        if (n === 1 || n === 2 || n === 3) return n;
        return 0;
      }

      function setPrefetchChaptersAhead(n) {
        const v = n === 1 || n === 2 || n === 3 ? n : 0;
        localStorage.setItem(LS_PREFETCH_AHEAD, String(v));
        return v;
      }

      function removeChapterProgressBar() {
        document.getElementById("chapterLoadProgress")?.remove();
        document.body.classList.remove("has-chapter-progress");
        document.documentElement.style.removeProperty("--chapter-progress-offset");
      }

      function syncChapterProgressBodyOffset() {
        const bar = document.getElementById("chapterLoadProgress");
        if (!bar || !document.body.classList.contains("has-chapter-progress")) {
          document.documentElement.style.removeProperty("--chapter-progress-offset");
          return;
        }
        const h = Math.ceil(bar.getBoundingClientRect().height);
        document.documentElement.style.setProperty("--chapter-progress-offset", h + "px");
      }

      window.addEventListener("resize", syncChapterProgressBodyOffset);
      window.addEventListener("orientationchange", syncChapterProgressBodyOffset);
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(syncChapterProgressBodyOffset);
      }

      const el = {
        nav: document.getElementById("chapterNav"),
        main: document.getElementById("main"),
        title: document.getElementById("appTitle"),
        meta: document.getElementById("appMeta"),
        placeholder: document.getElementById("placeholder"),
        concurrencySelect: document.getElementById("loadConcurrencySelect"),
        prefetchAheadSelect: document.getElementById("prefetchAheadSelect"),
        scrollTopBtn: document.getElementById("scrollTopBtn"),
        readScrollPercent: document.getElementById("readScrollPercent"),
      };

      let data = null;
      let activeIndex = -1;
      let catalogSeriesId = null;
      let manifestKey = "";
      let sequentialToken = 0;

      const SCROLL_TOP_SHOW_AT = 120;

      function prefersReducedMotion() {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      }

      /** Cuộn thực tế: có thể là main.reader hoặc document (trước khi khóa body). */
      function getReaderScrollY() {
        const doc = document.documentElement;
        const body = document.body;
        const winY =
          window.scrollY ?? window.pageYOffset ?? doc.scrollTop ?? body.scrollTop ?? 0;
        return Math.max(el.main.scrollTop || 0, winY);
      }

      /** % cuộn: so với document hoặc main — dùng nơi có vùng cuộn lớn hơn. */
      function getChapterViewScrollPercent() {
        const vh = window.innerHeight || 1;
        const docEl = document.documentElement;
        const docScroll =
          window.scrollY ?? window.pageYOffset ?? docEl.scrollTop ?? document.body.scrollTop ?? 0;
        const docTotal = Math.max(docEl.scrollHeight, document.body.scrollHeight);
        const docMax = Math.max(0, docTotal - vh);

        const main = el.main;
        const mainScroll = main.scrollTop || 0;
        const mainMax = Math.max(0, main.scrollHeight - main.clientHeight);

        const useMain = mainMax > docMax;
        const maxScroll = useMain ? mainMax : docMax;
        const scrollPos = useMain ? mainScroll : docScroll;
        if (maxScroll <= 0) return 100;
        const pct = (scrollPos / maxScroll) * 100;
        return Math.min(100, Math.max(0, Math.round(pct)));
      }

      let readScrollPercentRaf = 0;
      let readScrollPercentRetryTimer = 0;

      function syncReadScrollPercentCore() {
        if (!el.readScrollPercent) return;
        const inChapter =
          data != null &&
          activeIndex >= 0 &&
          el.main.querySelector(".pages") != null;
        if (!inChapter) {
          el.readScrollPercent.hidden = true;
          return;
        }
        el.readScrollPercent.hidden = false;
        el.readScrollPercent.textContent = getChapterViewScrollPercent() + "%";
      }

      function syncReadScrollPercent() {
        try {
          syncReadScrollPercentCore();
        } catch {
          if (readScrollPercentRetryTimer) return;
          readScrollPercentRetryTimer = window.setTimeout(function () {
            readScrollPercentRetryTimer = 0;
            try {
              syncReadScrollPercentCore();
            } catch {
              /* không ảnh hưởng đọc truyện */
            }
          }, 150);
        }
      }

      function scheduleReadScrollPercent() {
        if (readScrollPercentRaf) return;
        readScrollPercentRaf = requestAnimationFrame(function () {
          readScrollPercentRaf = 0;
          syncReadScrollPercent();
        });
      }

      function syncScrollTopBtnVisibility() {
        if (!el.scrollTopBtn) return;
        const show = getReaderScrollY() > SCROLL_TOP_SHOW_AT;
        el.scrollTopBtn.classList.toggle("is-visible", show);
        el.scrollTopBtn.setAttribute("aria-hidden", show ? "false" : "true");
        el.scrollTopBtn.tabIndex = show ? 0 : -1;
      }

      function onReaderScrollOrResize() {
        syncScrollTopBtnVisibility();
        scheduleReadScrollPercent();
      }

      function scrollReaderToTopSmooth() {
        const behavior = prefersReducedMotion() ? "auto" : "smooth";
        el.main.scrollTo({ top: 0, left: 0, behavior });
        window.scrollTo({ top: 0, left: 0, behavior });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }

      el.main.addEventListener("scroll", onReaderScrollOrResize, { passive: true });
      window.addEventListener("scroll", onReaderScrollOrResize, { passive: true });
      window.addEventListener("resize", onReaderScrollOrResize);
      if (el.scrollTopBtn) {
        el.scrollTopBtn.addEventListener("click", function () {
          scrollReaderToTopSmooth();
        });
      }
      onReaderScrollOrResize();

      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(function () {
          scheduleReadScrollPercent();
        }).observe(el.main);
      }

      if (el.concurrencySelect) {
        el.concurrencySelect.value = String(getLoadConcurrency());
        el.concurrencySelect.addEventListener("change", function () {
          const v = setLoadConcurrency(parseInt(el.concurrencySelect.value, 10));
          el.concurrencySelect.value = String(v);
          if (data != null && activeIndex >= 0) {
            void setActive(activeIndex);
          }
        });
      }

      if (el.prefetchAheadSelect) {
        el.prefetchAheadSelect.value = String(getPrefetchChaptersAhead());
        el.prefetchAheadSelect.addEventListener("change", function () {
          const v = setPrefetchChaptersAhead(parseInt(el.prefetchAheadSelect.value, 10));
          el.prefetchAheadSelect.value = String(v);
          if (getPrefetchChaptersAhead() > 0 && isCurrentChapterViewFullyLoaded()) {
            prefetchFollowingChapterImages(activeIndex, sequentialToken);
          }
        });
      }

      function currentParams() {
        return new URLSearchParams(location.search);
      }

      function getCatalogSeriesIdFromUrl() {
        const p = currentParams();
        const raw = p.get(PARAM_SERIES_ID);
        if (raw == null || raw === "") return null;
        const n = parseInt(String(raw), 10);
        return Number.isFinite(n) ? n : null;
      }

      function getChapterQueryNumber() {
        const p = currentParams();
        const raw = p.get(PARAM_CHAPTER) || p.get(PARAM_CHAPTER_ALT);
        if (raw == null || raw === "") return null;
        const n = parseInt(String(raw), 10);
        return Number.isFinite(n) ? n : null;
      }

      function getChapterFromHash() {
        const m = location.hash.match(/^#c(\d+)$/i);
        return m ? parseInt(m[1], 10) : null;
      }

      function syncUrl() {
        if (!data || activeIndex < 0 || catalogSeriesId == null) return;
        const ch = data.chapters[activeIndex];
        if (!ch || ch.chapter == null) return;
        const u = new URL(location.href);
        u.searchParams.set(PARAM_CHAPTER, String(ch.chapter));
        u.searchParams.set(PARAM_SERIES_ID, String(catalogSeriesId));
        u.hash = "";
        const next = u.pathname + u.search;
        if (next !== location.pathname + location.search) {
          history.replaceState(null, "", next);
        }
      }

      function validateManifest(j) {
        if (!j || j.ok === false) {
          throw new Error((j && j.error) || "Manifest không hợp lệ");
        }
        if (!Array.isArray(j.chapters)) {
          throw new Error('Thiếu mảng "chapters".');
        }
        return j;
      }

      async function loadManifestFromApi() {
        const res = await fetch(
          "/api/reader/manifest?seriesId=" + encodeURIComponent(String(catalogSeriesId)),
          { credentials: "same-origin", cache: "no-store" }
        );
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.ok === false) {
          throw new Error(j.error || "HTTP " + res.status);
        }
        return validateManifest(j);
      }

      async function ensureChapterImagesLoaded(index) {
        if (!data || index < 0 || index >= data.chapters.length) return;
        const ch = data.chapters[index];
        if (Array.isArray(ch.images) && ch.images.length > 0) return;
        if (ch._loadPromise) return ch._loadPromise;
        ch._loadPromise = (async () => {
          const res = await fetch(
            "/api/reader/chapter?seriesId=" +
              encodeURIComponent(String(catalogSeriesId)) +
              "&chapterNum=" +
              encodeURIComponent(String(ch.chapter)),
            { credentials: "same-origin", cache: "no-store" }
          );
          const j = await res.json().catch(() => ({}));
          if (!res.ok || j.ok === false) {
            throw new Error(j.error || res.statusText || "Lỗi tải chapter");
          }
          ch.images = Array.isArray(j.images) ? j.images : [];
          if (j.error != null) ch.error = j.error;
          if (typeof j.title === "string" && j.title) ch.title = j.title;
          ch.total = ch.images.length;
        })().finally(() => {
          delete ch._loadPromise;
        });
        return ch._loadPromise;
      }

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function bustUrl(src) {
        try {
          const u = new URL(src, location.href);
          u.searchParams.set("_r", String(Date.now()));
          return u.href;
        } catch {
          return src + (src.indexOf("?") >= 0 ? "&" : "?") + "_r=" + Date.now();
        }
      }

      function scrollReaderToTop() {
        el.main.scrollTop = 0;
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        onReaderScrollOrResize();
        requestAnimationFrame(function () {
          el.main.scrollTop = 0;
          window.scrollTo(0, 0);
          onReaderScrollOrResize();
        });
      }

      async function setActive(index) {
        if (!data || index < 0 || index >= data.chapters.length) return;
        activeIndex = index;
        const chOpen = data.chapters[index];
        const numOpen = chOpen.chapter != null ? chOpen.chapter : index + 1;
        readChaptersMarkRead(manifestKey, numOpen);
        let activeBtn = null;
        el.nav.querySelectorAll("button.chap").forEach((btn, i) => {
          btn.classList.toggle("active", i === index);
          if (i === index) activeBtn = btn;
        });

        sequentialToken += 1;
        const loadGen = sequentialToken;

        el.main.innerHTML =
          '<div class="empty glass">Đang tải chapter từ SQLite…</div>';

        try {
          await ensureChapterImagesLoaded(index);
        } catch (e) {
          if (loadGen !== sequentialToken) return;
          showMainError(e.message || String(e));
          syncUrl();
          refreshNavReadMarks();
          if (activeBtn) {
            activeBtn.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
          }
          return;
        }

        if (loadGen !== sequentialToken) return;
        renderChapter(loadGen);
        syncUrl();
        scrollReaderToTop();
        if (activeBtn) {
          activeBtn.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
        }
        refreshNavReadMarks();
      }

      function renderNav() {
        el.nav.innerHTML = "";
        const h2 = document.createElement("h2");
        h2.textContent = "Chương";
        el.nav.appendChild(h2);
        const rail = document.createElement("div");
        rail.className = "rail-inner";

        data.chapters.forEach((ch, i) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "chap";
          if (ch.error) btn.classList.add("has-error");
          const num = ch.chapter != null ? ch.chapter : i + 1;
          const total = typeof ch.total === "number" ? ch.total : (ch.images || []).length;
          const check =
            readChaptersIsRead(manifestKey, num)
              ? '<span class="read-check" aria-hidden="true">✓</span>'
              : "";
          btn.innerHTML =
            check +
            '<span class="n">Ch.' +
            escapeHtml(String(num)) +
            '</span><span class="cnt">' +
            total +
            (ch.error ? " !" : "") +
            "</span>";
          btn.addEventListener("click", () => {
            void setActive(i);
          });
          rail.appendChild(btn);
        });
        el.nav.appendChild(rail);
      }

      /**
       * Tải trước ảnh chương kế (Image ngoài DOM) để vào HTTP cache; không bơm URL mới khi cancelToken !== sequentialToken.
       */
      function prefetchChapterImages(urls, cancelToken) {
        const list = [];
        for (let u = 0; u < urls.length; u++) {
          const s = urls[u];
          if (typeof s !== "string" || !s.trim()) continue;
          if (/^data:/i.test(s)) continue;
          list.push(s);
        }
        if (!list.length) return;
        const maxP = Math.max(1, Math.min(3, getLoadConcurrency()));
        let i = 0;
        let inflight = 0;
        function pump() {
          if (cancelToken !== sequentialToken) return;
          while (inflight < maxP && i < list.length) {
            const src = list[i++];
            inflight++;
            const im = new Image();
            im.referrerPolicy = "no-referrer";
            im.decoding = "async";
            function step() {
              if (cancelToken !== sequentialToken) return;
              inflight--;
              pump();
            }
            im.onload = step;
            im.onerror = step;
            im.src = src;
          }
        }
        pump();
      }

      /** Tải chapter kế từ API nếu cần, rồi prefetch ảnh vào cache. */
      function prefetchFollowingChapterImages(fromActiveIndex, cancelToken) {
        const k = getPrefetchChaptersAhead();
        if (k <= 0 || !data || fromActiveIndex < 0) return;
        void (async () => {
          for (let j = 1; j <= k; j++) {
            if (cancelToken !== sequentialToken) return;
            const idx = fromActiveIndex + j;
            if (idx >= data.chapters.length) break;
            try {
              await ensureChapterImagesLoaded(idx);
            } catch {
              /* bỏ qua prefetch lỗi */
            }
            if (cancelToken !== sequentialToken) return;
            const imgs = Array.isArray(data.chapters[idx].images)
              ? data.chapters[idx].images
              : [];
            prefetchChapterImages(imgs, cancelToken);
          }
        })();
      }

      function isCurrentChapterViewFullyLoaded() {
        if (!data || activeIndex < 0) return false;
        const slots = el.main.querySelectorAll(".page-slot");
        if (!slots.length) return false;
        for (let si = 0; si < slots.length; si++) {
          const s = slots[si];
          if (s.classList.contains("is-error")) return false;
          if (!s.querySelector("img.is-visible")) return false;
        }
        return true;
      }

      function renderChapter(token) {
        if (!data || activeIndex < 0 || activeIndex >= data.chapters.length) return;

        removeChapterProgressBar();

        const ch = data.chapters[activeIndex];
        const images = Array.isArray(ch.images) ? ch.images : [];
        const title = ch.title || "Chapter " + (ch.chapter ?? activeIndex + 1);

        el.main.innerHTML = "";

        const head = document.createElement("div");
        head.className = "chapter-head";
        const maxC = getLoadConcurrency();
        const modeLabel =
          maxC === 1
            ? "tuần tự (1 ảnh)"
            : "song song tối đa " + maxC + " ảnh";
        head.innerHTML =
          "<h2>" +
          escapeHtml(title) +
          "</h2><p>" +
          images.length +
          " trang · " +
          modeLabel +
          (ch.error ? " · " + escapeHtml(ch.error) : "") +
          "</p>";
        el.main.appendChild(head);

        if (images.length === 0) {
          removeChapterProgressBar();
          const empty = document.createElement("p");
          empty.className = "empty glass";
          empty.textContent = "Chapter không có ảnh.";
          el.main.appendChild(empty);
          return;
        }

        const progressWrap = document.createElement("div");
        progressWrap.id = "chapterLoadProgress";
        progressWrap.className = "chapter-load-progress is-loading";
        const progressInner = document.createElement("div");
        progressInner.className = "load-progress-inner";
        const track = document.createElement("div");
        track.className = "load-progress-track";
        const fill = document.createElement("div");
        fill.className = "load-progress-fill";
        const busy = document.createElement("div");
        busy.className = "load-progress-busy";
        const progressLabel = document.createElement("p");
        progressLabel.className = "load-progress-label";
        track.appendChild(fill);
        track.appendChild(busy);
        progressInner.appendChild(track);
        progressInner.appendChild(progressLabel);
        progressWrap.appendChild(progressInner);
        document.body.appendChild(progressWrap);
        document.body.classList.add("has-chapter-progress");
        syncChapterProgressBodyOffset();
        requestAnimationFrame(function () {
          syncChapterProgressBodyOffset();
        });

        const pages = document.createElement("div");
        pages.className = "pages";
        pages.style.touchAction = "pan-y";
        ["contextmenu", "dragstart", "selectstart"].forEach(function (evName) {
          pages.addEventListener(evName, function (ev) {
            ev.preventDefault();
          });
        });

        let nextSchedule = 0;
        let inFlight = 0;
        const completed = new Set();
        let prefetchNextStarted = false;

        function tryPrefetchNextChapterIfComplete() {
          if (prefetchNextStarted || token !== sequentialToken) return;
          const total = images.length;
          const done = completed.size;
          const anyErr = pages.querySelector(".page-slot.is-error") !== null;
          if (done < total || inFlight > 0 || anyErr) return;
          if (getPrefetchChaptersAhead() <= 0) return;
          if (!data || activeIndex + 1 >= data.chapters.length) return;
          prefetchNextStarted = true;
          const cancelToken = sequentialToken;
          setTimeout(function () {
            if (cancelToken !== sequentialToken) return;
            prefetchFollowingChapterImages(activeIndex, cancelToken);
          }, 0);
        }

        function updateProgressUI() {
          const total = images.length;
          const done = completed.size;
          const pct = total ? Math.min(100, (done / total) * 100) : 0;
          fill.style.width = pct + "%";
          const anyErr = pages.querySelector(".page-slot.is-error") !== null;
          const stillGoing =
            inFlight > 0 || (nextSchedule < total && done < total);

          if (done >= total && inFlight === 0 && !anyErr) {
            progressWrap.classList.remove("is-loading");
            progressLabel.textContent = "Đã tải xong " + total + " trang.";
            tryPrefetchNextChapterIfComplete();
            return;
          }

          if (anyErr && !stillGoing && done < total) {
            progressWrap.classList.remove("is-loading");
            progressLabel.textContent =
              "Đã " +
              done +
              " / " +
              total +
              " trang — có lỗi, bấm Tải lại tại trang đó";
            return;
          }

          progressWrap.classList.toggle("is-loading", stillGoing);
          if (stillGoing) {
            progressLabel.textContent =
              "Đang tải · " +
              done +
              " / " +
              total +
              " trang xong · tối đa " +
              maxC +
              " ảnh cùng lúc";
          } else if (done >= total) {
            progressWrap.classList.remove("is-loading");
            progressLabel.textContent = "Đã tải xong " + total + " trang.";
            tryPrefetchNextChapterIfComplete();
          }
        }

        function scheduleNext() {
          if (token !== sequentialToken) return;
          while (inFlight < maxC && nextSchedule < images.length) {
            const idx = nextSchedule++;
            startLoadAt(idx, images[idx]);
          }
          updateProgressUI();
        }

        function startLoadAt(index, imageUrl) {
          if (token !== sequentialToken) return;
          inFlight++;

          const slot = pages.children[index];
          if (!slot) {
            inFlight--;
            scheduleNext();
            return;
          }
          const errEl = slot.querySelector(".err");
          const shimmer = slot.querySelector(".shimmer");

          slot.classList.remove("is-error");
          if (shimmer) shimmer.style.display = "";

          const prevImg = slot.querySelector("img");
          if (prevImg) prevImg.remove();

          const img = document.createElement("img");
          img.alt = title + " — " + (index + 1);
          img.referrerPolicy = "no-referrer";
          img.decoding = "async";
          img.draggable = false;
          slot.insertBefore(img, errEl);

          img.onload = function () {
            if (token !== sequentialToken) return;
            inFlight--;
            completed.add(index);
            if (shimmer) shimmer.style.display = "none";
            img.classList.add("is-visible");
            updateProgressUI();
            scheduleNext();
          };
          img.onerror = function () {
            if (token !== sequentialToken) return;
            inFlight--;
            slot.classList.add("is-error");
            img.classList.remove("is-visible");
            if (shimmer) shimmer.style.display = "none";
            updateProgressUI();
            scheduleNext();
          };

          updateProgressUI();
          img.src = "";
          img.src = imageUrl;
        }

        images.forEach((src, idx) => {
          const slot = document.createElement("div");
          slot.className = "page-slot";
          slot.dataset.index = String(idx);

          const shimmer = document.createElement("div");
          shimmer.className = "shimmer";
          slot.appendChild(shimmer);

          const err = document.createElement("div");
          err.className = "err";
          err.innerHTML =
            "<span>Không tải được trang " + (idx + 1) + ".</span>";
          const retry = document.createElement("button");
          retry.type = "button";
          retry.textContent = "Tải lại ảnh này";
          err.appendChild(retry);
          slot.appendChild(err);

          retry.addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            startLoadAt(idx, bustUrl(images[idx]));
          });

          pages.appendChild(slot);
        });

        el.main.appendChild(pages);

        if (activeIndex < data.chapters.length - 1) {
          const footer = document.createElement("div");
          footer.className = "chapter-footer glass";
          const nextBtn = document.createElement("button");
          nextBtn.type = "button";
          const nextCh = data.chapters[activeIndex + 1];
          const nn = nextCh.chapter != null ? nextCh.chapter : activeIndex + 2;
          nextBtn.textContent = "Chương tiếp — Ch." + nn;
          nextBtn.addEventListener("click", () => {
            void setActive(activeIndex + 1);
          });
          footer.appendChild(nextBtn);
          el.main.appendChild(footer);
        }

        nextSchedule = 0;
        inFlight = 0;
        completed.clear();
        scheduleNext();
      }

      function resolveStartChapter(j) {
        const q = getChapterQueryNumber();
        if (q != null) {
          const found = j.chapters.findIndex((c) => c.chapter === q);
          if (found >= 0) return found;
        }
        const h = getChapterFromHash();
        if (h != null) {
          const found = j.chapters.findIndex((c) => c.chapter === h);
          if (found >= 0) return found;
        }
        return 0;
      }

      async function applyData(j) {
        data = j;
        catalogSeriesId = j.seriesId != null ? Number(j.seriesId) : getCatalogSeriesIdFromUrl();
        manifestKey = "sqlite:" + String(catalogSeriesId);

        const from = j.fromChapter;
        const to = j.toChapter;
        const seriesTitle = j.title && String(j.title).trim();
        el.title.textContent = seriesTitle
          ? seriesTitle
          : from != null && to != null
            ? "Ch." + from + " – " + to
            : "Reader · SQLite";

        const parts = [];
        if (j.fetchedAt) {
          parts.push(String(j.fetchedAt));
        }
        parts.push(j.chapters.length + " chương");
        parts.push("seriesId=" + catalogSeriesId + " · SQLite");
        el.meta.textContent = parts.join(" · ");

        renderNav();
        await setActive(resolveStartChapter(j));
      }

      function showMainError(msg) {
        removeChapterProgressBar();
        el.main.innerHTML = '<div class="error-box glass">' + escapeHtml(msg) + "</div>";
        onReaderScrollOrResize();
      }

      async function init() {
        catalogSeriesId = getCatalogSeriesIdFromUrl();
        if (catalogSeriesId == null) {
          removeChapterProgressBar();
          el.main.innerHTML = "";
          el.main.appendChild(el.placeholder);
          el.placeholder.innerHTML =
            "Thiếu <code>seriesId</code> trên URL. Ví dụ: " +
            "<code>?seriesId=1&amp;c=10</code> — mở qua <code>npm run catalog:view</code>. " +
            'ID là <code class="mono">catalog_series.id</code> trong trang Catalog.';
          onReaderScrollOrResize();
          return;
        }

        try {
          const j = await loadManifestFromApi();
          await applyData(j);
        } catch (e) {
          showMainError(e.message || String(e));
        }
      }

      void init();
    })();