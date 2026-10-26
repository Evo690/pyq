import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeAttempt,
  buildPaperQuestions,
  formatClock,
  formatDuration,
  normalizePaper,
  normalizePaperCatalog,
  numericalMatches,
  paperKey,
  paperSections,
  scoreQuestion,
} from "../app/core.js";

const PAPER = "JEE Main 2025 (22 January Shift 1)";

function raw(id, type, paper = PAPER, extra = {}) {
  return {
    question_id: id,
    type,
    difficulty_level: 2,
    paper_year_title: paper,
    question_text: `Question ${id}`,
    options:
      type === "numerical"
        ? []
        : [
            { id: "a", text: "A" },
            { id: "b", text: "B" },
            { id: "c", text: "C" },
            { id: "d", text: "D" },
          ],
    correct_answer: type === "numerical" ? "12" : "b",
    solution_text: "Because.",
    ...extra,
  };
}

test("a paper loads subject by subject, MCQs before numericals", () => {
  const groups = [
    { subject: "math", chapter: "Limits", questions: [raw("m1", "singleCorrect"), raw("m2", "numerical")] },
    { subject: "physics", chapter: "Gravitation", questions: [raw("p1", "numerical"), raw("p2", "singleCorrect")] },
    { subject: "chemistry", chapter: "Amines", questions: [raw("c1", "singleCorrect"), raw("c2", "numerical")] },
  ];
  const paper = { title: PAPER };
  const ordered = buildPaperQuestions(groups, "JEE_Main", paper);

  assert.deepEqual(
    ordered.map((question) => question.id),
    ["p2", "p1", "c1", "c2", "m1", "m2"],
  );
  assert.deepEqual(
    paperSections(ordered).map((section) => `${section.subject}:${section.type}`),
    [
      "physics:singleCorrect",
      "physics:numerical",
      "chemistry:singleCorrect",
      "chemistry:numerical",
      "math:singleCorrect",
      "math:numerical",
    ],
  );
});

test("multiple-correct items sit between MCQ and numerical", () => {
  const groups = [
    {
      subject: "chemistry",
      chapter: "Bonding",
      questions: [raw("n1", "numerical"), raw("m1", "multipleCorrect"), raw("s1", "singleCorrect")],
    },
  ];
  const ordered = buildPaperQuestions(groups, "JEE_Advanced", { title: PAPER });
  assert.deepEqual(
    ordered.map((question) => question.type),
    ["singleCorrect", "multipleCorrect", "numerical"],
  );
});

test("only questions from the selected paper are taken, once each", () => {
  const groups = [
    {
      subject: "physics",
      chapter: "Optics",
      questions: [raw("x1", "singleCorrect"), raw("x2", "singleCorrect", "JEE Main 2024 (27 January Shift 1)")],
    },
    { subject: "physics", chapter: "Waves", questions: [raw("x1", "singleCorrect"), raw("x3", "singleCorrect")] },
  ];
  const ordered = buildPaperQuestions(groups, "JEE_Main", { title: PAPER });
  assert.deepEqual(
    ordered.map((question) => question.id),
    ["x1", "x3"],
  );
});

test("catalog normalization keeps real papers, newest first", () => {
  const index = {
    exams: {
      JEE_Main: {
        chapters: [],
        papers: [
          { title: "JEE Main 2019 (9 April Shift 1)", year: 2019, questionCount: 90, sources: [] },
          { title: "JEE Main 2025 (22 January Shift 1)", year: 2025, questionCount: 75, sources: [], subjects: { physics: 25, chemistry: 25, math: 25 } },
          { title: "Unusable paper", year: 2025, questionCount: 0 },
          { title: "" },
        ],
      },
    },
  };
  const catalog = normalizePaperCatalog("JEE_Main", index);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].year, "2025");
  assert.equal(catalog[0].subjects.math, 25);
  assert.equal(catalog[1].year, "2019");
  assert.equal(normalizePaper({ title: PAPER }, "JEE_Main").key, `${paperKey("JEE_Main", PAPER)}`.trim());
});

test("scoring follows +4 / −1 and tolerates numerical decimals", () => {
  const single = { type: "singleCorrect", answer: "b", options: [] };
  assert.deepEqual(scoreQuestion(single, "b"), { ...scoreQuestion(single, "b"), status: "correct", marks: 4 });
  assert.equal(scoreQuestion(single, "c").marks, -1);
  assert.equal(scoreQuestion(single, undefined).status, "skipped");
  assert.equal(scoreQuestion(single, "").marks, 0);

  const numerical = { type: "numerical", answer: "12", options: [] };
  assert.equal(scoreQuestion(numerical, "12").marks, 4);
  assert.equal(scoreQuestion(numerical, "12.0").status, "correct");
  assert.equal(scoreQuestion(numerical, "-0.5").status, "incorrect");
  assert.ok(numericalMatches("10553.14", "10553.14"));
  assert.ok(!numericalMatches("10553", "10553.14"));
});

test("multiple-correct marking awards partial credit and penalises wrong options", () => {
  const question = { type: "multipleCorrect", answer: "a,c", options: [] };
  const full = scoreQuestion(question, ["a", "c"]);
  assert.equal(full.status, "correct");
  assert.equal(full.marks, 4);

  const partial = scoreQuestion(question, ["a"]);
  assert.equal(partial.status, "partial");
  assert.equal(partial.marks, 1);

  const wrong = scoreQuestion(question, ["a", "d"]);
  assert.equal(wrong.status, "incorrect");
  assert.equal(wrong.marks, -2);
});

test("analysis totals, subject order and weakest-first chapters", () => {
  const questions = buildPaperQuestions(
    [
      {
        subject: "physics",
        chapter: "Optics",
        questions: [raw("p1", "singleCorrect"), raw("p2", "singleCorrect")],
      },
      { subject: "chemistry", chapter: "Amines", questions: [raw("c1", "singleCorrect")] },
      { subject: "math", chapter: "Limits", questions: [raw("m1", "numerical")] },
    ],
    "JEE_Main",
    { title: PAPER },
  );

  const attempt = {
    id: "a1",
    title: PAPER,
    mode: "paper",
    allowedSeconds: 10800,
    timeUsed: 600,
    questions,
    answers: { [questions[0].uid]: "b", [questions[1].uid]: "a", [questions[2].uid]: "b" },
    times: { [questions[0].uid]: 40, [questions[1].uid]: 200, [questions[2].uid]: 60 },
  };

  const analysis = analyzeAttempt(attempt, 0);
  assert.equal(analysis.totals.total, 4);
  assert.equal(analysis.totals.attempted, 3);
  assert.equal(analysis.totals.correct, 2);
  assert.equal(analysis.totals.incorrect, 1);
  assert.equal(analysis.totals.skipped, 1);
  assert.equal(analysis.totals.score, 7);
  assert.equal(analysis.totals.max, 16);

  assert.deepEqual(
    analysis.bySubject.map((subject) => subject.label),
    ["Physics", "Chemistry", "Mathematics"],
  );
  assert.equal(analysis.bySubject[0].accuracy, 0.5);
  assert.equal(analysis.byChapter[0].chapter, "Optics");
  assert.ok(analysis.rows[0].index === 1);
  assert.equal(analysis.rows[0].status, "correct");
  assert.equal(analysis.slowest[0].index, 2);
  assert.ok(analysis.insights.length > 0);
});

test("duration formatting stays human", () => {
  assert.equal(formatClock(59), "0:59");
  assert.equal(formatClock(3600 + 61), "1:01:01");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(600), "10m");
  assert.equal(formatDuration(3720), "1h 2m");
});
