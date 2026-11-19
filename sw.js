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
 *
 * Cache layout:
 *  - pyq-shell-<VERSION>, pyq-runtime-<VERSION>: tied to one build and
 *    replaced on update. The core shell is precached all-or-nothing, so an
 *    interrupted update keeps the previous working version instead of
 *    activating a half-filled cache.
 *  - pyq-data-v1, pyq-images-v1, pyq-paper-images-v1: stable across updates.
 *    A new VERSION must never wipe data a learner relies on offline; JSON is
 *    revalidated on use and ZIPs once per VERSION (conditional request).
 *
 * When something is neither reachable nor cached, the worker answers with a
 * 503 marked `X-PYQ-Offline: 1` instead of rejecting respondWith(), so the
 * app can explain what is missing rather than surfacing a bare
 * "NetworkError when attempting to fetch resource."
 */

const VERSION = "2026-11-19.3";
const SHELL_CACHE = `pyq-shell-${VERSION}`;
const RUNTIME_CACHE = `pyq-runtime-${VERSION}`;
const DATA_CACHE = "pyq-data-v1";
const IMAGE_CACHE = "pyq-images-v1";
const PAPER_IMAGE_CACHE = "pyq-paper-images-v1"; // shared with offline-storage.mjs
const CACHE_PREFIX = "pyq-";
const LEGACY_DATA_PREFIX = "pyq-data-";
const VERSION_HEADER = "X-PYQ-SW-Version";
const OFFLINE_HEADER = "X-PYQ-Offline";
const NAVIGATION_TIMEOUT_MS = 4000;

/** Everything the app needs to boot. Precached atomically (install fails otherwise). */
const CORE_SHELL_ASSETS = [
  "/index.html",
  "/assets/index-ff8d0e4d.js",
  "/assets/index-570dc29c.css",
  "/assets/ui-fix.css",
  "/assets/exact-paper.mjs",
  "/assets/exact-paper-catalog.mjs",
  "/assets/experience.mjs",
  "/assets/test-analysis.mjs",
  "/assets/offline-storage.mjs",
  "/assets/offline-ui.mjs",
];

/** Nice to have offline; a previous copy is kept when a refresh fails. */
const OPTIONAL_SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
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

const SHELL_ASSETS = [...CORE_SHELL_ASSETS, ...OPTIONAL_SHELL_ASSETS];

/** Boot indexes. The manifest is required (a fresh or previously cached copy). */
const DATA_ASSETS = [
  "/data/manifest.json",
  "/data/exact-papers.json",
  "/data/papers.json",
];
const REQUIRED_DATA_ASSETS = new Set(["/data/manifest.json"]);

const MAX_IMAGE_ENTRIES = 2500;
const IMAGE_PRUNE_COUNT = 250;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Keep the worker alive for background cache work (no-op outside a live event). */
function background(event, promise) {
  const settled = Promise.resolve(promise).catch(() => {});
  try {
    if (event && typeof event.waitUntil === "function") event.waitUntil(settled);
  } catch {
    // The event already finished; the work still runs best-effort.
  }
  return settled;
}

function isCacheable(response) {
  return Boolean(
    response && (response.ok || response.type === "opaque" || response.status === 0),
  );
}

/**
 * Browsers reject a redirected response for a navigation. Hosts with
 * "pretty URLs" (Cloudflare Pages redirects /index.html to /) would make
 * the cached shell unusable offline, so keep and serve a clean copy.
 */
function cleanResponse(response) {
  if (!response || !response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Copy a response, stamping the worker VERSION that stored it. */
function stampVersion(response) {
  const headers = new Headers(response.headers);
  headers.set(VERSION_HEADER, VERSION);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function offlineResponse(request) {
  const url = request && request.url ? request.url : "";
  return new Response(
    JSON.stringify({
      error: "offline",
      message: "You are offline and this file is not saved on this device yet.",
      url,
    }),
    {
      status: 503,
      statusText: "Offline",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        [OFFLINE_HEADER]: "1",
      },
    },
  );
}

function offlineDocument() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PYQ Studio · Offline</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:34rem;margin:14vh auto;padding:0 1.5rem;line-height:1.55;color:#1f2933"><h1 style="font-size:1.4rem">You're offline</h1><p>PYQ Studio hasn't finished saving itself on this device yet, so it can't open without internet. Connect once and open the app again — after that, papers you download keep working offline.</p><button type="button" onclick="location.reload()" style="font:inherit;padding:.6rem 1.25rem;border-radius:999px;border:1px solid #1f2933;background:#fff;cursor:pointer">Try again</button></body></html>`;
  return new Response(html, {
    status: 503,
    statusText: "Offline",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      [OFFLINE_HEADER]: "1",
    },
  });
}

/**
 * Last resort when the network failed: any copy in any of our caches
 * (an earlier build's shell, the stable data cache, a downloaded paper's
 * images). Opaque copies are only usable for no-cors requests.
 */
async function matchAnyCache(request) {
  try {
    const match = await caches.match(request, { ignoreVary: true });
    if (!match) return null;
    if (match.type === "opaque" && request.mode && request.mode !== "no-cors") return null;
    return match;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Install / activate                                                          */
/* -------------------------------------------------------------------------- */

async function precache(cache, url, { required = false, keepPrevious = true } = {}) {
  try {
    const response = await fetch(new Request(url, { cache: "reload" }));
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    await cache.put(url, cleanResponse(response));
  } catch (error) {
    if (keepPrevious) {
      const existing = await cache.match(url, { ignoreVary: true });
      if (existing) return;
      const previous = await caches.match(url, { ignoreVary: true });
      if (previous) {
        await cache.put(url, cleanResponse(previous));
        return;
      }
    }
    if (required) throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const [shellCache, dataCache] = await Promise.all([
        caches.open(SHELL_CACHE),
        caches.open(DATA_CACHE),
      ]);
      // Core shell files must all come from this build: mixing an older
      // module with a newer bundle could break the app. If any is missing,
      // the install fails and the previous worker keeps serving offline.
      await Promise.all(
        CORE_SHELL_ASSETS.map((url) =>
          precache(shellCache, url, { required: true, keepPrevious: false }),
        ),
      );
      await Promise.all([
        ...OPTIONAL_SHELL_ASSETS.map((url) => precache(shellCache, url)),
        ...DATA_ASSETS.map((url) =>
          precache(dataCache, url, { required: REQUIRED_DATA_ASSETS.has(url) }),
        ),
      ]);
      await self.skipWaiting();
    })(),
  );
});

/**
 * Earlier builds kept ZIPs and chapter JSON in pyq-data-<VERSION>, which
 * every update deleted. Carry those entries into the stable data cache once
 * so learners keep what they already had offline.
 */
async function migrateLegacyDataCaches(names) {
  const legacy = names
    .filter((name) => name.startsWith(LEGACY_DATA_PREFIX) && name !== DATA_CACHE)
    .reverse(); // newest first
  if (!legacy.length) return;
  const target = await caches.open(DATA_CACHE);
  for (const name of legacy) {
    try {
      const source = await caches.open(name);
      for (const request of await source.keys()) {
        if (await target.match(request, { ignoreVary: true })) continue;
        const response = await source.match(request, { ignoreVary: true });
        if (response) await target.put(request, response).catch(() => {});
      }
    } catch {
      // A damaged legacy cache must not block activation.
    }
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      try {
        await migrateLegacyDataCaches(names);
      } catch {
        // Migration is best-effort.
      }
      const keep = new Set([
        SHELL_CACHE,
        RUNTIME_CACHE,
        DATA_CACHE,
        IMAGE_CACHE,
        PAPER_IMAGE_CACHE,
      ]);
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
          .map((name) => caches.delete(name).catch(() => false)),
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

/* -------------------------------------------------------------------------- */
/* Strategies                                                                  */
/* -------------------------------------------------------------------------- */

const revalidating = new Map();

/** Refresh a cached ZIP once per VERSION; a 304 just re-stamps the copy. */
function revalidateArchive(request, cache, cachedHeaders) {
  const key = request.url;
  if (revalidating.has(key)) return revalidating.get(key);
  const task = (async () => {
    const headers = new Headers();
    const etag = cachedHeaders.get("ETag");
    const lastModified = cachedHeaders.get("Last-Modified");
    if (etag) headers.set("If-None-Match", etag);
    if (lastModified) headers.set("If-Modified-Since", lastModified);
    let response;
    try {
      response = await fetch(request.url, {
        headers,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch {
      return; // Offline: keep serving the cached copy.
    }
    if (response.status === 304) {
      const current = await cache.match(request, { ignoreVary: true });
      if (current) await cache.put(request, stampVersion(current));
    } else if (response.ok) {
      await cache.put(request, stampVersion(response));
    }
  })()
    .catch(() => {})
    .finally(() => revalidating.delete(key));
  revalidating.set(key, task);
  return task;
}

/** Year-wise and chapter ZIPs: cache-first, kept across updates. */
async function handleArchive(event) {
  const { request } = event;
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) {
    if (cached.headers.get(VERSION_HEADER) !== VERSION) {
      background(event, revalidateArchive(request, cache, cached.headers));
    }
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) {
      background(event, cache.put(request, stampVersion(response.clone())));
    }
    return response;
  } catch {
    return (await matchAnyCache(request)) || offlineResponse(request);
  }
}

/** Stale-while-revalidate with an offline answer instead of a rejection. */
async function staleWhileRevalidate(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  const network = fetch(request).then((response) => {
    if (isCacheable(response)) {
      background(event, cache.put(request, response.clone()));
    }
    return response;
  });
  if (cached) {
    background(event, network);
    return cached;
  }
  try {
    return await network;
  } catch {
    return (await matchAnyCache(request)) || offlineResponse(request);
  }
}

/**
 * Navigations: network-first, but a slow or dead connection falls back to
 * the cached shell after NAVIGATION_TIMEOUT_MS rather than hanging.
 */
async function handleNavigation(event) {
  const { request } = event;
  const runtime = await caches.open(RUNTIME_CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === "basic" && !response.redirected) {
      background(event, runtime.put(request, response.clone()));
    }
    return response;
  });
  background(event, network);
  let timer;
  const outcome = await Promise.race([
    network.then(
      (response) => ({ response }),
      () => ({ failed: true }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), NAVIGATION_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (outcome.response) return outcome.response;

  // Prefer this worker's own shell: a failed update can leave a partial
  // cache from a newer build behind.
  const shell =
    (await runtime.match(request, { ignoreVary: true })) ||
    (await caches.match("/index.html", { cacheName: SHELL_CACHE, ignoreVary: true })) ||
    (await caches.match("/index.html", { ignoreVary: true })) ||
    (await caches.match("/", { ignoreVary: true }));
  if (shell) return cleanResponse(shell);
  try {
    return await network;
  } catch {
    return offlineDocument();
  }
}

async function pruneImageCache() {
  const cache = await caches.open(IMAGE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_IMAGE_ENTRIES) return;
  const excess = keys.slice(0, keys.length - (MAX_IMAGE_ENTRIES - IMAGE_PRUNE_COUNT));
  await Promise.all(excess.map((key) => cache.delete(key).catch(() => false)));
}

async function handleImage(event) {
  const { request } = event;
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
      background(
        event,
        cache.put(request, response.clone()).then(pruneImageCache),
      );
    }
    return response;
  } catch {
    // The <img> shows the app's "diagram unavailable" note instead.
    return (await matchAnyCache(request)) || offlineResponse(request);
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
      handleNavigation(event).catch(
        async () => cleanResponse(await caches.match("/index.html")) || offlineDocument(),
      ),
    );
    return;
  }

  if (request.destination === "image") {
    event.respondWith(handleImage(event).catch(() => offlineResponse(request)));
    return;
  }

  if (url.origin === self.location.origin) {
    // Year-wise ZIPs and chapter-bank archives: large, rarely changing.
    if (url.pathname.endsWith(".zip")) {
      event.respondWith(handleArchive(event).catch(() => offlineResponse(request)));
      return;
    }
    if (url.pathname.endsWith(".json")) {
      event.respondWith(
        staleWhileRevalidate(event, DATA_CACHE).catch(() => offlineResponse(request)),
      );
      return;
    }
    if (
      request.destination === "script" ||
      request.destination === "style" ||
      request.destination === "font" ||
      /\.(?:js|mjs|css|woff2?|ttf|svg)$/.test(url.pathname)
    ) {
      event.respondWith(
        staleWhileRevalidate(event, SHELL_CACHE).catch(() => offlineResponse(request)),
      );
      return;
    }
    event.respondWith(
      staleWhileRevalidate(event, RUNTIME_CACHE).catch(() => offlineResponse(request)),
    );
  }
});
