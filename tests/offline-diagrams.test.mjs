import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";
import { downloadExactPaperOffline, hydrateQuestionImages, putCachedImage, removeCachedPaper } from "../assets/offline-storage.mjs";
import { createFakeIndexedDb } from "./helpers/fake-idb.mjs";

const bundlePath = "assets/index-ff8d0e4d.js";
const bundle = readFileSync(new URL(`../${bundlePath}`, import.meta.url), "utf8");

test("nc renders hydrated diagrams after DOMPurify, including source-only pictures", async (t) => {
  const url = "https://cdn.example/figure.png";
  const blobUrl = "blob:https://pyq.example/diagram";
  const deps = { indexedDB: createFakeIndexedDb(), createObjectURL: () => blobUrl };
  await putCachedImage(url, new Blob(["diagram"]), deps);
  const [q] = await hydrateQuestionImages([{
    question_text: `<picture><source srcset="${url} 1x, other.png 2x"></picture>`,
    solution_text: `<img src="${url}" srcset="other.png">`,
    options: [{ html: `<picture><img alt="Option" data-orsrc="${url}"></picture>` }],
  }], deps);

  // Mount the shipped rich-text component rather than duplicating its policy.
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    runScripts: "outside-only", url: "https://pyq.example/",
  });
  t.after(() => dom.window.close());
  dom.window.fragment = q.question_text + q.solution_text + q.options[0].html +
    '<img src="data:image/png;base64,AA=="><a href="javascript:void(0)">link</a>';
  const root = dom.window.document.querySelector("#root");
  const rendered = new Promise((resolve) => {
    new dom.window.MutationObserver(resolve).observe(root, { childList: true });
  });
  dom.window.eval(bundle.replace(/^import[^\n]+\n/, "").replace(
    '.render(f.jsx(Tp,{}))', '.render(f.jsx(nc,{text:window.fragment}))',
  ));
  await rendered;
  assert.deepEqual([...root.querySelectorAll("img")].map((img) => img.getAttribute("src")),
    [blobUrl, blobUrl, blobUrl, "data:image/png;base64,AA=="]);
  assert.ok(root.querySelector('img[alt="Option"]'));
  assert.equal(root.querySelector("[srcset],picture,source,a[href]"), null);
});

test("patch script restores the blob policy and can be rerun", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pyq-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "tools"));
  mkdirSync(join(dir, "assets"));
  const script = join(dir, "tools/patch_bundle.py");
  copyFileSync(new URL("../tools/patch_bundle.py", import.meta.url), script);
  const before = bundle.replace(/ALLOWED_URI_REGEXP:\/[^\n]+?\/i,(?=ADD_TAGS:)/, "");
  assert.notEqual(before, bundle);
  writeFileSync(join(dir, bundlePath), before);
  for (let i = 0; i < 2; i++) {
    execFileSync("python3", [script]);
    assert.equal(readFileSync(join(dir, bundlePath), "utf8"), bundle);
  }
});

test("a CDN without CORS is saved and served offline at its original URL", async () => {
  const url = "https://cdn.example/opaque.png";
  const questions = [{ question_text: `<picture><source srcset="${url}"></picture>` }];
  const response = { type: "opaque", ok: false, status: 0 };
  const entries = new Map();
  const stores = new Map();
  const cache = {
    put: async (url, res) => entries.set(url, res),
    match: async (request) => entries.get(request.url || request),
    keys: async () => [...entries.keys()].map((url) => ({ url })),
    delete: async ({ url }) => entries.delete(url),
  };
  const caches = {
    open: async (name) => {
      assert.equal(name, "pyq-paper-images-v1");
      stores.set(name, cache);
      return cache;
    },
    match: async (request, { cacheName }) => stores.get(cacheName)?.match(request),
    has: async (name) => stores.has(name),
  };
  const modes = [];
  const deps = { indexedDB: createFakeIndexedDb(), caches, fetchImpl: async (_, init) => {
    modes.push(init.mode);
    if (init.mode === "cors") throw new TypeError("Failed to fetch");
    return response;
  } };
  const paper = { id: "paper" };
  const download = () => downloadExactPaperOffline({ paper, loadQuestions: () => questions, deps });
  const result = await download();
  assert.deepEqual(result.failed, []);
  assert.equal(result.succeededCount, 1);
  assert.equal(result.summary.imageBytes, 0);
  assert.equal((await hydrateQuestionImages(questions, deps))[0].question_text, `<img src="${url}">`);
  await download();
  assert.deepEqual(modes, ["cors", "no-cors"]);

  // Dispatch the corresponding image request to the actual worker offline.
  const listeners = {};
  const self = { location: new URL("https://pyq.example"), addEventListener: (k, fn) => { listeners[k] = fn; } };
  runInNewContext(readFileSync(new URL("../sw.js", import.meta.url), "utf8"), { self, caches, URL });
  let served;
  listeners.fetch({ request: { method: "GET", url, mode: "no-cors", destination: "image" },
    respondWith: (promise) => { served = promise; } });
  assert.equal(await served, response);
  await removeCachedPaper(paper, deps);
  assert.equal(entries.size, 0);
});
