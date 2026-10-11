import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptivePracticeQuestions,
  analyzeTest,
  dueReviewEntries,
  pickQuestions,
  scheduleReview,
  topicInsights,
  topicPerformance,
} from "../assets/experience.mjs";

const questions = Array.from({ length: 12 }, (_, index) => ({
  uid: `q-${index}`,
  subject: "physics",
  chapter: "Mechanics",
  topic: index < 6 ? "Motion" : "Energy",
  difficulty_level: (index % 3) + 1,
}));

test("question sampling picks fresh questions first and stays unique", () => {
  const seenQuestions = Object.fromEntries(
    questions.slice(0, 6).map((question, index) => [
      question.uid,
      new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    ]),
  );

  const selected = pickQuestions(questions, 5, { seenQuestions });
  assert.equal(selected.length, 5);
  assert.equal(new Set(selected.map((question) => question.uid)).size, 5);
  assert.ok(selected.every((question) => !seenQuestions[question.uid]));
});

test("when the fresh pool is too small, sampling reuses the oldest questions", () => {
  const seenQuestions = Object.fromEntries(
    questions.slice(0, 10).map((question, index) => [
      question.uid,
      new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    ]),
  );

  const selected = pickQuestions(questions, 5, { seenQuestions });
  const ids = selected.map((question) => question.uid);
  assert.equal(new Set(ids).size, 5);
  assert.ok(ids.includes("q-10") && ids.includes("q-11"));
  assert.ok(ids.includes("q-0") && ids.includes("q-1"));
});

test("completed test history is respected even before the seen ledger is populated", () => {
  const selected = pickQuestions(questions, 4, {
    tests: [{ date: "2025-01-01T00:00:00.000Z", questions: questions.slice(0, 5) }],
  });
  assert.equal(selected.length, 4);
  assert.ok(selected.every((question) => Number(question.uid.slice(2)) >= 5));
});

test("sampling balances topics across a mixed question bank", () => {
  const selected = pickQuestions(questions, 6);
  const topicCounts = selected.reduce((counts, question) => {
    counts[question.topic] = (counts[question.topic] || 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(topicCounts, { Motion: 3, Energy: 3 });
});

test("topic insights use recent scored answers and require a signal", () => {
  const attemptHistory = [false, false, true].map((correct, index) => ({
    uid: `weak-${index}`,
    exam: "JEE_Main",
    subject: "math",
    chapter: "Calculus",
    topic: "Limits",
    correct,
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
  }));
  attemptHistory.push(
    {
      uid: "early-1",
      exam: "JEE_Main",
      subject: "physics",
      chapter: "Mechanics",
      topic: "Energy",
      correct: false,
      date: "2025-02-01T00:00:00.000Z",
    },
    {
      uid: "early-2",
      exam: "JEE_Main",
      subject: "physics",
      chapter: "Mechanics",
      topic: "Energy",
      correct: false,
      date: "2025-02-02T00:00:00.000Z",
    },
  );

  assert.deepEqual(topicInsights({ attemptHistory, attempts: {} }, "JEE_Main"), [
    {
      subject: "math",
      chapter: "Calculus",
      topic: "Limits",
      attempts: 3,
      correct: 1,
      accuracy: 33,
      trend: null,
    },
  ]);
});

test("spaced review waits a day after a miss and widens after success", () => {
  const now = Date.UTC(2025, 0, 1);
  const first = scheduleReview(undefined, true, now);
  const second = scheduleReview(first, true, now + 86_400_000);
  const lapse = scheduleReview(second, false, now + 4 * 86_400_000);

  assert.equal(first.intervalDays, 1);
  assert.equal(second.intervalDays, 3);
  assert.equal(lapse.intervalDays, 1);
  assert.equal(lapse.repetitions, 0);
  assert.equal(new Date(lapse.dueAt).getTime(), now + 5 * 86_400_000);
});

test("due reviews are ordered by due time and scoped to the selected exam", () => {
  const store = {
    reviewQueue: {
      later: { uid: "later", exam: "JEE_Main", dueAt: "2025-01-03T00:00:00.000Z" },
      earlier: { uid: "earlier", exam: "JEE_Main", dueAt: "2025-01-01T00:00:00.000Z" },
      otherExam: { uid: "other", exam: "JEE_Advanced", dueAt: "2025-01-01T00:00:00.000Z" },
    },
  };
  assert.deepEqual(
    dueReviewEntries(store, "JEE_Main", Date.UTC(2025, 0, 4)).map((entry) => entry.uid),
    ["earlier", "later"],
  );
});

test("adaptive practice prioritizes due reviews and remains unique", () => {
  const bank = questions.map((question) => ({ ...question, exam: "JEE_Main" }));
  const reviewQueue = Object.fromEntries(
    bank.slice(0, 4).map((question) => [
      question.uid,
      { uid: question.uid, exam: "JEE_Main", dueAt: "2024-01-01T00:00:00.000Z" },
    ]),
  );
  const selected = adaptivePracticeQuestions(bank, 8, { reviewQueue });
  const ids = selected.map((question) => question.uid);
  assert.equal(selected.length, 8);
  assert.equal(new Set(ids).size, 8);
  assert.ok(ids.filter((uid) => uid.startsWith("q-") && Number(uid.slice(2)) < 4).length >= 3);
});

test("chapter-focused adaptive practice prioritizes recent due questions too", () => {
  const bank = [
    { ...questions[0], uid: "due-2019", exam: "JEE_Main", paper_year_short: "2019" },
    { ...questions[1], uid: "due-2021", exam: "JEE_Main", paper_year_short: "2021" },
    { ...questions[2], uid: "due-2022", exam: "JEE_Main", paper_year_short: "2022" },
    { ...questions[3], uid: "due-2023", exam: "JEE_Main", paper_year_short: "2023" },
    { ...questions[4], uid: "due-2024", exam: "JEE_Main", paper_year_short: "2024" },
    { ...questions[5], uid: "general", exam: "JEE_Main", paper_year_short: "2024" },
  ];
  const reviewQueue = Object.fromEntries(
    bank.slice(0, 5).map((question) => [
      question.uid,
      { uid: question.uid, exam: "JEE_Main", dueAt: "2024-01-01T00:00:00.000Z" },
    ]),
  );

  const selected = adaptivePracticeQuestions(
    bank,
    3,
    { reviewQueue },
    { prioritizeRecentYears: true },
  );
  const dueSelected = selected
    .filter((question) => reviewQueue[question.uid])
    .map((question) => question.uid);

  assert.equal(dueSelected.length, 2);
  assert.deepEqual(dueSelected.sort(), ["due-2023", "due-2024"]);
});

test("topic performance reports recent accuracy trend", () => {
  const attemptHistory = Array.from({ length: 10 }, (_, index) => ({
    uid: `trend-${index}`,
    exam: "JEE_Main",
    subject: "physics",
    chapter: "Mechanics",
    topic: "Energy",
    correct: index >= 5,
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
  }));
  const [metric] = topicPerformance({ attemptHistory, attempts: {} }, "JEE_Main");
  assert.equal(metric.attempts, 10);
  assert.equal(metric.accuracy, 50);
  assert.equal(metric.trend, 100);
});

test("custom-test analytics summarizes difficulty, topic, timing, and each response", () => {
  const report = analyzeTest({
    score: 7,
    seconds: 73,
    questions: [
      {
        uid: "easy-right",
        subject: "physics",
        chapter: "Mechanics",
        topic: "Motion",
        difficulty_level: 1,
        userAnswer: "A",
        isCorrect: true,
        timeSpentSeconds: 15,
      },
      {
        uid: "easy-wrong",
        subject: "physics",
        chapter: "Mechanics",
        topic: "Motion",
        difficulty_level: 1,
        userAnswer: "B",
        isCorrect: false,
        timeSpentSeconds: 20,
      },
      {
        uid: "medium-right",
        subject: "physics",
        chapter: "Mechanics",
        topic: "Energy",
        difficulty_level: 2,
        userAnswer: "C",
        isCorrect: true,
        timeSpentSeconds: 30,
      },
      {
        uid: "hard-skipped",
        subject: "physics",
        chapter: "Mechanics",
        topic: "Energy",
        difficulty_level: 3,
        timeSpentSeconds: 8,
      },
    ],
  });

  assert.deepEqual(
    {
      total: report.total,
      attempted: report.attempted,
      correct: report.correct,
      incorrect: report.incorrect,
      skipped: report.skipped,
      accuracy: report.accuracy,
      score: report.score,
      averageSecondsPerAttempt: report.averageSecondsPerAttempt,
    },
    {
      total: 4,
      attempted: 3,
      correct: 2,
      incorrect: 1,
      skipped: 1,
      accuracy: 67,
      score: 7,
      averageSecondsPerAttempt: 22,
    },
  );
  assert.deepEqual(
    report.difficulty.map(({ label, total, correct, incorrect, skipped, accuracy }) => ({
      label,
      total,
      correct,
      incorrect,
      skipped,
      accuracy,
    })),
    [
      { label: "Easy", total: 2, correct: 1, incorrect: 1, skipped: 0, accuracy: 50 },
      { label: "Medium", total: 1, correct: 1, incorrect: 0, skipped: 0, accuracy: 100 },
      { label: "Hard", total: 1, correct: 0, incorrect: 0, skipped: 1, accuracy: 0 },
    ],
  );
  assert.equal(report.questions[1].status, "incorrect");
  assert.equal(report.questions[3].status, "skipped");
  assert.equal(report.halves.delta, 50);
});

test("custom-test reports can recompute historical answers without timing metadata", () => {
  const report = analyzeTest({
    questions: [
      {
        uid: "legacy-choice",
        type: "singleCorrect",
        difficulty_level: 1,
        correct_answer: "A",
        options: [{ id: "A", text: "First" }, { id: "B", text: "Second" }],
        userAnswer: "B",
      },
      {
        uid: "legacy-number",
        type: "numerical",
        difficulty_level: 3,
        correct_answer: "2",
        userAnswer: "2.0000001",
      },
    ],
  });

  assert.deepEqual(report.questions.map(({ status }) => status), ["incorrect", "correct"]);
  assert.equal(report.score, 3);
  assert.equal(report.accuracy, 50);
  assert.equal(report.averageSecondsPerAttempt, null);
});

test("chapter sampling prefers recent years while staying randomized within a year", () => {
  const chapterQuestions = [
    { ...questions[0], uid: "year-2019", paper_year_short: "2019" },
    { ...questions[1], uid: "year-2022", paper_year_short: "2022" },
    { ...questions[2], uid: "year-2023-a", paper_year_short: "2023" },
    { ...questions[3], uid: "year-2023-b", paper_year_short: "2023" },
    { ...questions[4], uid: "year-2024", paper_year_short: "2024" },
  ];

  const selected = pickQuestions(chapterQuestions, 2, {}, { prioritizeRecentYears: true });
  assert.deepEqual(
    selected.map((question) => question.paper_year_short).sort(),
    ["2023", "2024"],
  );
  assert.equal(new Set(selected.map((question) => question.uid)).size, 2);
});
