import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  compactExactPaperTest,
  loadExactPaperQuestions,
  normalizePaperCatalog,
  resetExactPaperYearCache,
  restoreExactPaperSession,
  restoreExactPaperTest,
} from "../assets/exact-paper.mjs";
import { resetArchiveCache } from "../assets/experience.mjs";
import {
  downloadExactPaperOffline,
  resetOfflineDb,
} from "../assets/offline-storage.mjs";
import {
  SVG_PNG,
  createFakeIndexedDb,
} from "./helpers/fake-idb.mjs";

const catalog = JSON.parse(
  readFileSync(new URL("../data/exact-papers.json", import.meta.url), "utf8"),
);
const archivePath = new URL("../jee-main-papers-by-year.zip", import.meta.url);

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

/** Serve the checked-in ZIP for archive requests, fail everything else. */
function withOfflineNetwork() {
  const original = globalThis.fetch;
  const realZip = readFileSync(archivePath);
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (key.startsWith("/data/exact-papers/")) return { ok: false };
    if (key.includes(".zip")) {
      return {
        ok: true,
        arrayBuffer: async () => toArrayBuffer(realZip),
      };
    }
    throw new TypeError("Failed to fetch (offline)");
  };
  return () => {
    globalThis.fetch = original;
  };
}

function withNoNetwork() {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch (offline)");
  };
  return () => {
    globalThis.fetch = original;
  };
}

function imageFetch() {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/png" },
    blob: async () => new Blob([SVG_PNG], { type: "image/png" }),
  });
}

/** Forget every in-memory archive so only IndexedDB can answer a load. */
function forgetInMemoryArchives() {
  resetArchiveCache();
  resetExactPaperYearCache();
}

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

function archivedPaper() {
  const selected = normalizePaperCatalog(catalog.exams.JEE_Main).find(
    (entry) => entry.slug === "jee-main-2018-offline",
  );
  assert.ok(selected, "the 2018 archive paper must be in the catalog");
  return selected;
}

test("a paper downloaded for offline use loads with no network at all", async (t) => {
  if (typeof DecompressionStream === "undefined") {
    t.skip("DecompressionStream is unavailable");
    return;
  }
  const fake = installFakeIndexedDb();
  const restoreFetch = withOfflineNetwork();
  try {
    const selected = archivedPaper();
    const result = await downloadExactPaperOffline({
      paperSource: selected,
      exam: "JEE_Main",
      paper: selected,
      loadQuestions: (exam, paper) =>
        loadExactPaperQuestions(exam, paper, { useCache: false }),
      deps: { indexedDB: fake.indexedDB, fetchImpl: imageFetch() },
    });
    assert.equal(result.summary.questionCount, 71);
    assert.equal(result.failed.length, 0);
    assert.ok(result.summary.imageCount > 0, "diagrams must be downloaded");
  } finally {
    restoreFetch();
  }

  const restoreOffline = withNoNetwork();
  // Nothing but the IndexedDB copy can serve this load now.
  forgetInMemoryArchives();
  try {
    const questions = await loadExactPaperQuestions("JEE_Main", archivedPaper());
    assert.equal(questions.length, 71);
    assert.ok(questions.every((question) => question.question_text));
    assert.ok(questions.every((question) => question.solution_text));
    // Diagrams resolve to cached blobs, not remote CDN URLs.
    const markup = JSON.stringify(questions);
    assert.ok(!markup.includes("examgoal.net"));
    assert.ok(markup.includes("blob:"));
  } finally {
    restoreOffline();
    fake.restore();
  }
});

test("results and resume work offline from the cached paper", async (t) => {
  if (typeof DecompressionStream === "undefined") {
    t.skip("DecompressionStream is unavailable");
    return;
  }
  const fake = installFakeIndexedDb();
  const restoreFetch = withOfflineNetwork();
  let questions;
  try {
    const selected = archivedPaper();
    await downloadExactPaperOffline({
      paperSource: selected,
      exam: "JEE_Main",
      paper: selected,
      loadQuestions: (exam, paper) =>
        loadExactPaperQuestions(exam, paper, { useCache: false }),
      deps: { indexedDB: fake.indexedDB, fetchImpl: imageFetch() },
    });
    questions = await loadExactPaperQuestions("JEE_Main", selected);
  } finally {
    restoreFetch();
  }

  const selected = archivedPaper();
  const answers = {
    [questions[0].uid]: questions[0].correct_answer,
    [questions[1].uid]: "definitely-wrong",
  };
  const report = compactExactPaperTest({
    id: "t1",
    date: "2026-11-18T00:00:00.000Z",
    exam: "JEE_Main",
    title: selected.title,
    minutes: 180,
    exactPaperSource: selected,
    questions: questions.map((question) => ({
      ...question,
      userAnswer: answers[question.uid],
      isCorrect: null,
      timeSpentSeconds: 30,
    })),
  });
  // The stored report stays small: no HTML or MathJax is persisted.
  assert.ok(JSON.stringify(report).length < JSON.stringify({ questions }).length / 4);

  const draft = {
    id: "draft-1",
    exam: "JEE_Main",
    title: selected.title,
    exactPaperSource: selected,
    questionRefs: questions.slice(0, 5).map((question) => ({
      uid: question.uid,
      question_id: question.question_id,
      subject: question.subject,
      chapter: question.chapter,
    })),
    answers: { [questions[0].uid]: questions[0].correct_answer },
    questionTimes: { [questions[0].uid]: 42 },
  };

  const restoreOffline = withNoNetwork();
  forgetInMemoryArchives();
  try {
    const restoredReport = await restoreExactPaperTest(report);
    assert.equal(restoredReport.questions.length, 71);
    assert.equal(
      restoredReport.questions[0].userAnswer,
      questions[0].correct_answer,
    );
    assert.equal(restoredReport.questions[1].userAnswer, "definitely-wrong");
    assert.ok(restoredReport.questions.every((question) => question.solution_text));
    assert.ok(restoredReport.questions[0].question_text.length > 0);

    const restoredDraft = await restoreExactPaperSession(draft);
    // The full paper is restored (the session can navigate it), with the
    // draft's answers and timings re-attached by uid.
    assert.equal(restoredDraft.length, questions.length);
    assert.equal(restoredDraft[0].userAnswer, questions[0].correct_answer);
    assert.equal(restoredDraft[0].timeSpentSeconds, 42);
    assert.equal(restoredDraft[2].userAnswer, undefined);
    assert.ok(restoredDraft[0].question_text.length > 0);
  } finally {
    restoreOffline();
    fake.restore();
  }
});

test("without an offline copy the loader still needs the archive", async (t) => {
  if (typeof DecompressionStream === "undefined") {
    t.skip("DecompressionStream is unavailable");
    return;
  }
  const fake = installFakeIndexedDb();
  // A year that no other test has loaded, so no in-memory year cache helps.
  const uncached = normalizePaperCatalog(catalog.exams.JEE_Main).find(
    (entry) => entry.archiveFile === "jee-main-2019.json",
  );
  assert.ok(uncached);
  const restoreOffline = withNoNetwork();
  try {
    forgetInMemoryArchives();
    await assert.rejects(
      () => loadExactPaperQuestions("JEE_Main", uncached),
      /fetch|offline|network|archive/i,
    );
  } finally {
    restoreOffline();
    fake.restore();
  }
});
