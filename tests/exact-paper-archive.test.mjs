import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import {
  archiveJson,
  exactPaperYearJson,
  JEE_MAIN_ARCHIVE_URL,
} from "../assets/experience.mjs";
import {
  availablePaperYears,
  compactExactPaperTest,
  installExactPaperMathDefs,
  loadExactPaperQuestions,
  loadPaperCatalog,
  normalizeArchivePaperQuestions,
  normalizePaperCatalog,
  papersForYear,
  restoreExactPaperSession,
  restoreExactPaperTest,
} from "../assets/exact-paper.mjs";

const ARCHIVE_NAME = "jee-main-papers-by-year.zip";
const catalog = JSON.parse(
  readFileSync(new URL("../data/exact-papers.json", import.meta.url), "utf8"),
);
const legacyIndex = JSON.parse(
  readFileSync(new URL("../data/papers.json", import.meta.url), "utf8"),
);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries, deflate = false) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const payload = deflate ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const method = deflate ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([localHeader, nameBytes, payload]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([centralHeader, nameBytes]));
    offset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const endOfDirectory = Buffer.alloc(22);
  endOfDirectory.writeUInt32LE(0x06054b50, 0);
  endOfDirectory.writeUInt16LE(0, 4);
  endOfDirectory.writeUInt16LE(0, 6);
  endOfDirectory.writeUInt16LE(entries.length, 8);
  endOfDirectory.writeUInt16LE(entries.length, 10);
  endOfDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfDirectory.writeUInt32LE(offset, 16);
  endOfDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localRecords, centralDirectory, endOfDirectory]);
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

function fetchResponse(buffer) {
  return {
    ok: true,
    arrayBuffer: async () => toArrayBuffer(buffer),
    json: async () => JSON.parse(buffer.toString("utf8")),
  };
}

function withFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = String(url);
    const route = routes[key] || routes.default;
    return route ? route(key) : { ok: false };
  };
  return () => {
    globalThis.fetch = original;
  };
}

function makeSourceQuestion(overrides = {}) {
  const options = ["A", "B", "C", "D"].map((label) => ({
    label,
    html: `<p>Option ${label}</p>`,
    correct: false,
  }));
  return {
    position: 1,
    subject: "Chemistry",
    subjectNumber: 1,
    sourceId: "source-1",
    type: "mcq",
    typeLabel: "MCQ (Single Correct Answer)",
    marks: { correct: 4, wrong: -1 },
    questionHtml: "<p>Question</p>",
    solutionHtml: "<p>Solution</p>",
    options,
    correctOptions: [2],
    answerKey: "C",
    answerSource: "api",
    tags: ["MCQ (Single Correct Answer)"],
    sourceUrl: "https://example.invalid/question",
    ...overrides,
  };
}

const paper = {
  id: "test-paper",
  slug: "test-paper",
  title: "JEE Main 2026 (Online) Test Paper",
  year: 2026,
  questionCount: 4,
  archiveFile: "jee-main-2026.json",
  source: ARCHIVE_NAME,
};

const yearData = {
  mathjaxDefs: '<path id="MJX-TEST" d="M0 0"></path>',
  papers: [
    {
      slug: "test-paper",
      title: paper.title,
      year: 2026,
      questions: [
        makeSourceQuestion({
          position: 3,
          subject: "Chemistry",
          sourceId: "chem-key-letter",
          questionHtml: "<p>Q3</p>",
          solutionHtml: "<p>S3</p>",
        }),
        makeSourceQuestion({
          position: 1,
          subject: "Mathematics",
          sourceId: "math-range",
          type: "integer",
          typeLabel: "Numerical Value",
          questionHtml: "<p>Q1</p>",
          solutionHtml: "<p>S1</p>",
          options: [],
          correctOptions: [],
          answerKey: "18TO24",
        }),
        makeSourceQuestion({
          position: 2,
          subject: "Physics",
          sourceId: "physics-dropped",
          questionHtml: "<p>Q2</p>",
          solutionHtml: "<p>S2</p>",
          options: ["A", "B", "C", "D"].map((label) => ({
            label,
            html: `<p>Option ${label}</p>`,
            correct: true,
          })),
          correctOptions: [0, 1, 2, 3],
          answerKey: "A, B, C, D",
          tags: ["MCQ (Single Correct Answer)", "Dropped (all options accepted)"],
        }),
        makeSourceQuestion({
          position: 4,
          subject: "Chemistry",
          sourceId: "chem-index-key",
          questionHtml: "<p>Q4</p>",
          solutionHtml: "<p>S4</p>",
          answerKey: "1",
          correctOptions: [3],
        }),
      ],
    },
  ],
};

function fakeElement(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    attributes: {},
    children: [],
    style: {},
    html: "",
    parsedPaths: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
    },
    querySelectorAll(selector) {
      return selector === "path" ? this.parsedPaths : [];
    },
    set innerHTML(value) {
      this.html = value;
      this.parsedPaths = [...value.matchAll(/<path\s+id="([^"]+)"\s+d="([^"]+)"[^>]*><\/path>/g)].map(
        (match) => ({
          getAttribute: (name) =>
            name === "id" ? match[1] : name === "d" ? match[2] : null,
        }),
      );
    },
    get firstChild() {
      return this.children[0] || null;
    },
  };
  return node;
}

function fakeDocument() {
  const byId = new Map();
  const doc = {
    body: fakeElement("body"),
    documentElement: fakeElement("html"),
    defaultView: null,
    createElement: (tag) => fakeElement(tag),
    createElementNS: (_namespace, tag) => fakeElement(tag),
    getElementById: (id) => byId.get(id) || null,
  };
  const appendChild = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = (child) => {
    const id = child.getAttribute("id");
    if (id) byId.set(id, child);
    return appendChild(child);
  };
  return doc;
}

test("archiveJson reads stored and deflated ZIP members", async (t) => {
  if (typeof DecompressionStream === "undefined") {
    t.skip("DecompressionStream is unavailable");
    return;
  }
  const stored = makeZip([["stored.json", '{"kind":"stored"}']]);
  const deflated = makeZip(
    [["deflated.json", '{"kind":"deflated"}']],
    true,
  );
  const restore = withFetch({
    "/stored.zip": () => fetchResponse(stored),
    "/deflated.zip": () => fetchResponse(deflated),
  });
  try {
    assert.deepEqual(await archiveJson("/stored.zip", "stored.json"), {
      kind: "stored",
    });
    assert.deepEqual(await archiveJson("/deflated.zip", "deflated.json"), {
      kind: "deflated",
    });
  } finally {
    restore();
  }
});

test("exactPaperYearJson reads a real year file from the checked-in ZIP", async (t) => {
  if (typeof DecompressionStream === "undefined") {
    t.skip("DecompressionStream is unavailable");
    return;
  }
  const realZip = readFileSync(
    new URL("../jee-main-papers-by-year.zip", import.meta.url),
  );
  const restore = withFetch({
    default: (url) =>
      url.startsWith("/data/exact-papers/")
        ? { ok: false }
        : fetchResponse(realZip),
  });
  try {
    const year = await exactPaperYearJson("jee-main-2018.json");
    assert.equal(year.papers.length, 4);
    assert.equal(year.papers[0].questions.length, 71);
    assert.ok(year.mathjaxDefs.includes("MJX-TEX"));
  } finally {
    restore();
  }
  assert.equal(JEE_MAIN_ARCHIVE_URL, "/jee-main-papers-by-year.zip");
});

test("generated catalog covers every archive paper with solutions and source order metadata", () => {
  const papers = normalizePaperCatalog(catalog.exams.JEE_Main);
  const archiveFiles = new Set(catalog.archiveFiles.map((entry) => entry.name));
  assert.equal(papers.length, 192);
  assert.deepEqual(availablePaperYears(papers).slice(0, 2), ["2026", "2025"]);
  const first2026 = papersForYear(papers, 2026)[0];
  assert.match(first2026.title, /21st January Morning Shift/);
  assert.equal(first2026.sessionOrder, 1);
  for (const entry of papers) {
    assert.equal(entry.source, ARCHIVE_NAME);
    assert.ok(archiveFiles.has(entry.archiveFile));
    assert.equal(entry.solutionCount, entry.questionCount);
    assert.equal(
      Object.values(entry.subjects).reduce((sum, count) => sum + count, 0),
      entry.questionCount,
    );
  }
});

test("JEE Main selector uses archive papers for covered years and legacy papers for older years", async () => {
  const papers = await loadPaperCatalog("JEE_Main", {
    loadIndex: async (path) => {
      if (path === "exact-papers.json") return catalog;
      if (path === "papers.json") return legacyIndex;
      throw new Error(`Unexpected path: ${path}`);
    },
  });
  const years = availablePaperYears(papers);
  assert.ok(years.includes("2026"));
  assert.ok(years.includes("2002"));
  assert.equal(papers.filter((entry) => entry.year === "2026").length, 19);
  assert.equal(
    papers.filter(
      (entry) => entry.year === "2026" && entry.source === ARCHIVE_NAME,
    ).length,
    19,
  );
  assert.equal(papers.filter((entry) => entry.year === "2002").length, 1);
  assert.equal(papers.length, 204);
  assert.equal(papers.filter((entry) => entry.year === "2018").length, 5);
  assert.equal(
    papers.filter(
      (entry) => entry.year === "2018" && entry.source === ARCHIVE_NAME,
    ).length,
    4,
  );
});

test("archive normalization keeps source order, HTML, keys, solutions, and dropped questions", () => {
  const built = normalizeArchivePaperQuestions(yearData, paper, "JEE_Main", {
    installDefs: false,
  });
  assert.deepEqual(built.map((question) => question.paperPosition), [1, 2, 3, 4]);
  assert.deepEqual(built.map((question) => question.subject), [
    "math",
    "physics",
    "chemistry",
    "chemistry",
  ]);
  assert.equal(built[0].type, "numerical");
  assert.equal(built[0].correct_answer, "18TO24");
  assert.equal(built[0].answerRule.kind, "range");
  assert.equal(built[0].question_text, "<p>Q1</p>");
  assert.equal(built[0].solution_text, "<p>S1</p>");
  assert.equal(built[1].type, "multipleCorrect");
  assert.equal(built[1].bonus, true);
  assert.deepEqual(built[1].correct_answer, ["A", "B", "C", "D"]);
  assert.equal(built[2].correct_answer, "C");
  assert.equal(built[3].correct_answer, "D");
  assert.ok(built.every((question) => question.source === ARCHIVE_NAME));
  assert.ok(built.every((question) => question.paperSource.archiveFile === "jee-main-2026.json"));
  assert.equal(new Set(built.map((question) => question.uid)).size, 4);
});

test("MathJax path definitions are installed once in a hidden SVG host", () => {
  const doc = fakeDocument();
  assert.equal(
    installExactPaperMathDefs(yearData.mathjaxDefs, "jee-main-2026.json", doc),
    true,
  );
  const host = doc.getElementById("exact-paper-mathjax-defs");
  assert.ok(host);
  assert.equal(host.getAttribute("data-source"), "jee-main-2026.json");
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].children.length, 1);
  assert.equal(host.children[0].children[0].getAttribute("id"), "MJX-TEST");
  assert.equal(
    installExactPaperMathDefs(yearData.mathjaxDefs, "jee-main-2026.json", doc),
    true,
  );
});

test("compact exact-paper test records rehydrate from the ZIP without storing HTML", async () => {
  const built = normalizeArchivePaperQuestions(yearData, paper, "JEE_Main", {
    installDefs: false,
  });
  const record = {
    id: "test-1",
    title: paper.title,
    exactPaperSource: built[0].paperSource,
    questions: built.map((question, index) => ({
      ...question,
      userAnswer: index === 0 ? "21" : "A",
      isCorrect: index === 0,
      timeSpentSeconds: 10 + index,
    })),
  };
  const compact = compactExactPaperTest(record);
  assert.equal(compact.questions.length, 4);
  assert.ok(!JSON.stringify(compact).includes("<p>Q1</p>"));
  assert.ok(!JSON.stringify(compact).includes("<p>S1</p>"));
  assert.equal(compact.questions[0].userAnswer, "21");
  assert.equal(compact.questions[0].timeSpentSeconds, 10);

  const restored = await restoreExactPaperTest(compact, async () => built);
  assert.equal(restored.questions[0].question_text, "<p>Q1</p>");
  assert.equal(restored.questions[0].solution_text, "<p>S1</p>");
  assert.equal(restored.questions[0].userAnswer, "21");
  assert.equal(restored.questions[0].timeSpentSeconds, 10);
  assert.equal(restored.questions[1].userAnswer, "A");

  const draft = {
    exactPaperSource: built[0].paperSource,
    questionRefs: built.map((question) => ({ uid: question.uid })),
    answers: { [built[0].uid]: "21" },
    questionTimes: { [built[0].uid]: 12 },
  };
  const resumed = await restoreExactPaperSession(draft, async () => built);
  assert.equal(resumed.length, 4);
  assert.equal(resumed[0].userAnswer, "21");
  assert.equal(resumed[0].timeSpentSeconds, 12);
  assert.equal(resumed[1].userAnswer, undefined);
});

test("a real archived paper loads with complete solutions and source positions", async (t) => {
  if (typeof DecompressionStream === "undefined") {
    t.skip("DecompressionStream is unavailable");
    return;
  }
  const realZip = readFileSync(
    new URL("../jee-main-papers-by-year.zip", import.meta.url),
  );
  const selected = normalizePaperCatalog(catalog.exams.JEE_Main).find(
    (entry) => entry.slug === "jee-main-2018-offline",
  );
  assert.ok(selected);
  const restore = withFetch({
    default: (url) =>
      url.startsWith("/data/exact-papers/")
        ? { ok: false }
        : fetchResponse(realZip),
  });
  try {
    const questions = await loadExactPaperQuestions("JEE_Main", selected);
    assert.equal(questions.length, 71);
    assert.deepEqual(
      questions.map((question) => question.paperPosition),
      Array.from({ length: 71 }, (_, index) => index + 1),
    );
    assert.equal(questions[0].subject, "chemistry");
    assert.equal(questions[0].paper_year_title, selected.title);
    assert.ok(questions.every((question) => question.question_text));
    assert.ok(questions.every((question) => question.solution_text));
    assert.ok(questions.every((question) => question.source === ARCHIVE_NAME));
  } finally {
    restore();
  }
});
