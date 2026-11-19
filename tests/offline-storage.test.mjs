import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  STORE_BACKUP_KEY,
  STORE_KEY,
  blobToDataUrl,
  buildPaperJsonBundle,
  buildStandalonePaperHtml,
  cacheStats,
  checksumString,
  deserializeStore,
  downloadExactPaperOffline,
  extractPaperImageUrls,
  formatBytes,
  getCachedPaper,
  hydrateQuestionImages,
  isOfflineCacheAvailable,
  listCachedPapers,
  loadWorkspaceStore,
  paperCacheKey,
  paperFileSlug,
  readWorkspaceStore,
  removeCachedPaper,
  resetOfflineDb,
  rewriteHtmlImages,
  saveWorkspaceStore,
  serializeStore,
  stripUnsafeHtml,
} from "../assets/offline-storage.mjs";
import {
  SVG_PNG,
  createFakeIndexedDb,
  createMemoryStorage,
} from "./helpers/fake-idb.mjs";


function paper() {
  return {
    id: "jee-main-2024-s1",
    slug: "jee-main-2024-s1",
    archiveFile: "jee-main-2024.json",
    title: "JEE Main 2024 · Shift 1",
    year: "2024",
    questionCount: 2,
  };
}

function questions() {
  return [
    {
      uid: "JEE_Main:1",
      question_id: "1",
      subject: "physics",
      question_text:
        '<p>Find the value.</p><picture><source srcset="https://cdn.example/a.webp"><img src="https://cdn.example/a.png" data-orsrc="https://cdn.example/a-original.png"></picture>',
      options: [
        { id: "A", text: "1" },
        { id: "B", text: "2", image: "https://cdn.example/b.png" },
      ],
      correct_answer: "B",
      solution_text: '<p>Because of B.</p><img src="https://cdn.example/s.png">',
      question_image: "https://cdn.example/q.png",
      solution_image: "https://cdn.example/sol.png",
    },
    {
      uid: "JEE_Main:2",
      question_id: "2",
      subject: "chemistry",
      question_text: "<p>Second question.</p>",
      options: [{ id: "A", text: "x" }],
      correct_answer: "A",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Reliable local storage                                                      */
/* -------------------------------------------------------------------------- */

test("serializeStore writes a checksummed wrapper and deserializeStore round-trips", () => {
  const raw = serializeStore({ goal: 20, theme: "dark" });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2);
  assert.match(parsed.checksum, /^[0-9a-f]{8}$/);
  assert.equal(parsed.checksum, checksumString(parsed.data));

  const result = deserializeStore(raw);
  assert.deepEqual(result.store, { goal: 20, theme: "dark" });
  assert.equal(result.meta.legacy, false);
});

test("deserializeStore reads legacy v1 payloads and rejects corrupted ones", () => {
  const legacy = deserializeStore(JSON.stringify({ goal: 30 }));
  assert.equal(legacy.store.goal, 30);
  assert.equal(legacy.meta.legacy, true);

  const wrapped = JSON.parse(serializeStore({ goal: 10 }));
  wrapped.data = JSON.stringify({ goal: 99 });
  assert.equal(deserializeStore(JSON.stringify(wrapped)), null);
  assert.equal(deserializeStore("not json"), null);
  assert.equal(deserializeStore(null), null);
});

test("saveWorkspaceStore keeps the previous good state as a backup", () => {
  const storage = createMemoryStorage();
  saveWorkspaceStore({ goal: 20, tests: [] }, storage);
  const first = storage.getItem(STORE_KEY);
  saveWorkspaceStore({ goal: 40, tests: [] }, storage);

  assert.notEqual(storage.getItem(STORE_KEY), first);
  assert.equal(storage.getItem(STORE_BACKUP_KEY), first);
});

test("loadWorkspaceStore recovers from a corrupted primary via the backup", () => {
  const storage = createMemoryStorage();
  saveWorkspaceStore({ goal: 20, theme: "light" }, storage);
  saveWorkspaceStore({ goal: 50, theme: "dark" }, storage);
  storage.setItem(STORE_KEY, "{ broken");

  const loaded = loadWorkspaceStore({ goal: 5 }, storage);
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.source, "backup");
  assert.equal(loaded.store.goal, 20);
  // Defaults are still merged for keys the backup never had.
  const defaults = loadWorkspaceStore({ attempts: {} }, storage);
  assert.deepEqual(defaults.store.attempts, {});
});

test("a recovery save never overwrites the good backup with corrupted data", () => {
  const storage = createMemoryStorage();
  saveWorkspaceStore({ goal: 20, theme: "light" }, storage);
  saveWorkspaceStore({ goal: 50, theme: "dark" }, storage);
  const goodBackup = storage.getItem(STORE_BACKUP_KEY);
  storage.setItem(STORE_KEY, "{ broken");

  const recovered = loadWorkspaceStore({}, storage);
  assert.equal(recovered.store.goal, 20);
  saveWorkspaceStore(recovered.store, storage);

  assert.equal(storage.getItem(STORE_BACKUP_KEY), goodBackup);
  assert.equal(deserializeStore(storage.getItem(STORE_KEY)).store.goal, 20);
});

test("loadWorkspaceStore migrates legacy data and readWorkspaceStore returns the store only", () => {
  const storage = createMemoryStorage({
    [STORE_KEY]: JSON.stringify({ goal: 15, attempts: { a: 1 } }),
  });
  const loaded = loadWorkspaceStore({ goal: 20, theme: "light" }, storage);
  assert.equal(loaded.source, "legacy");
  assert.equal(loaded.store.goal, 15);
  assert.equal(loaded.store.theme, "light");

  assert.deepEqual(readWorkspaceStore({ goal: 20 }, storage), {
    goal: 15,
    attempts: { a: 1 },
  });
});

test("saveWorkspaceStore reports quota failures with an actionable message", () => {
  const storage = createMemoryStorage();
  storage.setItem = () => {
    const error = new Error("full");
    error.name = "QuotaExceededError";
    throw error;
  };
  assert.throws(
    () => saveWorkspaceStore({ goal: 20 }, storage),
    (error) =>
      error.name === "QuotaExceededError" &&
      /Export your progress from settings/.test(error.message),
  );
});

beforeEach(() => {
  resetOfflineDb();
});

/* -------------------------------------------------------------------------- */
/* Image extraction and rewriting                                              */
/* -------------------------------------------------------------------------- */

test("extractPaperImageUrls finds srcset, data-orsrc, option and solution images", () => {
  const urls = extractPaperImageUrls(questions());
  assert.ok(urls.includes("https://cdn.example/a.png"));
  assert.ok(urls.includes("https://cdn.example/a-original.png"));
  assert.ok(urls.includes("https://cdn.example/b.png"));
  assert.ok(urls.includes("https://cdn.example/q.png"));
  assert.ok(urls.includes("https://cdn.example/sol.png"));
  assert.ok(urls.includes("https://cdn.example/s.png"));
  assert.equal(new Set(urls).size, urls.length);
});

test("rewriteHtmlImages points every reference at the cached copy", () => {
  const html =
    '<picture><source srcset="https://cdn.example/a.webp 1x"><img src="https://cdn.example/a.png" data-orsrc="https://cdn.example/a-original.png"></picture>';
  const map = new Map([
    ["https://cdn.example/a.png", "blob:one"],
    ["https://cdn.example/a-original.png", "blob:two"],
    ["https://cdn.example/a.webp", "blob:three"],
  ]);
  const out = rewriteHtmlImages(html, map);
  assert.ok(out.includes('src="blob:one"'));
  assert.ok(out.includes('data-orsrc="blob:two"'));
  assert.doesNotMatch(out, /<picture|<source|srcset=/i);
  assert.ok(!out.includes("cdn.example"));
});

test("buildPaperJsonBundle embeds images as data URLs, keyed by original URL", async () => {
  const dataUrl = await blobToDataUrl(new Blob([SVG_PNG], { type: "image/png" }));
  assert.match(dataUrl, /^data:image\/png;base64,/);

  const bundle = buildPaperJsonBundle({
    paper: paper(),
    questions: questions(),
    imageDataUrls: new Map([["https://cdn.example/q.png", dataUrl]]),
    exportedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(bundle.format, "pyq-studio-paper");
  assert.equal(bundle.version, 1);
  assert.equal(bundle.questions[0].question_image, dataUrl);
  assert.equal(bundle.images["https://cdn.example/q.png"], dataUrl);
  // Un-cached images keep their remote URL rather than breaking the file.
  assert.equal(
    bundle.questions[0].solution_image,
    "https://cdn.example/sol.png",
  );
});

test("buildStandalonePaperHtml is self-contained and strips unsafe markup", () => {
  const html = buildStandalonePaperHtml({
    paper: paper(),
    questions: [
      {
        ...questions()[0],
        solution_text:
          '<script>alert(1)</script><p onclick="steal()">Solution</p><img src="data:image/png;base64,AAA">',
      },
    ],
    imageDataUrls: new Map([["https://cdn.example/q.png", "data:image/png;base64,AAA"]]),
  });
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes("JEE Main 2024"));
  assert.ok(html.includes("data:image/png;base64,AAA"));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/onclick=/i.test(html));
  assert.equal(stripUnsafeHtml('<b>x</b><iframe src="y"></iframe>'), "<b>x</b>");
});

test("paperCacheKey and paperFileSlug are stable", () => {
  assert.equal(
    paperCacheKey({ archiveFile: "jee-main-2024.json", slug: "s1" }),
    "jee-main-2024.json::s1",
  );
  assert.equal(paperCacheKey({ id: "abc" }), "paper::abc");
  assert.equal(paperCacheKey({ title: "JEE Main 2023" }), "title::JEE Main 2023");
  assert.equal(paperFileSlug("JEE Main 2024 · Shift 1"), "jee-main-2024-shift-1");
  assert.equal(formatBytes(2048), "2.0 KB");
});

/* -------------------------------------------------------------------------- */
/* Offline paper download (IndexedDB)                                          */
/* -------------------------------------------------------------------------- */

test("isOfflineCacheAvailable reflects the presence of IndexedDB", () => {
  assert.equal(isOfflineCacheAvailable({ indexedDB: createFakeIndexedDb() }), true);
});

test("downloadExactPaperOffline caches the paper and every embedded image", async () => {
  const indexedDB = createFakeIndexedDb();
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith("broken.png")) {
      return { ok: false, status: 404, blob: async () => null };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      blob: async () => new Blob([SVG_PNG], { type: "image/png" }),
    };
  };
  const progress = [];
  const result = await downloadExactPaperOffline({
    paperSource: paper(),
    exam: "JEE_Main",
    paper: paper(),
    loadQuestions: async () => questions(),
    loadYearData: async () => ({ mathjaxDefs: "<defs/>" }),
    onProgress: (next) => progress.push(next.phase),
    deps: { indexedDB, fetchImpl },
  });

  assert.equal(result.summary.questionCount, 2);
  assert.equal(result.summary.imageCount, 7);
  assert.equal(result.failed.length, 0);
  assert.equal(requested.length, 7);
  assert.ok(progress.includes("questions"));
  assert.ok(progress.includes("images"));
  assert.ok(progress.includes("done"));

  const record = await getCachedPaper(paper(), { indexedDB });
  assert.equal(record.title, "JEE Main 2024 · Shift 1");
  assert.equal(record.mathjaxDefs, "<defs/>");
  assert.equal(record.questions.length, 2);
  assert.equal(record.imageBytes, 7 * SVG_PNG.length);

  const summaries = await listCachedPapers({ indexedDB });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].complete, true);

  const stats = await cacheStats({ indexedDB });
  assert.equal(stats.papers, 1);
  assert.equal(stats.images, 7);
  assert.ok(stats.totalBytes > 0);
});

test("downloadExactPaperOffline records failed images instead of dropping the paper", async () => {
  const indexedDB = createFakeIndexedDb();
  const fetchImpl = async (url) => {
    if (url.includes("sol.png")) {
      throw new Error("network down");
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      blob: async () => new Blob([SVG_PNG], { type: "image/png" }),
    };
  };
  const result = await downloadExactPaperOffline({
    paperSource: paper(),
    exam: "JEE_Main",
    paper: paper(),
    loadQuestions: async () => questions(),
    deps: { indexedDB, fetchImpl },
  });
  assert.equal(result.failed.length, 1);
  const summaries = await listCachedPapers({ indexedDB });
  assert.equal(summaries[0].complete, false);
  assert.deepEqual(summaries[0].failedImages, ["https://cdn.example/sol.png"]);
  // The paper itself is still fully usable offline.
  assert.equal(summaries[0].questionCount, 2);
});

test("offline cache: second download reuses images, and removal clears the paper", async () => {
  const indexedDB = createFakeIndexedDb();
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      blob: async () => new Blob([SVG_PNG], { type: "image/png" }),
    };
  };
  const run = () =>
    downloadExactPaperOffline({
      paperSource: paper(),
      exam: "JEE_Main",
      paper: paper(),
      loadQuestions: async () => questions(),
      deps: { indexedDB, fetchImpl },
    });

  await run();
  const afterFirst = fetches;
  await run();
  assert.equal(fetches, afterFirst, "already-cached images must not refetch");

  assert.equal(await removeCachedPaper(paper(), { indexedDB }), true);
  assert.equal(await getCachedPaper(paper(), { indexedDB }), null);
  assert.deepEqual(await listCachedPapers({ indexedDB }), []);
});

test("hydrateQuestionImages rewrites cached images to blob URLs for offline rendering", async () => {
  const indexedDB = createFakeIndexedDb();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    blob: async () => new Blob([SVG_PNG], { type: "image/png" }),
  });
  await downloadExactPaperOffline({
    paperSource: paper(),
    exam: "JEE_Main",
    paper: paper(),
    loadQuestions: async () => questions(),
    deps: { indexedDB, fetchImpl },
  });

  const hydrated = await hydrateQuestionImages(questions(), {
    indexedDB,
    createObjectURL: () => "blob:offline-image",
  });
  assert.equal(hydrated[0].question_image, "blob:offline-image");
  assert.equal(hydrated[0].options[1].image, "blob:offline-image");
  assert.ok(hydrated[0].question_text.includes("blob:offline-image"));
  assert.ok(hydrated[0].solution_text.includes("blob:offline-image"));
  assert.ok(!JSON.stringify(hydrated).includes("cdn.example"));
});
