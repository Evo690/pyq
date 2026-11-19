import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import vm from "node:vm";

import {
  OFFLINE_IMAGE_CACHE_NAME,
  STORE_BACKUP_KEY,
  STORE_KEY,
  blobToDataUrl,
  buildPaperJsonBundle,
  buildStandalonePaperHtml,
  cacheStats,
  checksumString,
  deserializeStore,
  downloadExactPaperOffline,
  downloadPaperImages,
  extractPaperImageUrls,
  formatBytes,
  getCachedImageBlob,
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

test("extractPaperImageUrls extracts only the single effective URL per diagram", () => {
  const urls = extractPaperImageUrls(questions());
  assert.deepEqual(urls.sort(), [
    "https://cdn.example/a.png",
    "https://cdn.example/b.png",
    "https://cdn.example/q.png",
    "https://cdn.example/s.png",
    "https://cdn.example/sol.png",
  ]);
  assert.ok(!urls.includes("https://cdn.example/a.webp"));
  assert.ok(!urls.includes("https://cdn.example/a-original.png"));

  // Multi-srcset Examgoal markup downloads only 1 URL per diagram, not 7-8.
  const examgoalHtml =
    '<img src="https://app-content.cdn.examgoal.net/fly/1000/image/x.png?format=png" ' +
    'data-orsrc="https://app-content.cdn.examgoal.net/image/x.png" ' +
    'srcset="https://app-content.cdn.examgoal.net/fly/500/image/x.png?format=png 500w, ' +
    'https://app-content.cdn.examgoal.net/fly/750/image/x.png?format=png 750w, ' +
    'https://app-content.cdn.examgoal.net/fly/1500/image/x.png?format=png 1500w">';
  assert.deepEqual(extractPaperImageUrls([{ question_text: examgoalHtml }]), [
    "https://app-content.cdn.examgoal.net/fly/1000/image/x.png?format=png",
  ]);

  // Fallback priority when src is absent: data-orsrc -> first srcset candidate, plus missing space before src=
  assert.deepEqual(
    extractPaperImageUrls([
      {
        question_text:
          '<img style="width:300px;"src="https://cdn.example/nospace.png" />' +
          '<img data-orsrc="https://cdn.example/orsrc-only.png" srcset="https://cdn.example/w500.png 500w">' +
          '<picture><source srcset="https://cdn.example/pic-first.webp 1x, https://cdn.example/pic-second.webp 2x"><img alt="x"></picture>',
      },
    ]),
    [
      "https://cdn.example/nospace.png",
      "https://cdn.example/orsrc-only.png",
      "https://cdn.example/pic-first.webp",
    ],
  );
});

test("rewriteHtmlImages flattens <picture> tags and rewrites cached image references", () => {
  const map = new Map([
    ["https://cdn.example/a.png", "blob:one"],
    ["https://cdn.example/a-original.png", "blob:two"],
    ["https://cdn.example/a.webp", "blob:three"],
  ]);

  const withImgSrc =
    '<picture><source srcset="https://cdn.example/a.webp 1x"><img src="https://cdn.example/a.png" data-orsrc="https://cdn.example/a-original.png"></picture>';
  const outImgSrc = rewriteHtmlImages(withImgSrc, map);
  assert.ok(outImgSrc.includes('src="blob:one"'));
  assert.ok(!/<picture|<source|srcset=|data-orsrc=|cdn\.example/i.test(outImgSrc));

  // Priority: src -> data-orsrc -> first srcset candidate
  const withOrsrc =
    '<picture><source srcset="https://cdn.example/a.webp 1x"><img alt="diag" data-orsrc="https://cdn.example/a-original.png"></picture>';
  const outOrsrc = rewriteHtmlImages(withOrsrc, map);
  assert.ok(outOrsrc.includes('src="blob:two"'));
  assert.ok(!/<picture|<source|srcset=|data-orsrc=|cdn\.example/i.test(outOrsrc));

  const withSrcsetOnly =
    '<picture><source srcset="https://cdn.example/a.webp 1x, https://cdn.example/a.png 2x"><img alt="diag"></picture>';
  const outSrcsetOnly = rewriteHtmlImages(withSrcsetOnly, map);
  assert.ok(outSrcsetOnly.includes('src="blob:three"'));
  assert.ok(outSrcsetOnly.includes('alt="diag"'));
  assert.ok(!/<picture|<source|srcset=|cdn\.example/i.test(outSrcsetOnly));

  const sourceOnly =
    '<picture><source srcset="https://cdn.example/a.webp 1x"></picture>';
  const outSourceOnly = rewriteHtmlImages(sourceOnly, map);
  assert.equal(outSourceOnly, '<img src="blob:three">');

  const standaloneImg =
    '<img style="width:300px;"src="https://cdn.example/a.png" srcset="https://cdn.example/a.webp 1x" data-orsrc="https://cdn.example/a-original.png">';
  const outStandalone = rewriteHtmlImages(standaloneImg, map);
  assert.ok(outStandalone.includes('src="blob:one"'));
  assert.ok(!/srcset=|data-orsrc=|cdn\.example/i.test(outStandalone));
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
  assert.equal(result.summary.imageCount, 5);
  assert.equal(result.failed.length, 0);
  assert.equal(requested.length, 5);
  assert.ok(progress.includes("questions"));
  assert.ok(progress.includes("images"));
  assert.ok(progress.includes("done"));

  const record = await getCachedPaper(paper(), { indexedDB });
  assert.equal(record.title, "JEE Main 2024 · Shift 1");
  assert.equal(record.mathjaxDefs, "<defs/>");
  assert.equal(record.questions.length, 2);
  assert.equal(record.imageBytes, 5 * SVG_PNG.length);

  const summaries = await listCachedPapers({ indexedDB });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].complete, true);

  const stats = await cacheStats({ indexedDB });
  assert.equal(stats.papers, 1);
  assert.equal(stats.images, 5);
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

function loadBundleNcSanitizerConfig() {
  const bundle = readFileSync(
    new URL("../assets/index-ff8d0e4d.js", import.meta.url),
    "utf8",
  );
  const match = bundle.match(
    /function nc\(\{text:i="",className:n=""\}\)\{const r=Ae\.useMemo\(\(\)=>\{let s=yp\.sanitize\(String\(i\),(\{[\s\S]*?\})\);/,
  );
  assert.ok(match, "nc sanitizer call must exist in bundle");
  return vm.runInThisContext(`(${match[1]})`);
}

/**
 * Apply the bundle nc DOMPurify config's FORBID_ATTR and URI attribute rules
 * to HTML tags so tests verify what survives sanitization.
 */
function sanitizeWithBundleNcRules(html, config) {
  const forbidAttrs = new Set(
    (config.FORBID_ATTR || []).map((attr) => String(attr).toLowerCase()),
  );
  const allowedUri = config.ALLOWED_URI_REGEXP;
  const dataUriTags = new Set(["img", "source", "audio", "video", "image", "track"]);
  const uriAttrs = new Set(["src", "href", "xlink:href"]);

  return String(html).replace(/<([a-z0-9-]+)([^>]*)>/gi, (full, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    const cleaned = attrs.replace(
      /\s+([a-z0-9:_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi,
      (attrMatch, rawName, dq, sq, uq) => {
        const name = rawName.toLowerCase();
        if (forbidAttrs.has(name)) return "";
        if (!uriAttrs.has(name)) return attrMatch;
        const val = dq ?? sq ?? uq ?? "";
        const normalized = val.replace(
          /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g,
          "",
        );
        const allowedByRegex = allowedUri ? allowedUri.test(normalized) : false;
        const allowedDataUri =
          dataUriTags.has(tag) && normalized.toLowerCase().startsWith("data:");
        return allowedByRegex || allowedDataUri ? attrMatch : "";
      },
    );
    return `<${tagName}${cleaned}>`;
  });
}

function createFakeCacheStorage() {
  const buckets = new Map();
  return {
    buckets,
    async keys() {
      return [...buckets.keys()];
    },
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const entries = buckets.get(name);
      return {
        async put(request, response) {
          const key = typeof request === "string" ? request : request.url;
          entries.set(key, response);
        },
        async match(request) {
          const key = typeof request === "string" ? request : request.url;
          return entries.get(key);
        },
      };
    },
  };
}

test("bundle nc sanitizer allows hydrated blob: src, forbids srcset, and blocks javascript:", async () => {
  const config = loadBundleNcSanitizerConfig();
  assert.ok(config.ALLOWED_URI_REGEXP instanceof RegExp);
  assert.ok(config.FORBID_ATTR.includes("srcset"));
  assert.equal(
    config.ALLOWED_URI_REGEXP.test("blob:https://pyq.example/1234-5678"),
    true,
  );
  assert.equal(config.ALLOWED_URI_REGEXP.test("https://cdn.example/a.png"), true);
  assert.equal(config.ALLOWED_URI_REGEXP.test("javascript:alert(1)"), false);

  const indexedDB = createFakeIndexedDb();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    blob: async () => new Blob([SVG_PNG], { type: "image/png" }),
  });
  const sampleQuestions = [
    {
      uid: "JEE_Main:sanitize-1",
      question_id: "sanitize-1",
      subject: "physics",
      question_text:
        '<p>Diagram:</p><img src="https://cdn.example/q-inline.png" alt="Q">',
      options: [
        {
          id: "A",
          text: '<img src="https://cdn.example/opt-a.png" alt="Opt A">',
        },
      ],
      correct_answer: "A",
      solution_text:
        '<p>Sol:</p><img src="https://cdn.example/sol-inline.png" alt="Sol"><a href="javascript:alert(1)">bad</a>',
    },
  ];
  await downloadExactPaperOffline({
    paperSource: paper(),
    exam: "JEE_Main",
    paper: paper(),
    loadQuestions: async () => sampleQuestions,
    deps: { indexedDB, fetchImpl },
  });

  let counter = 0;
  const hydrated = await hydrateQuestionImages(sampleQuestions, {
    indexedDB,
    createObjectURL: () => `blob:https://pyq.example/img-${++counter}`,
  });

  const sanitizedQuestion = sanitizeWithBundleNcRules(
    hydrated[0].question_text,
    config,
  );
  const sanitizedOption = sanitizeWithBundleNcRules(
    hydrated[0].options[0].text,
    config,
  );
  const sanitizedSolution = sanitizeWithBundleNcRules(
    hydrated[0].solution_text,
    config,
  );

  assert.match(sanitizedQuestion, /src="blob:https:\/\/pyq\.example\/img-\d+"/);
  assert.match(sanitizedOption, /src="blob:https:\/\/pyq\.example\/img-\d+"/);
  assert.match(sanitizedSolution, /src="blob:https:\/\/pyq\.example\/img-\d+"/);
  assert.ok(!sanitizedSolution.includes("javascript:"));
});

test("<picture>-only question renders with src=\"blob:...\" after hydration and sanitization", async () => {
  const config = loadBundleNcSanitizerConfig();
  const indexedDB = createFakeIndexedDb();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/webp" },
    blob: async () => new Blob([SVG_PNG], { type: "image/webp" }),
  });

  const pictureOnlyQuestions = [
    {
      uid: "JEE_Main:pic-1",
      question_id: "pic-1",
      subject: "physics",
      question_text:
        '<picture><source media="(max-width: 500px)" srcset="https://cdn.example/pic-only.webp 500w, https://cdn.example/pic-only-2x.webp 1000w"><img alt="circuit diagram"></picture>',
      options: [
        {
          id: "A",
          text: '<picture><source srcset="https://cdn.example/opt-only.webp 1x"></picture>',
        },
      ],
      correct_answer: "A",
      solution_text:
        '<picture><source srcset="https://cdn.example/sol-fallback.webp 1x"><img data-orsrc="https://cdn.example/sol-orsrc.png" alt="sol"></picture>',
    },
  ];

  await downloadExactPaperOffline({
    paperSource: paper(),
    exam: "JEE_Main",
    paper: paper(),
    loadQuestions: async () => pictureOnlyQuestions,
    deps: { indexedDB, fetchImpl },
  });

  let counter = 0;
  const hydrated = await hydrateQuestionImages(pictureOnlyQuestions, {
    indexedDB,
    createObjectURL: () => `blob:https://pyq.example/pic-${++counter}`,
  });

  const qHtml = sanitizeWithBundleNcRules(hydrated[0].question_text, config);
  const optHtml = sanitizeWithBundleNcRules(hydrated[0].options[0].text, config);
  const solHtml = sanitizeWithBundleNcRules(hydrated[0].solution_text, config);

  assert.match(qHtml, /<img\b[^>]*src="blob:https:\/\/pyq\.example\/pic-\d+"/);
  assert.match(qHtml, /alt="circuit diagram"/);
  assert.ok(!/<picture|<source|srcset=/i.test(qHtml));

  assert.match(optHtml, /<img\b[^>]*src="blob:https:\/\/pyq\.example\/pic-\d+"/);
  assert.ok(!/<picture|<source|srcset=/i.test(optHtml));

  assert.match(solHtml, /<img\b[^>]*src="blob:https:\/\/pyq\.example\/pic-\d+"/);
  assert.ok(!/<picture|<source|srcset=/i.test(solHtml));
});

test("downloadPaperImages retries failed CORS fetch with no-cors and stores opaque response in Cache Storage", async () => {
  const indexedDB = createFakeIndexedDb();
  const caches = createFakeCacheStorage();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, mode: init.mode });
    if (url.includes("opaque.cdn.example")) {
      if (init.mode === "cors") {
        throw new TypeError("Failed to fetch (CORS)");
      }
      if (init.mode === "no-cors") {
        return {
          ok: false,
          status: 0,
          type: "opaque",
          blob: async () => new Blob([]),
        };
      }
    }
    if (url.includes("down.cdn.example")) {
      throw new Error("network down");
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      blob: async () => new Blob([SVG_PNG], { type: "image/png" }),
    };
  };

  const directResult = await downloadPaperImages(
    [
      "https://opaque.cdn.example/diagram.png",
      "https://cors.cdn.example/ok.png",
      "https://down.cdn.example/missing.png",
    ],
    { fetchImpl, caches },
  );
  assert.equal(directResult.succeeded.size, 1);
  assert.equal(directResult.opaque.size, 1);
  assert.ok(directResult.opaque.has("https://opaque.cdn.example/diagram.png"));
  assert.equal(directResult.failed.length, 1);
  assert.equal(
    directResult.failed[0].url,
    "https://down.cdn.example/missing.png",
  );
  assert.ok(
    caches.buckets
      .get(OFFLINE_IMAGE_CACHE_NAME)
      ?.has("https://opaque.cdn.example/diagram.png"),
    "opaque response must be saved into sw.js image cache",
  );

  // Full offline paper download with only CORS-blocked + CORS-allowed images
  const paperQuestions = [
    {
      uid: "JEE_Main:opaque-1",
      question_id: "opaque-1",
      subject: "chemistry",
      question_text:
        '<img src="https://opaque.cdn.example/q-opaque.png" alt="q"><img src="https://cors.cdn.example/q-cors.png" alt="c">',
      options: [{ id: "A", text: "1" }],
      correct_answer: "A",
      solution_text: "<p>Done</p>",
    },
  ];
  const fetchCountBefore = calls.length;
  const offlineResult = await downloadExactPaperOffline({
    paperSource: paper(),
    exam: "JEE_Main",
    paper: paper(),
    loadQuestions: async () => paperQuestions,
    deps: { indexedDB, fetchImpl, caches },
  });
  assert.equal(offlineResult.failed.length, 0);
  assert.equal(offlineResult.summary.complete, true);
  assert.equal(offlineResult.opaqueCount, 1);
  assert.equal(
    await getCachedImageBlob("https://opaque.cdn.example/q-opaque.png", {
      indexedDB,
    }),
    null,
    "opaque images must not be stored as 0-byte blobs in IndexedDB",
  );

  const hydrated = await hydrateQuestionImages(paperQuestions, {
    indexedDB,
    createObjectURL: () => "blob:https://pyq.example/cors-only",
  });
  assert.ok(
    hydrated[0].question_text.includes(
      'src="https://opaque.cdn.example/q-opaque.png"',
    ),
    "opaque-cached URLs stay intact so sw.js serves them from Cache Storage",
  );
  assert.ok(
    hydrated[0].question_text.includes('src="blob:https://pyq.example/cors-only"'),
  );

  // Second download reuses both IndexedDB and Cache Storage entries
  const callsAfterFirst = calls.length - fetchCountBefore;
  assert.ok(callsAfterFirst > 0);
  const callsBeforeSecond = calls.length;
  await downloadExactPaperOffline({
    paperSource: paper(),
    exam: "JEE_Main",
    paper: paper(),
    loadQuestions: async () => paperQuestions,
    deps: { indexedDB, fetchImpl, caches },
  });
  assert.equal(calls.length, callsBeforeSecond);
});

test("tools/patch_bundle.py keeps blob: in nc ALLOWED_URI_REGEXP and is idempotent", () => {
  const script = readFileSync(
    new URL("../tools/patch_bundle.py", import.meta.url),
    "utf8",
  );
  assert.ok(script.includes("allow-blob-image-src"));
  assert.match(script, /ALLOWED_URI_REGEXP:\/\^\(\?:\(\?:blob\|/);

  const output = execFileSync("python3", ["tools/patch_bundle.py"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.match(output, /Patched 0 bundle locations: none/);

  const config = loadBundleNcSanitizerConfig();
  assert.equal(
    config.ALLOWED_URI_REGEXP.test("blob:https://pyq.example/check"),
    true,
  );
});

test("downloadPaperImages bypasses non-CORS HTTP cache on CORS requests and promotes src-less fallback images", async () => {
  const seen = [];
  const res = await downloadPaperImages(["https://cdn.example/diagram.png"], {
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        blob: async () => new Blob([SVG_PNG], { type: "image/png" }),
      };
    },
  });
  assert.equal(res.succeeded.size, 1);
  assert.equal(seen[0].init.mode, "cors");
  assert.equal(seen[0].init.cache, "no-store");

  // Even if no blobs are in IndexedDB (e.g. opaque Cache Storage only),
  // hydrateQuestionImages still normalizes <img data-orsrc/srcset> to <img src>.
  const indexedDB = createFakeIndexedDb();
  const hydrated = await hydrateQuestionImages(
    [
      {
        uid: "q-fallback",
        question_text:
          '<img data-orsrc="https://cdn.example/orsrc.png" srcset="https://cdn.example/w500.png 500w">',
        solution_text:
          '<img style="width:300px;"src="https://cdn.example/nospace.png">',
      },
    ],
    { indexedDB },
  );
  assert.ok(hydrated[0].question_text.includes('src="https://cdn.example/orsrc.png"'));
  assert.ok(!/srcset=|data-orsrc=/i.test(hydrated[0].question_text));
  assert.ok(hydrated[0].solution_text.includes('src="https://cdn.example/nospace.png"'));
});

test("sw.js pre-caches boot manifests, KaTeX fonts, and aligns IMAGE_CACHE", () => {
  const swSource = readFileSync(
    new URL("../sw.js", import.meta.url),
    "utf8",
  );
  assert.ok(swSource.includes('"/data/manifest.json"'));
  assert.ok(swSource.includes('"/data/exact-papers.json"'));
  assert.ok(swSource.includes('"/data/papers.json"'));
  assert.ok(swSource.includes('"/assets/KaTeX_Main-Regular-B22Nviop.woff2"'));
  assert.ok(swSource.includes('"/fonts/font-0.ttf"'));
  assert.ok(
    swSource.includes(`const IMAGE_CACHE = "${OFFLINE_IMAGE_CACHE_NAME}";`),
  );
});

