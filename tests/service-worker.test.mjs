import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const ORIGIN = "https://pyq.example";
const SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const OFFLINE = () => new TypeError("NetworkError when attempting to fetch resource.");

/** In-memory Cache Storage with the subset of the API sw.js uses. */
function createCacheStorage() {
  const stores = new Map();
  const key = (request) =>
    new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
  const cacheFor = (entries) => ({
    async match(request) {
      return entries.get(key(request))?.clone();
    },
    async put(request, response) {
      const body = await response.arrayBuffer();
      entries.set(
        key(request),
        new Response(response.status === 304 ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      );
    },
    async keys() {
      return [...entries.keys()].map((url) => new Request(url));
    },
    async delete(request) {
      return entries.delete(key(request));
    },
  });
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return cacheFor(stores.get(name));
    },
    async keys() {
      return [...stores.keys()];
    },
    async has(name) {
      return stores.has(name);
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(request, options = {}) {
      const names = options.cacheName ? [options.cacheName] : [...stores.keys()];
      for (const name of names) {
        const hit = stores.get(name)?.get(key(request));
        if (hit) return hit.clone();
      }
      return undefined;
    },
    seed(name, path, body, init = {}) {
      if (!stores.has(name)) stores.set(name, new Map());
      stores.get(name).set(key(path), new Response(body, init));
    },
    async text(name, path) {
      const hit = stores.get(name)?.get(key(path));
      return hit ? hit.clone().text() : undefined;
    },
  };
}

function loadWorker({ caches, fetch, setTimeout: timer = setTimeout }) {
  const listeners = {};
  const calls = { skipWaiting: 0, claim: 0 };
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    skipWaiting: async () => {
      calls.skipWaiting += 1;
    },
    clients: {
      claim: async () => {
        calls.claim += 1;
      },
    },
  };
  class WorkerRequest extends Request {
    constructor(input, init) {
      super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init);
    }
  }
  const context = {
    self,
    caches,
    fetch,
    Request: WorkerRequest,
    Response,
    Headers,
    URL,
    setTimeout: timer,
    clearTimeout,
  };
  runInNewContext(
    `${SOURCE}\n;this.__sw = { VERSION, DATA_CACHE, SHELL_CACHE, CORE_SHELL_ASSETS, OPTIONAL_SHELL_ASSETS, DATA_ASSETS };`,
    context,
  );
  return { listeners, calls, constants: context.__sw };
}

async function lifecycle(listener) {
  let promise;
  listener({
    waitUntil: (value) => {
      promise = value;
    },
  });
  return promise;
}

/** Dispatch a fetch event; resolve with the response once background work finished. */
async function dispatchFetch(listeners, request) {
  let responded;
  const extensions = [];
  listeners.fetch({
    request,
    respondWith: (value) => {
      responded = value;
    },
    waitUntil: (value) => {
      extensions.push(value);
    },
  });
  const response = await responded;
  for (let settled = 0; settled < extensions.length; ) {
    const pending = extensions.slice(settled);
    settled = extensions.length;
    await Promise.allSettled(pending);
  }
  return response;
}

const get = (path, init = {}) => new Request(new URL(path, ORIGIN).href, init);
const navigation = (path = "/") => ({
  method: "GET",
  url: new URL(path, ORIGIN).href,
  mode: "navigate",
  destination: "document",
});

test("every asset sw.js precaches exists, so installs cannot fail permanently", () => {
  const { constants } = loadWorker({ caches: createCacheStorage(), fetch: async () => {} });
  const assets = [
    ...constants.CORE_SHELL_ASSETS,
    ...constants.OPTIONAL_SHELL_ASSETS,
    ...constants.DATA_ASSETS,
  ];
  assert.ok(assets.length > 30);
  for (const asset of assets) {
    const path = asset === "/" ? "/index.html" : asset;
    assert.ok(existsSync(new URL(`..${path}`, import.meta.url)), `${asset} is missing`);
  }
  const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const [, asset] of indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    assert.ok(constants.CORE_SHELL_ASSETS.includes(asset), `${asset} must be a core shell asset`);
  }
});

test("data and image caches are stable across versions; only the shell is versioned", () => {
  const { constants } = loadWorker({ caches: createCacheStorage(), fetch: async () => {} });
  assert.equal(constants.DATA_CACHE, "pyq-data-v1");
  assert.equal(constants.SHELL_CACHE, `pyq-shell-${constants.VERSION}`);
  assert.match(SOURCE, /const IMAGE_CACHE = "pyq-images-v1";/);
});

test("install fails when a core shell file fails, so the previous worker keeps serving", async () => {
  const caches = createCacheStorage();
  const { listeners, calls } = loadWorker({
    caches,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/assets/offline-ui.mjs") throw OFFLINE();
      return new Response("ok");
    },
  });
  await assert.rejects(lifecycle(listeners.install));
  assert.equal(calls.skipWaiting, 0);
});

test("install tolerates optional/data failures and keeps the previous copies", async () => {
  const caches = createCacheStorage();
  caches.seed("pyq-data-v1", "/data/manifest.json", "previous manifest");
  caches.seed("pyq-shell-2026-11-19.2", "/fonts/font-3.ttf", "previous font");
  const { listeners, calls, constants } = loadWorker({
    caches,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/data/manifest.json" || pathname === "/fonts/font-3.ttf") throw OFFLINE();
      return new Response(`fresh ${pathname}`);
    },
  });
  await lifecycle(listeners.install);
  assert.equal(calls.skipWaiting, 1);
  assert.equal(await caches.text("pyq-data-v1", "/data/manifest.json"), "previous manifest");
  assert.equal(await caches.text("pyq-data-v1", "/data/papers.json"), "fresh /data/papers.json");
  assert.equal(await caches.text(constants.SHELL_CACHE, "/fonts/font-3.ttf"), "previous font");
  assert.equal(
    await caches.text(constants.SHELL_CACHE, "/assets/index-ff8d0e4d.js"),
    "fresh /assets/index-ff8d0e4d.js",
  );
});

test("install fails without any manifest copy (fresh or previous)", async () => {
  const caches = createCacheStorage();
  const { listeners } = loadWorker({
    caches,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/data/manifest.json") throw OFFLINE();
      return new Response("ok");
    },
  });
  await assert.rejects(lifecycle(listeners.install));
});

test("activate carries legacy versioned data into the stable cache and removes old caches", async () => {
  const caches = createCacheStorage();
  caches.seed("pyq-data-2026-11-19.2", "/jee-main-papers-by-year.zip", "year zip");
  caches.seed("pyq-data-2026-11-19.2", "/data/JEE_Main/Physics/Optics.json", "[1]");
  caches.seed("pyq-data-2026-11-19.2", "/data/manifest.json", "old manifest");
  caches.seed("pyq-data-v1", "/data/manifest.json", "new manifest");
  caches.seed("pyq-shell-2026-11-19.2", "/index.html", "old shell");
  caches.seed("pyq-images-2026-11-19.2", "/x.png", "img");
  caches.seed("pyq-paper-images-v1", "https://cdn.example/a.png", "saved");
  caches.seed("someone-elses-cache", "/keep", "keep");
  const { listeners, calls } = loadWorker({ caches, fetch: async () => new Response("") });
  await lifecycle(listeners.activate);

  const names = await caches.keys();
  assert.deepEqual(names.sort(), ["pyq-data-v1", "pyq-paper-images-v1", "someone-elses-cache"]);
  assert.equal(await caches.text("pyq-data-v1", "/jee-main-papers-by-year.zip"), "year zip");
  assert.equal(await caches.text("pyq-data-v1", "/data/JEE_Main/Physics/Optics.json"), "[1]");
  assert.equal(await caches.text("pyq-data-v1", "/data/manifest.json"), "new manifest");
  assert.equal(calls.claim, 1);
});

test("an uncached request while offline gets a labelled 503, never a rejected respondWith", async () => {
  const caches = createCacheStorage();
  const { listeners } = loadWorker({ caches, fetch: async () => { throw OFFLINE(); } });
  for (const path of ["/data/JEE_Main/Physics/Optics.json", "/data.zip", "/assets/missing.mjs"]) {
    const response = await dispatchFetch(listeners, get(path));
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("X-PYQ-Offline"), "1", path);
  }
  const image = await dispatchFetch(listeners, {
    method: "GET",
    url: "https://cdn.example/missing.png",
    mode: "no-cors",
    destination: "image",
  });
  assert.equal(image.status, 503);
});

test("offline requests fall back to a copy in any cache", async () => {
  const caches = createCacheStorage();
  caches.seed("pyq-data-2026-11-19.2", "/data/JEE_Main/Physics/Optics.json", "[\"legacy\"]");
  const { listeners } = loadWorker({ caches, fetch: async () => { throw OFFLINE(); } });
  const response = await dispatchFetch(listeners, get("/data/JEE_Main/Physics/Optics.json"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "[\"legacy\"]");
});

test("JSON is served from cache and refreshed in the background", async () => {
  const caches = createCacheStorage();
  caches.seed("pyq-data-v1", "/data/papers.json", "old");
  const { listeners } = loadWorker({ caches, fetch: async () => new Response("new") });
  const response = await dispatchFetch(listeners, get("/data/papers.json"));
  assert.equal(await response.text(), "old");
  assert.equal(await caches.text("pyq-data-v1", "/data/papers.json"), "new");
});

test("a cached ZIP from an older version is served, then revalidated with a conditional request", async () => {
  const caches = createCacheStorage();
  caches.seed("pyq-data-v1", "/jee-main-papers-by-year.zip", "zip bytes", {
    headers: { ETag: '"abc"', "X-PYQ-SW-Version": "2026-11-19.2" },
  });
  const requests = [];
  const { listeners, constants } = loadWorker({
    caches,
    fetch: async (input, init = {}) => {
      requests.push({ url: String(input.url || input), etag: new Headers(init.headers).get("If-None-Match") });
      return new Response(null, { status: 304 });
    },
  });
  const response = await dispatchFetch(listeners, get("/jee-main-papers-by-year.zip"));
  assert.equal(await response.text(), "zip bytes");
  assert.deepEqual(requests, [{ url: `${ORIGIN}/jee-main-papers-by-year.zip`, etag: '"abc"' }]);
  const stored = await (await caches.open("pyq-data-v1")).match("/jee-main-papers-by-year.zip");
  assert.equal(stored.headers.get("X-PYQ-SW-Version"), constants.VERSION);
  assert.equal(await stored.text(), "zip bytes");

  // Already current: no further network traffic.
  await dispatchFetch(listeners, get("/jee-main-papers-by-year.zip"));
  assert.equal(requests.length, 1);
});

test("a fresh ZIP is cached with the worker version", async () => {
  const caches = createCacheStorage();
  const { listeners, constants } = loadWorker({ caches, fetch: async () => new Response("zip") });
  const response = await dispatchFetch(listeners, get("/data.zip"));
  assert.equal(await response.text(), "zip");
  const stored = await (await caches.open("pyq-data-v1")).match("/data.zip");
  assert.equal(stored.headers.get("X-PYQ-SW-Version"), constants.VERSION);
});

test("offline navigations get the cached shell, or a readable offline page", async () => {
  const caches = createCacheStorage();
  caches.seed("pyq-shell-x", "/index.html", "<shell>");
  let worker = loadWorker({ caches, fetch: async () => { throw OFFLINE(); } });
  let response = await dispatchFetch(worker.listeners, navigation("/?source=pwa"));
  assert.equal(await response.text(), "<shell>");

  worker = loadWorker({ caches: createCacheStorage(), fetch: async () => { throw OFFLINE(); } });
  response = await dispatchFetch(worker.listeners, navigation("/"));
  assert.equal(response.status, 503);
  assert.match(response.headers.get("Content-Type"), /text\/html/);
  assert.match(await response.text(), /offline/i);
});

test("a hanging connection falls back to the cached shell instead of waiting forever", async () => {
  const caches = createCacheStorage();
  caches.seed("pyq-shell-x", "/index.html", "<shell>");
  const { listeners } = loadWorker({
    caches,
    fetch: () => new Promise(() => {}),
    setTimeout: (callback) => Promise.resolve().then(callback),
  });
  let responded;
  listeners.fetch({
    request: navigation("/"),
    respondWith: (value) => {
      responded = value;
    },
    waitUntil: () => {},
  });
  assert.equal(await (await responded).text(), "<shell>");
});
