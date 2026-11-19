import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildExactPaperQuestions,
  compactExactPaperTest,
  compactPaperSource,
  latestSavedPaper,
  loadExactPaperQuestions,
  loadPaperCatalog,
  normalizePaperCatalog,
  resetExactPaperYearCache,
  restoreExactPaperSession,
  restoreExactPaperTest,
  restoreSessionQuestions,
} from "../assets/exact-paper.mjs";
import {
  dataJson,
  isNetworkFailure,
  isOfflineError,
  offlineError,
  resetArchiveCache,
} from "../assets/experience.mjs";
import {
  downloadExactPaperOffline,
  findCachedPaper,
  listCachedPaperSources,
  paperCacheKey,
  resetOfflineDb,
  savePaperOffline,
} from "../assets/offline-storage.mjs";
import { createFakeIndexedDb } from "./helpers/fake-idb.mjs";

const paperIndex = JSON.parse(
  readFileSync(new URL("../data/papers.json", import.meta.url), "utf8"),
);
const FIREFOX_OFFLINE = "NetworkError when attempting to fetch resource.";

function installFakeIndexedDb() {
  const indexedDB = createFakeIndexedDb();
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  resetOfflineDb();
  return {
    indexedDB,
    restore() {
      if (previous === undefined) delete globalThis.indexedDB;
      else globalThis.indexedDB = previous;
      resetOfflineDb();
    },
  };
}

/** Make every fetch fail the way Firefox does with no connection. */
function withFirefoxOffline() {
  const original = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    throw new TypeError(FIREFOX_OFFLINE);
  };
  resetArchiveCache();
  resetExactPaperYearCache();
  return {
    requested,
    restore() {
      globalThis.fetch = original;
      resetArchiveCache();
      resetExactPaperYearCache();
    },
  };
}

/** Serve the checked-in chapter files as the network would. */
function withChapterFiles() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = decodeURIComponent(String(url));
    if (path.startsWith("/data/")) {
      const body = readFileSync(new URL(`..${path}`, import.meta.url));
      return new Response(body, { status: 200 });
    }
    throw new TypeError(FIREFOX_OFFLINE);
  };
  return () => {
    globalThis.fetch = original;
  };
}

/** The real JEE Main 2018 (08 Apr) sitting: it only exists in the chapter bank. */
function chapterBankPaper() {
  const paper = normalizePaperCatalog(paperIndex.exams.JEE_Main).find(
    (entry) => entry.title === "JEE Main 2018 (08 Apr)",
  );
  assert.ok(paper, "the 2018 chapter-bank paper must be in data/papers.json");
  assert.equal(paper.archiveFile, "");
  assert.ok(paper.sources.length > 0);
  return paper;
}

async function downloadChapterBankPaper(fake, paper) {
  const restoreFetch = withChapterFiles();
  try {
    return await downloadExactPaperOffline({
      paperSource: paper,
      exam: "JEE_Main",
      paper,
      loadQuestions: (exam, selected) =>
        loadExactPaperQuestions(exam, selected, { useCache: false }),
      deps: {
        indexedDB: fake.indexedDB,
        fetchImpl: async () => {
          throw new TypeError(FIREFOX_OFFLINE);
        },
      },
    });
  } finally {
    restoreFetch();
  }
}

test("the browser's raw fetch failure becomes an actionable offline error", async () => {
  for (const message of [FIREFOX_OFFLINE, "Failed to fetch", "Load failed"]) {
    assert.ok(isNetworkFailure(new TypeError(message)), message);
  }
  assert.ok(!isNetworkFailure(Object.assign(new Error("x"), { name: "AbortError" })));
  assert.ok(!isNetworkFailure(new Error("No questions were found for this paper.")));

  const offline = withFirefoxOffline();
  const fake = installFakeIndexedDb();
  try {
    const paper = normalizePaperCatalog(
      JSON.parse(readFileSync(new URL("../data/exact-papers.json", import.meta.url), "utf8"))
        .exams.JEE_Main,
    ).find((entry) => entry.archiveFile === "jee-main-2021.json");
    const error = await loadExactPaperQuestions("JEE_Main", paper).catch((e) => e);
    assert.ok(isOfflineError(error), String(error));
    assert.doesNotMatch(error.message, /NetworkError|Failed to fetch/);
    assert.match(error.message, /offline/i);
    assert.ok(offline.requested.some((url) => url.endsWith(".zip")));
  } finally {
    offline.restore();
    fake.restore();
  }
});

test("the start screen explains a missing manifest offline in plain words", async () => {
  const offline = withFirefoxOffline();
  try {
    const error = await dataJson("manifest.json").catch((e) => e);
    assert.ok(isOfflineError(error), String(error));
    assert.match(error.message, /hasn't finished saving itself/);
    // Other data files keep the general offline message.
    const chapter = await dataJson("JEE_Main/Physics/Optics.json").catch((e) => e);
    assert.ok(isOfflineError(chapter));
    assert.doesNotMatch(chapter.message, /NetworkError|saving itself/);
  } finally {
    offline.restore();
  }
});

test("a worker 503 for an uncached file is reported as offline too", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("{}", { status: 503, headers: { "X-PYQ-Offline": "1" } });
  resetArchiveCache();
  resetExactPaperYearCache();
  try {
    const error = await loadExactPaperQuestions("JEE_Main", chapterBankPaper(), {
      useCache: false,
    }).catch((e) => e);
    assert.ok(isOfflineError(error), String(error));
  } finally {
    globalThis.fetch = original;
    resetArchiveCache();
  }
});

test("chapter-bank questions carry a compact, restorable paper source", () => {
  const paper = chapterBankPaper();
  const source = compactPaperSource(paper);
  assert.equal(paperCacheKey(source), paperCacheKey(paper));
  assert.equal(source.archiveFile, "");
  assert.equal(source.source, "data.zip");
  assert.deepEqual(
    source.sources,
    paper.sources.map(({ subject, chapter, file }) => ({ subject, chapter, file })),
  );

  const built = buildExactPaperQuestions(
    [{ subject: "physics", chapter: "Optics", questions: [{ question_id: "q1", paper_year_title: paper.title }] }],
    "JEE_Main",
    paper,
  );
  assert.deepEqual(built[0].paperSource, source);

  // Archive papers keep the same compact shape as before (no chapter list).
  const archive = compactPaperSource({ id: "x", slug: "x", title: "T", archiveFile: "jee-main-2024.json", sources: [{ file: "a" }] });
  assert.equal(archive.sources, undefined);
  assert.equal(archive.source, "jee-main-papers-by-year.zip");
});

test("a downloaded chapter-bank paper starts, resumes and reopens with no network", async () => {
  const fake = installFakeIndexedDb();
  const paper = chapterBankPaper();
  const result = await downloadChapterBankPaper(fake, paper);
  assert.equal(result.summary.questionCount, paper.questionCount);

  const offline = withFirefoxOffline();
  try {
    const questions = await loadExactPaperQuestions("JEE_Main", paper);
    assert.equal(questions.length, paper.questionCount);
    const paperSource = questions.find((question) => question.paperSource)?.paperSource;
    assert.ok(paperSource, "the session must be able to store exactPaperSource");

    // What the bundle stores for an unfinished test, then resumes.
    const draft = {
      exam: "JEE_Main",
      title: paper.title,
      exactPaper: true,
      exactPaperSource: paperSource,
      questionRefs: questions.map(({ uid, question_id, subject, chapter }) => ({ uid, question_id, subject, chapter })),
      answers: { [questions[0].uid]: "B" },
      questionTimes: { [questions[0].uid]: 12 },
    };
    const resumed = await restoreExactPaperSession(draft);
    assert.equal(resumed.length, paper.questionCount);
    assert.equal(resumed[0].userAnswer, "B");

    // Completed reports are now stored compactly and reopen from the copy.
    const report = compactExactPaperTest({
      id: "t",
      exam: "JEE_Main",
      title: paper.title,
      exactPaperSource: paperSource,
      questions: resumed.map((question) => ({ ...question, isCorrect: null })),
    });
    assert.ok(!("question_text" in report.questions[0]));
    const reopened = await restoreExactPaperTest(report);
    assert.equal(reopened.questions.length, paper.questionCount);
    assert.equal(reopened.questions[0].userAnswer, "B");
    assert.ok(reopened.questions[0].question_text);
    assert.deepEqual(offline.requested, []);
  } finally {
    offline.restore();
    fake.restore();
  }
});

test("unfinished tests started before this fix resume from the offline copy", async () => {
  const fake = installFakeIndexedDb();
  const paper = chapterBankPaper();
  await downloadChapterBankPaper(fake, paper);

  // Old offline copies predate the paperSource field on questions.
  const record = await findCachedPaper({ title: paper.title, exam: "JEE_Main" });
  assert.ok(record);
  await savePaperOffline({
    paperSource: record.paperSource,
    exam: "JEE_Main",
    questions: record.questions.map(({ paperSource, ...question }) => question),
    imageUrls: [],
    deps: { indexedDB: fake.indexedDB },
  });

  const offline = withFirefoxOffline();
  try {
    const questions = await loadExactPaperQuestions("JEE_Main", paper);
    assert.ok(questions.every((question) => question.paperSource), "legacy copies gain a paper source");

    // A legacy draft: exactPaperSource was null for chapter-bank papers.
    const legacyDraft = {
      exam: "JEE_Main",
      title: paper.title,
      exactPaper: true,
      exactPaperSource: null,
      questionRefs: questions.slice(0, 3).map(({ uid, question_id }) => ({ uid, question_id })),
      answers: { [questions[1].uid]: "A" },
    };
    let bankCalls = 0;
    const restored = await restoreSessionQuestions(legacyDraft, async () => {
      bankCalls += 1;
      throw new TypeError(FIREFOX_OFFLINE);
    });
    assert.equal(bankCalls, 0);
    assert.equal(restored.length, paper.questionCount);
    assert.equal(restored[1].userAnswer, "A");

    // Ordinary practice sessions still use the question bank.
    const practice = await restoreSessionQuestions(
      { exam: "JEE_Main", title: "Your adaptive daily 10", exactPaper: false },
      async () => ["bank"],
    );
    assert.deepEqual(practice, ["bank"]);
  } finally {
    offline.restore();
    fake.restore();
  }
});

test("Retry images reuses the saved questions instead of reloading the paper", async () => {
  const fake = installFakeIndexedDb();
  try {
    const paper = { id: "p", slug: "p", title: "Paper P", questionCount: 1 };
    const url = "https://cdn.example/fig.png";
    await savePaperOffline({
      paperSource: paper,
      exam: "JEE_Main",
      questions: [{ uid: "u1", question_text: `<img src="${url}">` }],
      mathjaxDefs: "<path id='d'/>",
      imageUrls: [url],
      failedImages: [url],
      deps: { indexedDB: fake.indexedDB },
    });
    let loaderCalls = 0;
    const result = await downloadExactPaperOffline({
      paperSource: paper,
      exam: "JEE_Main",
      paper,
      reuseSaved: true,
      loadQuestions: async () => {
        loaderCalls += 1;
        throw new TypeError(FIREFOX_OFFLINE);
      },
      deps: {
        indexedDB: fake.indexedDB,
        fetchImpl: async () => new Response(new Blob(["png"], { type: "image/png" })),
      },
    });
    assert.equal(loaderCalls, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(result.summary.complete, true);
    const saved = await findCachedPaper({ title: "Paper P" });
    assert.equal(saved.mathjaxDefs, "<path id='d'/>");
  } finally {
    fake.restore();
  }
});

test("offline, the picker defaults to the newest saved paper and keeps saved papers selectable", async () => {
  const fake = installFakeIndexedDb();
  try {
    const catalog = normalizePaperCatalog(paperIndex.exams.JEE_Advanced);
    const older = catalog.find((paper) => paper.year === "2019");
    const newer = catalog.find((paper) => paper.year === "2016");
    await savePaperOffline({ paperSource: compactPaperSource(older), exam: "JEE_Advanced", questions: [{ uid: "a" }], downloadedAt: "2026-11-01T00:00:00.000Z", deps: { indexedDB: fake.indexedDB } });
    await savePaperOffline({ paperSource: compactPaperSource(newer), exam: "JEE_Advanced", questions: [{ uid: "b" }], downloadedAt: "2026-11-18T00:00:00.000Z", deps: { indexedDB: fake.indexedDB } });

    assert.equal((await latestSavedPaper(catalog, "JEE_Advanced")).id, newer.id);
    assert.equal(await latestSavedPaper(catalog, "JEE_Main"), null);
    assert.equal(
      (await listCachedPaperSources("JEE_Advanced")).map((source) => source.title).join(" | "),
      `${newer.title} | ${older.title}`,
    );

    // papers.json unavailable offline: saved papers are still offered.
    const offlineIndex = async () => {
      throw offlineError();
    };
    const papers = await loadPaperCatalog("JEE_Advanced", { loadIndex: offlineIndex });
    assert.deepEqual(papers.map((paper) => paper.id).sort(), [newer.id, older.id].sort());
    assert.ok(papers.every((paper) => paper.sources.length > 0));

    // Nothing saved: the original error still surfaces (the picker shows Try again).
    await assert.rejects(
      loadPaperCatalog("JEE_Advanced", { loadIndex: offlineIndex, loadSavedPapers: async () => [] }),
      isOfflineError,
    );

    // JEE Main keeps its built-in archive catalog plus saved chapter-bank papers.
    const main = await loadPaperCatalog("JEE_Main", {
      loadIndex: offlineIndex,
      loadSavedPapers: async () => [compactPaperSource(chapterBankPaper())],
    });
    assert.ok(main.some((paper) => paper.title === "JEE Main 2018 (08 Apr)"));
    assert.ok(main.some((paper) => paper.archiveFile));
  } finally {
    fake.restore();
  }
});
