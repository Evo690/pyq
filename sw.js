/* eslint-disable no-restricted-globals */
/**
 * PYQ Studio service worker.
 *
 * Goals:
 *  - keep the app shell available offline, so a downloaded paper can be
 *    opened (and scored) with no network at all;
 *  - serve the year-wise ZIPs and chapter JSON from cache when offline;
 *  - cache diagrams (question/solution images, including CDN images) the
 *    app or an offline download has already fetched.
 *
 * Question data for downloaded papers is persisted in IndexedDB by
 * assets/offline-storage.mjs; this worker only handles network assets.
 */

const VERSION = "2026-11-19.1";
const SHELL_CACHE = `pyq-shell-${VERSION}`;
const DATA_CACHE = `pyq-data-${VERSION}`;
const IMAGE_CACHE = `pyq-images-${VERSION}`;
const PAPER_IMAGE_CACHE = "pyq-paper-images-v1"; // shared with offline-storage.mjs
const RUNTIME_CACHE = `pyq-runtime-${VERSION}`;

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/assets/index-ff8d0e4d.js",
  "/assets/index-570dc29c.css",
  "/assets/ui-fix.css",
  "/assets/exact-paper.mjs",
  "/assets/exact-paper-catalog.mjs",
  "/assets/experience.mjs",
  "/assets/test-analysis.mjs",
  "/assets/offline-storage.mjs",
  "/assets/offline-ui.mjs",
  "/assets/KaTeX_AMS-Regular-BQhdFMY1.woff2",
  "/assets/KaTeX_Caligraphic-Bold-Dq_IR9rO.woff2",
  "/assets/KaTeX_Caligraphic-Regular-Di6jR-x-.woff2",
  "/assets/KaTeX_Fraktur-Bold-CL6g_b3V.woff2",
  "/assets/KaTeX_Fraktur-Regular-CTYiF6lA.woff2",
  "/assets/KaTeX_Main-Bold-Cx986IdX.woff2",
  "/assets/KaTeX_Main-BoldItalic-DxDJ3AOS.woff2",
  "/assets/KaTeX_Main-Italic-NWA7e6Wa.woff2",
  "/assets/KaTeX_Main-Regular-B22Nviop.woff2",
  "/assets/KaTeX_Math-BoldItalic-CZnvNsCZ.woff2",
  "/assets/KaTeX_Math-Italic-t53AETM-.woff2",
  "/assets/KaTeX_SansSerif-Bold-D1sUS0GD.woff2",
  "/assets/KaTeX_SansSerif-Italic-C3H0VqGB.woff2",
  "/assets/KaTeX_SansSerif-Regular-DDBCnlJ7.woff2",
  "/assets/KaTeX_Script-Regular-D3wIWfF6.woff2",
  "/assets/KaTeX_Size1-Regular-mCD8mA8B.woff2",
  "/assets/KaTeX_Size2-Regular-Dy4dx90m.woff2",
  "/assets/KaTeX_Size4-Regular-Dl5lxZxV.woff2",
  "/assets/KaTeX_Typewriter-Regular-CO6r4hn1.woff2",
  "/fonts/font-0.ttf",
  "/fonts/font-1.ttf",
  "/fonts/font-2.ttf",
  "/fonts/font-3.ttf",
  "/fonts/font-4.ttf",
  "/fonts/font-5.ttf",
  "/fonts/font-6.ttf",
  "/fonts/font-7.ttf",
  "/fonts/font-8.ttf",
];

const DATA_ASSETS = [
  "/data/manifest.json",
  "/data/exact-papers.json",
  "/data/papers.json",
];

const MAX_IMAGE_ENTRIES = 2500;
const IMAGE_PRUNE_COUNT = 250;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const [shellCache, dataCache] = await Promise.all([
        caches.open(SHELL_CACHE),
        caches.open(DATA_CACHE),
      ]);
      await Promise.all([
        ...SHELL_ASSETS.map((url) =>
          shellCache.add(new Request(url, { cache: "reload" })).catch(() => {
            /* A missing optional asset must not fail the install. */
          }),
        ),
        ...DATA_ASSETS.map((url) =>
          dataCache.add(new Request(url, { cache: "reload" })).catch(() => {
            /* A missing optional data index must not fail the install. */
          }),
        ),
      ]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, DATA_CACHE, IMAGE_CACHE, RUNTIME_CACHE, PAPER_IMAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => (keep.has(name) ? undefined : caches.delete(name))),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isCacheable(response) {
  return Boolean(
    response && (response.ok || response.type === "opaque" || response.status === 0),
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  const network = fetch(request)
    .then((response) => {
      if (isCacheable(response)) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  const response = await network;
  if (response) return response;
  throw new Error("offline");
}

async function pruneImageCache() {
  const cache = await caches.open(IMAGE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_IMAGE_ENTRIES) return;
  const excess = keys.slice(0, keys.length - (MAX_IMAGE_ENTRIES - IMAGE_PRUNE_COUNT));
  await Promise.all(excess.map((key) => cache.delete(key).catch(() => false)));
}

async function handleImage(request) {
  if (request.mode === "no-cors") {
    const saved = await caches.match(request, { cacheName: PAPER_IMAGE_CACHE, ignoreVary: true });
    if (saved) return saved;
  }
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      cache
        .put(request, response.clone())
        .then(pruneImageCache)
        .catch(() => {});
    }
    return response;
  } catch (error) {
    const fallback = await cache.match(request, { ignoreVary: true });
    if (fallback) return fallback;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.pathname.endsWith("/sw.js")) return;

  // App shell: navigations get the cached document when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, RUNTIME_CACHE, "/index.html").catch(
        async () => (await caches.match("/index.html")) || Response.error(),
      ),
    );
    return;
  }

  if (request.destination === "image") {
    event.respondWith(handleImage(request));
    return;
  }

  if (url.origin === self.location.origin) {
    // Year-wise ZIPs and chapter-bank archives: large, immutable per build.
    if (url.pathname.endsWith(".zip")) {
      event.respondWith(cacheFirst(request, DATA_CACHE));
      return;
    }
    if (url.pathname.endsWith(".json")) {
      event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
      return;
    }
    if (
      request.destination === "script" ||
      request.destination === "style" ||
      request.destination === "font" ||
      /\.(?:js|mjs|css|woff2?|ttf|svg)$/.test(url.pathname)
    ) {
      event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
      return;
    }
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
  }
});
