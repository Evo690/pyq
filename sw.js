/*
 * Offline shell for PYQ Studio.
 * The app itself, KaTeX and its fonts are precached so the workspace opens with
 * no connection at all. Question files are cached as they are fetched, and
 * diagram images are cached cross-origin as opaque responses so a downloaded
 * paper keeps its figures offline too.
 */

const VERSION = "pyq-studio-v4";
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const IMAGE_CACHE = `${VERSION}-images`;

const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/app/styles.css",
  "/app/app.js",
  "/app/core.js",
  "/app/data.js",
  "/app/dom.js",
  "/app/session.js",
  "/app/store.js",
  "/app/views/analysis.js",
  "/app/views/home.js",
  "/app/views/library.js",
  "/app/views/papers.js",
  "/app/views/practice.js",
  "/app/views/session.js",
  "/app/views/shared.js",
  "/vendor/katex/katex.min.js",
  "/vendor/katex/katex.min.css",
  "/data/index.json",
  "/data/papers.json",
];

const FONT_FILES = [
  "KaTeX_AMS-Regular",
  "KaTeX_Caligraphic-Bold",
  "KaTeX_Caligraphic-Regular",
  "KaTeX_Fraktur-Bold",
  "KaTeX_Fraktur-Regular",
  "KaTeX_Main-Bold",
  "KaTeX_Main-BoldItalic",
  "KaTeX_Main-Italic",
  "KaTeX_Main-Regular",
  "KaTeX_Math-BoldItalic",
  "KaTeX_Math-Italic",
  "KaTeX_SansSerif-Bold",
  "KaTeX_SansSerif-Italic",
  "KaTeX_SansSerif-Regular",
  "KaTeX_Script-Regular",
  "KaTeX_Size1-Regular",
  "KaTeX_Size2-Regular",
  "KaTeX_Size3-Regular",
  "KaTeX_Size4-Regular",
  "KaTeX_Typewriter-Regular",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const urls = [...SHELL, ...FONT_FILES.map((font) => `/vendor/katex/fonts/${font}.woff2`)];
      await Promise.allSettled(
        urls.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "reload" });
            if (response.ok) await cache.put(url, response.clone());
          } catch {
            /* a missing optional file should not block installation */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isCacheable(response) {
  return response && (response.ok || response.type === "opaque");
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (!sameOrigin) {
    // Diagrams and any third-party asset: keep whatever was fetched before.
    if (request.destination === "image" || request.mode === "no-cors") {
      event.respondWith(cacheFirst(request, IMAGE_CACHE));
    }
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match(request)) ||
            (await cache.match("/index.html")) ||
            (await cache.match("/")) ||
            new Response("Offline", { status: 503 })
          );
        }
      })(),
    );
    return;
  }

  const isShellFile =
    SHELL.includes(url.pathname) || url.pathname.startsWith("/vendor/katex/fonts/");

  event.respondWith(
    isShellFile ? cacheFirst(request, SHELL_CACHE) : networkFirst(request),
  );
});
