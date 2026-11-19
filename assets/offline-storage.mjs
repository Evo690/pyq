/**
 * Reliable local storage + offline exact-paper cache.
 *
 * Two concerns live here so the bundled app can stay thin:
 *
 * 1. Workspace store (progress, tests, bookmarks, …) in localStorage with
 *    checksums, a backup copy, debounced writes and flush-on-exit. The old
 *    code wrote the whole store synchronously on every state change and
 *    lost data silently when the quota was hit or the JSON was corrupted.
 *
 * 2. Offline exact-paper cache in IndexedDB. A downloaded paper stores its
 *    normalized questions (with the original remote image URLs), the
 *    MathJax SVG defs, and readable images as Blobs. Opaque CDN responses
 *    stay in Cache Storage for the service worker. Loading a paper
 *    hydrates cached images to blob: URLs, so the paper works with no
 *    network and still scores through the existing analyzeTest logic.
 *
 * All browser-only globals (localStorage, indexedDB, fetch, Blob URLs) are
 * injectable via `deps` so the pure helpers stay unit-testable in Node.
 */

export const STORE_KEY = "pyq-studio-v1";
export const STORE_BACKUP_KEY = "pyq-studio-v1:backup";
export const STORE_META_KEY = "pyq-studio-v1:meta";
export const STORE_SCHEMA_VERSION = 2;

export const OFFLINE_DB_NAME = "pyq-offline";
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_CACHE_VERSION = 1;
// Also used by sw.js. Unlike the runtime image cache, saved diagrams must
// survive shell upgrades and must not be pruned while a paper references them.
const PAPER_IMAGE_CACHE = "pyq-paper-images-v1";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Workspace store: checksummed, backed-up, debounced                          */
/* -------------------------------------------------------------------------- */

let memoryStorage = null;

function defaultStorage() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Accessing localStorage can throw (private mode, disabled storage).
  }
  if (!memoryStorage) {
    const backing = new Map();
    memoryStorage = {
      getItem: (key) => (backing.has(key) ? backing.get(key) : null),
      setItem: (key, value) => backing.set(key, String(value)),
      removeItem: (key) => backing.delete(key),
    };
  }
  return memoryStorage;
}

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** FNV-1a 32-bit checksum, hex-encoded. Detects truncation/corruption. */
export function checksumString(value) {
  const str = String(value ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < str.length; index += 1) {
    hash ^= str.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Serialize a store with version, timestamp and checksum. */
export function serializeStore(store, savedAt = new Date().toISOString()) {
  const data = JSON.stringify(store || {});
  return JSON.stringify({
    version: STORE_SCHEMA_VERSION,
    savedAt,
    checksum: checksumString(data),
    data,
  });
}

/**
 * Parse a stored payload. Returns { store, meta } or null when unusable.
 * Legacy v1 payloads (the raw store object, no wrapper) are accepted so
 * existing browsers migrate transparently on the next save.
 */
export function deserializeStore(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const isWrapped =
    "version" in parsed && "data" in parsed && "checksum" in parsed;
  if (!isWrapped) {
    return {
      store: parsed,
      meta: { version: 1, savedAt: null, checksum: null, legacy: true },
    };
  }
  if (typeof parsed.data !== "string") return null;
  if (checksumString(parsed.data) !== parsed.checksum) return null;
  try {
    return {
      store: JSON.parse(parsed.data),
      meta: {
        version: parsed.version,
        savedAt: parsed.savedAt || null,
        checksum: parsed.checksum,
        legacy: false,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Load the workspace store, falling back to the backup copy when the
 * primary is missing or corrupted. Never throws.
 */
export function loadWorkspaceStore(defaults = {}, storage) {
  const store = storage || defaultStorage();
  const primary = deserializeStore(safeGet(store, STORE_KEY));
  if (primary) {
    return {
      store: { ...defaults, ...primary.store },
      source: primary.meta.legacy ? "legacy" : "primary",
      meta: primary.meta,
      recovered: false,
    };
  }
  const backup = deserializeStore(safeGet(store, STORE_BACKUP_KEY));
  if (backup) {
    return {
      store: { ...defaults, ...backup.store },
      source: "backup",
      meta: backup.meta,
      recovered: true,
    };
  }
  return { store: { ...defaults }, source: "default", meta: null, recovered: false };
}

/**
 * Persist the store. The previous primary is copied to the backup key
 * first (best-effort), so a failed or corrupted write never destroys the
 * last good state. Throws a clear quota error when localStorage is full.
 */
export function saveWorkspaceStore(store, storage) {
  const target = storage || defaultStorage();
  const payload = serializeStore(store);
  try {
    const previous = target.getItem(STORE_KEY);
    // Only rotate a *valid* payload into the backup: after a recovery the
    // primary may hold the corrupted copy, which must never replace the
    // last good state.
    if (previous && deserializeStore(previous)) {
      target.setItem(STORE_BACKUP_KEY, previous);
    }
  } catch {
    // Backup is best-effort; the primary write below is what matters.
  }
  try {
    target.setItem(STORE_KEY, payload);
  } catch (cause) {
    const error = new Error(
      "Storage is full. Export your progress from settings to keep a backup.",
    );
    error.name = "QuotaExceededError";
    error.cause = cause;
    throw error;
  }
  try {
    target.setItem(
      STORE_META_KEY,
      JSON.stringify({
        version: STORE_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        bytes: payload.length,
      }),
    );
  } catch {
    // Meta is informational only.
  }
  return { ok: true, bytes: payload.length };
}

/**
 * Debounced saver: coalesces rapid state changes (every answer click,
 * every timer tick) into one write, and flushes on pagehide/beforeunload
 * via the shared `workspaceSaver` so the last change is never lost.
 */
export function createDebouncedSaver(options = {}) {
  const delay = options.delay ?? 300;
  const saveFn =
    options.save || ((store) => saveWorkspaceStore(store, options.storage));
  const onError =
    options.onError ||
    ((error) => {
      try {
        globalThis.dispatchEvent?.(
          new CustomEvent("pyq:storage-error", { detail: error }),
        );
      } catch {
        // Non-browser environment: nothing to notify.
      }
    });
  let timer = null;
  let pending = null;
  let lastError = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === null) return { ok: true, skipped: true };
    const store = pending;
    pending = null;
    try {
      const result = saveFn(store);
      lastError = null;
      return result;
    } catch (error) {
      lastError = error;
      try {
        onError(error);
      } catch {
        // Notification failures must not break saving.
      }
      return { ok: false, error };
    }
  }

  function schedule(store) {
    pending = store;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
  }

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  }

  return {
    schedule,
    flush,
    cancel,
    getLastError: () => lastError,
    get hasPending() {
      return pending !== null;
    },
  };
}

/** Shared saver used by the bundled app. */
export const workspaceSaver = createDebouncedSaver({ delay: 300 });

export async function estimateStorage() {
  try {
    const storage = globalThis.navigator?.storage;
    if (storage?.estimate) {
      const estimate = await storage.estimate();
      return {
        usage: Number(estimate.usage) || 0,
        quota: Number(estimate.quota) || 0,
        persistent: Boolean(estimate.persistent),
      };
    }
  } catch {
    // Storage estimation is best-effort.
  }
  return { usage: 0, quota: 0, persistent: false };
}

export async function requestPersistentStorage() {
  try {
    const storage = globalThis.navigator?.storage;
    if (storage?.persist) return Boolean(await storage.persist());
  } catch {
    // Persistence requests can be denied; callers should surface that.
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Image URL extraction + HTML rewriting (pure)                                */
/* -------------------------------------------------------------------------- */

export function parseSrcset(srcset) {
  if (!srcset) return [];
  return String(srcset)
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function isRemoteImageUrl(url) {
  const value = String(url || "").trim();
  return Boolean(
    value &&
      !value.startsWith("data:") &&
      !value.startsWith("blob:") &&
      !value.startsWith("#"),
  );
}

// Archive fragments are also rewritten in Node when no DOM is available.
const IMAGE_TAG = /<(?:img|source)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTRIBUTE = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** All image URLs referenced by <img>/<source> tags in an HTML fragment. */
export function extractImageUrlsFromHtml(html) {
  if (!html || typeof html !== "string") return [];
  const urls = new Set();
  const add = (url) => {
    if (isRemoteImageUrl(url)) urls.add(String(url).trim());
  };
  for (const [tag] of html.matchAll(IMAGE_TAG)) {
    for (const [, name, dq, sq, bare] of tag.matchAll(ATTRIBUTE)) {
      const key = name.toLowerCase();
      const value = dq ?? sq ?? bare;
      if (key === "src" || key === "data-orsrc") add(value);
      if (key === "srcset") parseSrcset(value).forEach(add);
    }
  }
  return [...urls];
}

/** Every embedded image URL in a normalized question list. */
export function extractPaperImageUrls(questions) {
  const urls = new Set();
  for (const question of questions || []) {
    for (const url of extractImageUrlsFromHtml(question?.question_text)) {
      urls.add(url);
    }
    for (const url of extractImageUrlsFromHtml(question?.solution_text)) {
      urls.add(url);
    }
    for (const option of question?.options || []) {
      for (const url of extractImageUrlsFromHtml(option?.text)) urls.add(url);
      for (const url of extractImageUrlsFromHtml(option?.html)) urls.add(url);
      if (isRemoteImageUrl(option?.image)) urls.add(String(option.image));
    }
    if (isRemoteImageUrl(question?.question_image)) {
      urls.add(String(question.question_image));
    }
    if (isRemoteImageUrl(question?.solution_image)) {
      urls.add(String(question.solution_image));
    }
  }
  return [...urls];
}

function toUrlMap(urlMap) {
  if (urlMap instanceof Map) return urlMap;
  return new Map(Object.entries(urlMap || {}));
}

function rewriteSrcsetValue(value, map) {
  return String(value)
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const tokens = trimmed.split(/\s+/);
      if (map.has(tokens[0])) tokens[0] = map.get(tokens[0]);
      return tokens.join(" ");
    })
    .join(", ");
}

// The renderer deliberately removes srcset. Give each picture one ordinary
// img src before rewriting, preserving alt, dimensions and other img metadata.
function flattenPicture(_, body) {
  const tags = body.match(IMAGE_TAG) || [];
  const img = tags.find((tag) => /^<img\b/i.test(tag)) || "<img>";
  let src, original, candidate;
  let attrs = "";
  for (const tag of [img, ...tags.filter((tag) => /^<source\b/i.test(tag))]) {
    for (const [raw, name, dq, sq, bare] of tag.matchAll(ATTRIBUTE)) {
      const key = name.toLowerCase();
      const value = (dq ?? sq ?? bare ?? "").trim();
      if (key === "src") src ||= value;
      if (key === "data-orsrc") original ||= value;
      if (key === "srcset") candidate ||= parseSrcset(value)[0];
      if (tag === img && key !== "src" && key !== "srcset") attrs += raw;
    }
  }
  const url = src || original || candidate;
  return url ? `<img${attrs} src="${url.replace(/"/g, "&quot;")}">` : img;
}

/**
 * Replace cached image URLs in <img>/<source> tags with blob:/data: URLs.
 * MathJax SVG (<use href="#…">) and all other markup are left untouched.
 */
export function rewriteHtmlImages(html, urlMap) {
  if (!html || typeof html !== "string") return html || "";
  const map = toUrlMap(urlMap);
  const flattened = html.replace(/<picture\b[^>]*>([\s\S]*?)<\/picture\s*>/gi, flattenPicture);
  if (!map.size) return flattened;
  return flattened.replace(IMAGE_TAG, (tag) => tag.replace(ATTRIBUTE, (raw, name, dq, sq, bare) => {
    const key = name.toLowerCase();
    const url = dq ?? sq ?? bare;
    let value;
    if (key === "src" || key === "data-orsrc") value = map.get(url);
    if (key === "srcset" && url) value = rewriteSrcsetValue(url, map);
    if (value == null) return raw;
    return ` ${name}="${value.replace(/"/g, "&quot;")}"`;
  }));
}

/** Return a copy of a question with all cached images rewritten. */
export function rewriteQuestionImages(question, urlMap) {
  if (!question) return question;
  const map = toUrlMap(urlMap);
  const next = { ...question };
  if (typeof next.question_text === "string") {
    next.question_text = rewriteHtmlImages(next.question_text, map);
  }
  if (typeof next.solution_text === "string") {
    next.solution_text = rewriteHtmlImages(next.solution_text, map);
  }
  if (Array.isArray(next.options)) {
    next.options = next.options.map((option) => {
      const copy = { ...option };
      if (typeof copy.text === "string") {
        copy.text = rewriteHtmlImages(copy.text, map);
      }
      if (typeof copy.html === "string") {
        copy.html = rewriteHtmlImages(copy.html, map);
      }
      if (copy.image && map.has(copy.image)) copy.image = map.get(copy.image);
      return copy;
    });
  }
  if (next.question_image && map.has(next.question_image)) {
    next.question_image = map.get(next.question_image);
  }
  if (next.solution_image && map.has(next.solution_image)) {
    next.solution_image = map.get(next.solution_image);
  }
  return next;
}

/** Stable IndexedDB key for a paper source descriptor. */
export function paperCacheKey(paperSource) {
  const source = paperSource || {};
  const archiveFile = String(source.archiveFile || "");
  const slug = String(source.slug || source.id || "");
  if (archiveFile && slug) return `${archiveFile}::${slug}`;
  if (slug) return `paper::${slug}`;
  const title = String(source.title || "").trim();
  if (title) return `title::${title}`;
  return "paper::unknown";
}

/** Filesystem-safe slug for downloaded paper files. */
export function paperFileSlug(title) {
  const slug = String(title || "paper")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "paper";
}

/**
 * Strip scripts/frames/event handlers for standalone paper files, which
 * are opened outside the app's sanitizer. Image sizing styles are kept.
 */
export function stripUnsafeHtml(html) {
  if (!html) return "";
  let out = String(html);
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "");
  out = out.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, "");
  out = out.replace(/<embed\b[^>]*\/?>/gi, "");
  out = out.replace(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi, "");
  out = out.replace(/<link\b[^>]*\/?>/gi, "");
  out = out.replace(/<meta\b[^>]*\/?>/gi, "");
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(
    /(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi,
    '$1="#"',
  );
  return out;
}

/* -------------------------------------------------------------------------- */
/* IndexedDB paper + image cache                                               */
/* -------------------------------------------------------------------------- */

export function isOfflineCacheAvailable(deps = {}) {
  try {
    return Boolean(deps.indexedDB || globalThis.indexedDB);
  } catch {
    return false;
  }
}

let offlineDbPromise = null;

export function openOfflineDb(indexedDBImpl) {
  const idb = indexedDBImpl || globalThis.indexedDB;
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = idb.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("papers")) {
        db.createObjectStore("papers", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "url" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open the offline cache."));
    request.onblocked = () =>
      reject(new Error("The offline cache is blocked by another tab."));
  });
}

/** Forget the memoized connection (after a DB delete, or between tests). */
export function resetOfflineDb() {
  offlineDbPromise = null;
  revokeAllImageObjectUrls();
}

export function getOfflineDb(deps = {}) {
  if (deps.db) return Promise.resolve(deps.db);
  if (!offlineDbPromise) {
    offlineDbPromise = openOfflineDb(deps.indexedDB).catch((error) => {
      offlineDbPromise = null;
      throw error;
    });
  }
  return offlineDbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed."));
    request.onblocked = () =>
      reject(new Error("IndexedDB request was blocked."));
  });
}

async function withStore(db, storeName, mode, run) {
  const transaction = db.transaction(storeName, mode);
  // Attach completion handlers before touching the store: a fast request
  // can resolve in a microtask, and the transaction must still be awaited.
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted."));
  });
  const store = transaction.objectStore(storeName);
  const result = await run(store);
  await done;
  return result;
}

function isQuotaError(error) {
  return (
    error?.name === "QuotaExceededError" ||
    error?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    /quota/i.test(String(error?.message || ""))
  );
}

export function summarizePaperRecord(record) {
  if (!record) return null;
  const failedImages = Array.isArray(record.failedImages)
    ? record.failedImages
    : [];
  return {
    key: record.key,
    title: record.title || "",
    exam: record.exam || "",
    year: record.year || "",
    questionCount: Number(record.questionCount) || 0,
    imageCount: Number(record.imageCount) || 0,
    imageBytes: Number(record.imageBytes) || 0,
    failedImages,
    downloadedAt: record.downloadedAt || null,
    complete: failedImages.length === 0,
  };
}

export async function getCachedPaper(paperSource, deps = {}) {
  if (!paperSource) return null;
  let db;
  try {
    db = await getOfflineDb(deps);
  } catch {
    return null;
  }
  if (!db) return null;
  const key = paperCacheKey(paperSource);
  try {
    const record = await withStore(db, "papers", "readonly", (store) =>
      idbRequest(store.get(key)),
    );
    if (!record || record.version !== OFFLINE_CACHE_VERSION) return null;
    return record;
  } catch {
    return null;
  }
}

export async function hasCachedPaper(paperSource, deps = {}) {
  return Boolean(await getCachedPaper(paperSource, deps));
}

export async function listCachedPapers(deps = {}) {
  let db;
  try {
    db = await getOfflineDb(deps);
  } catch {
    return [];
  }
  if (!db) return [];
  try {
    const records = await withStore(db, "papers", "readonly", (store) =>
      idbRequest(store.getAll()),
    );
    return (records || [])
      .map(summarizePaperRecord)
      .filter(Boolean)
      .sort((a, b) =>
        String(b.downloadedAt || "").localeCompare(
          String(a.downloadedAt || ""),
        ),
      );
  } catch {
    return [];
  }
}

export async function getCachedImageBlob(url, deps = {}) {
  let db;
  try {
    db = await getOfflineDb(deps);
  } catch {
    return null;
  }
  if (!db) return null;
  try {
    const record = await withStore(db, "images", "readonly", (store) =>
      idbRequest(store.get(url)),
    );
    return record?.blob || null;
  } catch {
    return null;
  }
}

export async function putCachedImage(url, blob, deps = {}) {
  const db = await getOfflineDb(deps);
  if (!db) throw new Error("The offline cache is not available.");
  await withStore(db, "images", "readwrite", (store) =>
    idbRequest(
      store.put({
        url,
        blob,
        contentType: blob?.type || "",
        bytes: blob?.size || 0,
        fetchedAt: new Date().toISOString(),
      }),
    ),
  );
}

export async function savePaperOffline({
  paperSource,
  paper,
  exam,
  questions,
  mathjaxDefs,
  imageUrls,
  failedImages,
  imageBytes,
  downloadedAt,
  deps = {},
}) {
  const db = await getOfflineDb(deps);
  if (!db) throw new Error("The offline cache is not available.");
  const source = paperSource || paper || {};
  const record = {
    key: paperCacheKey(source),
    version: OFFLINE_CACHE_VERSION,
    paperSource: source,
    title: String(source.title || paper?.title || ""),
    exam: String(exam || source.exam || ""),
    year: String(source.year || ""),
    questionCount: Array.isArray(questions) ? questions.length : 0,
    imageCount: Array.isArray(imageUrls) ? imageUrls.length : 0,
    imageBytes: Number(imageBytes) || 0,
    failedImages: Array.isArray(failedImages) ? failedImages : [],
    mathjaxDefs: String(mathjaxDefs || ""),
    questions: Array.isArray(questions) ? questions : [],
    downloadedAt: downloadedAt || new Date().toISOString(),
  };
  try {
    await withStore(db, "papers", "readwrite", (store) =>
      idbRequest(store.put(record)),
    );
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    // Evict the oldest cached paper (never the one being saved) and retry.
    const existing = await listCachedPapers(deps);
    const oldest = existing
      .filter((entry) => entry.key !== record.key)
      .sort((a, b) =>
        String(a.downloadedAt || "").localeCompare(
          String(b.downloadedAt || ""),
        ),
      )[0];
    if (!oldest) throw error;
    await removeCachedPaper(oldest.key, deps);
    await withStore(db, "papers", "readwrite", (store) =>
      idbRequest(store.put(record)),
    );
  }
  return summarizePaperRecord(record);
}

export async function removeCachedPaper(paperSourceOrKey, deps = {}) {
  let db;
  try {
    db = await getOfflineDb(deps);
  } catch {
    return false;
  }
  if (!db) return false;
  const key =
    typeof paperSourceOrKey === "string"
      ? paperSourceOrKey
      : paperCacheKey(paperSourceOrKey);
  try {
    await withStore(db, "papers", "readwrite", (store) =>
      idbRequest(store.delete(key)),
    );
  } catch {
    return false;
  }
  // Delete images no longer referenced by any remaining paper.
  try {
    const remaining = await withStore(db, "papers", "readonly", (store) =>
      idbRequest(store.getAll()),
    );
    const referenced = new Set();
    for (const record of remaining || []) {
      for (const url of extractPaperImageUrls(record.questions || [])) {
        referenced.add(url);
      }
    }
    const images = await withStore(db, "images", "readonly", (store) =>
      idbRequest(store.getAll()),
    );
    const orphans = (images || [])
      .map((entry) => entry.url)
      .filter((url) => !referenced.has(url));
    for (const url of orphans) {
      await withStore(db, "images", "readwrite", (store) =>
        idbRequest(store.delete(url)),
      );
      revokeImageObjectUrl(url);
    }
    const cacheStorage = deps.caches ?? globalThis.caches;
    if (await cacheStorage?.has(PAPER_IMAGE_CACHE)) {
      const cache = await cacheStorage.open(PAPER_IMAGE_CACHE);
      const keep = new Set([...referenced].map((url) => new URL(url, globalThis.location?.href).href));
      for (const request of await cache.keys()) {
        if (!keep.has(request.url)) await cache.delete(request);
      }
    }
  } catch {
    // Orphan cleanup is best-effort.
  }
  return true;
}

export async function clearOfflineCache(deps = {}) {
  let db;
  try {
    db = await getOfflineDb(deps);
  } catch {
    return false;
  }
  if (!db) return false;
  for (const storeName of ["papers", "images", "meta"]) {
    try {
      await withStore(db, storeName, "readwrite", (store) =>
        idbRequest(store.clear()),
      );
    } catch {
      // Continue clearing the remaining stores.
    }
  }
  await (deps.caches ?? globalThis.caches)?.delete(PAPER_IMAGE_CACHE);
  revokeAllImageObjectUrls();
  return true;
}

export async function cacheStats(deps = {}) {
  let db;
  try {
    db = await getOfflineDb(deps);
  } catch {
    return {
      papers: 0,
      images: 0,
      imageBytes: 0,
      papersBytes: 0,
      totalBytes: 0,
      available: false,
    };
  }
  if (!db) {
    return {
      papers: 0,
      images: 0,
      imageBytes: 0,
      papersBytes: 0,
      totalBytes: 0,
      available: false,
    };
  }
  try {
    const papers = await withStore(db, "papers", "readonly", (store) =>
      idbRequest(store.getAll()),
    );
    const images = await withStore(db, "images", "readonly", (store) =>
      idbRequest(store.getAll()),
    );
    const imageBytes = (images || []).reduce(
      (sum, entry) => sum + (Number(entry.bytes) || entry.blob?.size || 0),
      0,
    );
    const papersBytes = (papers || []).reduce(
      (sum, entry) =>
        sum + (JSON.stringify(entry.questions || []).length || 0),
      0,
    );
    let opaqueCount = 0;
    try {
      const cacheStorage = deps.caches ?? globalThis.caches;
      if (await cacheStorage?.has(PAPER_IMAGE_CACHE)) {
        const cache = await cacheStorage.open(PAPER_IMAGE_CACHE);
        opaqueCount = (await cache.keys()).length;
      }
    } catch {
      // Still report readable image counts if Cache Storage is unavailable.
    }
    return {
      papers: (papers || []).length,
      images: (images || []).length + opaqueCount,
      imageBytes,
      papersBytes,
      totalBytes: imageBytes + papersBytes,
      available: true,
    };
  } catch {
    return {
      papers: 0,
      images: 0,
      imageBytes: 0,
      papersBytes: 0,
      totalBytes: 0,
      available: true,
    };
  }
}

/* Blob URL hydration (session-scoped; recreated from IDB on each load). */

const objectUrlCache = new Map();

function createObjectUrl(blob, deps = {}) {
  const factory = deps.createObjectURL || globalThis.URL?.createObjectURL;
  if (!factory) return null;
  try {
    return factory.call(globalThis.URL, blob);
  } catch {
    return null;
  }
}

export function revokeImageObjectUrl(url) {
  const existing = objectUrlCache.get(url);
  if (existing) {
    try {
      globalThis.URL?.revokeObjectURL?.(existing);
    } catch {
      // Best-effort.
    }
    objectUrlCache.delete(url);
  }
}

export function revokeAllImageObjectUrls() {
  for (const url of [...objectUrlCache.keys()]) revokeImageObjectUrl(url);
}

export async function getImageObjectUrls(urls, deps = {}) {
  const map = new Map();
  for (const url of urls || []) {
    if (objectUrlCache.has(url)) {
      map.set(url, objectUrlCache.get(url));
      continue;
    }
    const blob = await getCachedImageBlob(url, deps);
    if (!blob) continue;
    const objectUrl = createObjectUrl(blob, deps);
    if (objectUrl) {
      objectUrlCache.set(url, objectUrl);
      map.set(url, objectUrl);
    }
  }
  return map;
}

/** Rewrite cached images in a question list to blob: URLs for rendering. */
export async function hydrateQuestionImages(questions, deps = {}) {
  if (!Array.isArray(questions) || !questions.length) return questions;
  const urls = extractPaperImageUrls(questions);
  let urlMap = new Map();
  try {
    urlMap = await getImageObjectUrls(urls, deps);
  } catch {
    // Still normalize pictures served at their original URLs by the worker.
  }
  return questions.map((question) => rewriteQuestionImages(question, urlMap));
}

/* -------------------------------------------------------------------------- */
/* Download orchestration                                                      */
/* -------------------------------------------------------------------------- */

export async function downloadPaperImages(urls, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const concurrency = Math.max(1, Math.min(8, options.concurrency || 4));
  const maxBytes = options.maxBytes || MAX_IMAGE_BYTES;
  const onProgress = options.onProgress;
  const signal = options.signal;
  const succeeded = new Map();
  let opaqueCount = 0;
  const failed = [];
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      if (signal?.aborted) {
        const error = new Error("Download cancelled.");
        error.name = "AbortError";
        throw error;
      }
      const url = urls[cursor];
      cursor += 1;
      try {
        const init = { credentials: "omit", signal };
        let response;
        try {
          response = await fetchImpl(url, { ...init, mode: "cors" });
        } catch (error) {
          if (signal?.aborted) throw error;
          response = await fetchImpl(url, { ...init, mode: "no-cors" });
        }
        if (response.type === "opaque") {
          // Its body is unreadable (blob() is empty). Store the response
          // itself; the worker serves it to img requests at the original URL.
          const cacheStorage = options.caches ?? globalThis.caches;
          if (!cacheStorage) throw new Error("Image cache is unavailable.");
          const cache = await cacheStorage.open(PAPER_IMAGE_CACHE);
          await cache.put(url, response);
          opaqueCount++;
        } else {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          if (!blob || blob.size === 0) throw new Error("Empty image response.");
          if (blob.size > maxBytes) {
            throw new Error(
              `Image is too large (${blob.size} bytes). Skipped to protect storage.`,
            );
          }
          const contentType =
            blob.type ||
            response.headers?.get?.("content-type") ||
            "";
          if (
            contentType &&
            (contentType.startsWith("text/") ||
              contentType.includes("json") ||
              contentType.includes("html"))
          ) {
            throw new Error(`Unexpected content type ${contentType}.`);
          }
          succeeded.set(url, blob);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        failed.push({ url, error: error?.message || String(error) });
      }
      onProgress?.({
        loaded: succeeded.size + opaqueCount + failed.length,
        total: urls.length,
        succeeded: succeeded.size + opaqueCount,
        failed: failed.length,
        url,
      });
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return { succeeded, opaqueCount, failed };
}

/**
 * Download an exact paper for offline use: load questions, fetch every
 * embedded image (skipping already-cached ones), and persist everything
 * locally. Loaders are injected so this module stays independent of
 * the ZIP/chapter loaders in exact-paper.mjs.
 */
export async function downloadExactPaperOffline({
  paperSource,
  exam,
  paper,
  loadQuestions,
  loadYearData,
  onProgress,
  signal,
  deps = {},
}) {
  if (typeof loadQuestions !== "function") {
    throw new Error("A question loader is required to download this paper.");
  }
  const db = await getOfflineDb(deps);
  if (!db) {
    throw new Error(
      "The offline cache is not available in this browser. You can still download the paper file.",
    );
  }
  onProgress?.({ phase: "questions", loaded: 0, total: 1 });
  const questions = await loadQuestions(exam, paper);
  if (!Array.isArray(questions) || !questions.length) {
    throw new Error("No questions were found for this paper.");
  }
  let mathjaxDefs = "";
  if (paper?.archiveFile && typeof loadYearData === "function") {
    try {
      const yearData = await loadYearData(paper.archiveFile);
      mathjaxDefs = yearData?.mathjaxDefs || "";
    } catch {
      mathjaxDefs = "";
    }
  }
  const urls = extractPaperImageUrls(questions);
  const missing = [];
  let cachedBytes = 0;
  for (const url of urls) {
    const existing = await getCachedImageBlob(url, deps);
    if (existing) cachedBytes += existing.size || 0;
    else {
      const cached = await (deps.caches ?? globalThis.caches)?.match(url, {
        cacheName: PAPER_IMAGE_CACHE, ignoreVary: true,
      }).catch(() => null);
      if (!cached) missing.push(url);
    }
  }
  onProgress?.({
    phase: "images",
    loaded: urls.length - missing.length,
    total: urls.length,
  });
  const { succeeded, opaqueCount, failed } = await downloadPaperImages(missing, {
    fetchImpl: deps.fetchImpl,
    caches: deps.caches,
    signal,
    onProgress: (progress) =>
      onProgress?.({
        phase: "images",
        ...progress,
        loaded: urls.length - missing.length + progress.loaded,
        total: urls.length,
      }),
  });
  onProgress?.({ phase: "saving", loaded: 0, total: 1 });
  let downloadedBytes = cachedBytes;
  for (const [url, blob] of succeeded) {
    await putCachedImage(url, blob, deps);
    downloadedBytes += blob.size || 0;
  }
  const summary = await savePaperOffline({
    paperSource,
    paper,
    exam,
    questions,
    mathjaxDefs,
    imageUrls: urls,
    failedImages: failed.map((entry) => entry.url),
    imageBytes: downloadedBytes,
    deps,
  });
  onProgress?.({ phase: "done", loaded: 1, total: 1 });
  return {
    summary,
    failed,
    succeededCount: succeeded.size + opaqueCount,
    totalImages: urls.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Standalone paper files (HTML + JSON)                                        */
/* -------------------------------------------------------------------------- */

export async function blobToDataUrl(blob) {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () =>
        reject(reader.error || new Error("Could not read an image."));
      reader.readAsDataURL(blob);
    });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
  return `data:${blob.type || "application/octet-stream"};base64,${base64}`;
}

export function downloadBlob(blob, filename) {
  if (typeof document === "undefined") {
    throw new Error("Downloads are only available in the browser.");
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

export function downloadTextFile(filename, text, mime = "text/plain") {
  return downloadBlob(
    new Blob([text], { type: `${mime};charset=utf-8` }),
    filename,
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function answerLabel(question) {
  if (question?.type === "numerical") {
    return String(question.correct_answer ?? question.answerKey ?? "—");
  }
  const answers = Array.isArray(question?.correct_answer)
    ? question.correct_answer
    : [question?.correct_answer].filter(Boolean);
  if (!answers.length) return "—";
  const options = question?.options || [];
  return answers
    .map((id) => {
      const index = options.findIndex(
        (option) => String(option.id) === String(id),
      );
      return index >= 0 ? String.fromCharCode(65 + index) : String(id);
    })
    .join(", ");
}

function subjectLabel(question) {
  return (
    question?.subjectName ||
    { physics: "Physics", chemistry: "Chemistry", math: "Mathematics" }[
      question?.subject
    ] ||
    question?.subject ||
    "General"
  );
}

const STANDALONE_CSS = `
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#16211a;max-width:920px;margin:0 auto;padding:24px 18px 48px;line-height:1.6}
h1{font-size:26px;margin:0 0 6px}
.meta{color:#5b6b5f;font-size:13px;margin:0 0 18px}
.paper{border:1px solid #dfe7d8;border-radius:14px;padding:20px;background:#fff}
.question{padding:18px 0;border-top:1px solid #e6ece0}
.question:first-of-type{border-top:0}
.q-head{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px;color:#5b6b5f;margin-bottom:8px}
.q-num{font-weight:700;color:#163d31}
.badge{background:#eef3e6;border:1px solid #dfe7d8;border-radius:999px;padding:2px 9px}
.rich{font-size:15px;line-height:1.8;overflow-wrap:anywhere}
.rich img,.question-image{max-width:100%;height:auto;display:block;margin:10px auto}
.rich table{border-collapse:collapse;font-size:14px}
.rich td,.rich th{border:1px solid #dfe7d8;padding:6px 9px}
.options{display:grid;gap:8px;margin-top:10px}
.option{border:1px solid #dfe7d8;border-radius:10px;padding:10px 12px}
.option.correct{border-color:#638e52;background:#f0f6ea}
.option .letter{font-weight:700;margin-right:8px}
details.solution{margin-top:12px;border:1px solid #dfe7d8;border-radius:10px;padding:10px 12px;background:#fbfdf8}
details.solution summary{cursor:pointer;font-weight:700;font-size:13px}
.answer-key{width:100%;border-collapse:collapse;font-size:13px;margin:14px 0}
.answer-key th,.answer-key td{border:1px solid #dfe7d8;padding:6px 8px;text-align:left}
.answer-key th{background:#f4f8ef}
mjx-container[jax="SVG"]{display:inline-block;max-width:100%;margin:0 .04em;vertical-align:baseline}
mjx-container[jax="SVG"][display="true"]{display:block;margin:.7em 0;text-align:center}
mjx-container[jax="SVG"]>svg{display:inline-block;max-width:100%;height:auto;overflow:visible;vertical-align:baseline}
.footer{margin-top:22px;font-size:12px;color:#5b6b5f}
@media print{body{padding:0}.paper{border:0}details.solution{break-inside:avoid}}
`.trim();

/**
 * Build a self-contained, printable HTML paper. Images are embedded as
 * data: URLs from `imageDataUrls` (url -> data URL); uncached images keep
 * their remote URL and need internet to display.
 */
export function buildStandalonePaperHtml({
  paper,
  questions,
  mathjaxDefs,
  imageDataUrls,
  includeSolutions = true,
  includeAnswerKey = true,
  generatedAt = new Date().toISOString(),
}) {
  const map = toUrlMap(imageDataUrls);
  const title = String(paper?.title || "Exact paper");
  const list = Array.isArray(questions) ? questions : [];
  const defs = mathjaxDefs
    ? `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>${stripUnsafeHtml(mathjaxDefs)}</defs></svg>`
    : "";
  const keyRows = list
    .map((question, index) => {
      const number = Number(question.paperPosition ?? question.position ?? index + 1);
      return `<tr><td>${number}</td><td>${escapeHtml(subjectLabel(question))}</td><td>${escapeHtml(question.type === "numerical" ? "Numerical" : question.type === "multipleCorrect" ? "Multiple correct" : "Single correct")}</td><td>${escapeHtml(answerLabel(question))}</td></tr>`;
    })
    .join("");
  const body = list
    .map((question, index) => {
      const number = Number(question.paperPosition ?? question.position ?? index + 1);
      const rewritten = rewriteQuestionImages(question, map);
      const safeQuestion = stripUnsafeHtml(rewritten.question_text || "");
      const safeSolution = stripUnsafeHtml(rewritten.solution_text || "");
      const options = (rewritten.options || [])
        .map((option, optionIndex) => {
          const letter = String.fromCharCode(65 + optionIndex);
          const isCorrect =
            String(option.id) === String(question.correct_answer) ||
            (Array.isArray(question.correct_answer) &&
              question.correct_answer.map(String).includes(String(option.id)));
          return `<div class="option${isCorrect ? " correct" : ""}"><span class="letter">${letter}.</span><span class="rich">${stripUnsafeHtml(option.text || option.html || "")}</span></div>`;
        })
        .join("");
      const solution = includeSolutions
        ? `<details class="solution" open><summary>Worked solution · Answer: ${escapeHtml(answerLabel(question))}</summary><div class="rich">${safeSolution || "No worked solution in the source."}</div></details>`
        : "";
      const source = question.sourceUrl
        ? `<a href="${escapeHtml(question.sourceUrl)}" target="_blank" rel="noreferrer">Source</a>`
        : "";
      return `<section class="question"><div class="q-head"><span class="q-num">Q${number}</span><span class="badge">${escapeHtml(subjectLabel(question))}</span><span class="badge">${escapeHtml(question.type === "numerical" ? "Numerical" : question.type === "multipleCorrect" ? "Multiple correct" : "Single correct")}</span>${source}</div><div class="rich">${safeQuestion}</div>${options ? `<div class="options">${options}</div>` : ""}${solution}</section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)} — PYQ Studio</title><style>${STANDALONE_CSS}</style></head><body>${defs}<h1>${escapeHtml(title)}</h1><p class="meta">${list.length} questions · Generated ${escapeHtml(generatedAt)} · Offline file — no internet needed. Images embedded where available.</p>${includeAnswerKey ? `<h2>Answer key</h2><table class="answer-key"><thead><tr><th>#</th><th>Subject</th><th>Type</th><th>Answer</th></tr></thead><tbody>${keyRows}</tbody></table>` : ""}<div class="paper">${body}</div><p class="footer">Generated by PYQ Studio from the checked-in JEE paper archive. Verify answer keys against the official source before relying on them.</p></body></html>`;
}

/** Build a portable JSON bundle (questions + embedded images as data URLs). */
export function buildPaperJsonBundle({
  paper,
  questions,
  mathjaxDefs,
  imageDataUrls,
  exportedAt = new Date().toISOString(),
}) {
  const map = toUrlMap(imageDataUrls);
  const rewritten = (Array.isArray(questions) ? questions : []).map(
    (question) => rewriteQuestionImages(question, map),
  );
  return {
    format: "pyq-studio-paper",
    version: 1,
    exportedAt,
    paper: paper || {},
    mathjaxDefs: String(mathjaxDefs || ""),
    images: Object.fromEntries(map.entries()),
    questions: rewritten,
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Bundle integration helpers                                                  */
/* -------------------------------------------------------------------------- */

/** Store object only — the bundled app stores its state directly. */
export function readWorkspaceStore(defaults = {}, storage) {
  return loadWorkspaceStore(defaults, storage).store;
}

/** Save immediately, using the same checksummed/backup format. */
export function writeWorkspaceStore(store, storage) {
  return saveWorkspaceStore(store, storage);
}

/**
 * Flush the shared debounced saver when the page is hidden or closed, so
 * the last answer/time change is never lost to the 300 ms debounce.
 */
function attachFlushHooks() {
  const flush = () => {
    try {
      workspaceSaver.flush();
    } catch {
      // Nothing more we can do while the page is going away.
    }
  };
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", flush);
    globalThis.addEventListener("beforeunload", flush);
  }
  const doc = globalThis.document;
  if (doc?.addEventListener) {
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") flush();
    });
  }
}

attachFlushHooks();
