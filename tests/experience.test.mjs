import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  adaptivePracticeQuestions,
  analyzeTest,
  dueReviewEntries,
  isCorrectAnswer,
  isScoreableQuestion,
  parseNumericalAnswerKey,
  pickQuestions,
  scheduleReview,
  topicInsights,
  topicPerformance,
} from "../assets/experience.mjs";
import {
  availablePaperYears,
  buildExactPaperQuestions,
  normalizePaperCatalog,
  papersForYear,
} from "../assets/exact-paper.mjs";
import { TestAnalysisScreen } from "../assets/test-analysis.mjs";

const questions = Array.from({ length: 12 }, (_, index) => ({
  uid: `q-${index}`,
  subject: "physics",
  chapter: "Mechanics",
  topic: index < 6 ? "Motion" : "Energy",
  difficulty_level: (index % 3) + 1,
}));

const paperIndex = JSON.parse(
  readFileSync(new URL("../data/papers.json", import.meta.url), "utf8"),
);

test("checked-in exact-paper index resolves sources and subject totals", () => {
  for (const exam of ["JEE_Main", "JEE_Advanced"]) {
    const examIndex = paperIndex.exams[exam];
    const chapterFiles = new Set(
      examIndex.chapters.map((chapter) => chapter.file),
    );
    const catalog = normalizePaperCatalog(examIndex);
    assert.ok(catalog.length > 0);
    assert.ok(availablePaperYears(catalog).length > 0);
    for (const paper of catalog) {
      assert.ok(paper.sources.length > 0, paper.title);
      assert.ok(
        paper.sources.every((source) => chapterFiles.has(source?.file)),
        paper.title,
      );
      assert.equal(
        Object.values(paper.subjects).reduce((sum, count) => sum + count, 0),
        paper.questionCount,
        paper.title,
      );
    }
  }
});

test("exact-paper catalog exposes only available years and their sessions", () => {
  const catalog = {
    chapters: [
      {
        subject: "physics",
        chapter: "Mechanics",
        file: "Physics/Mechanics.json",
      },
    ],
    papers: [
      {
        title: "JEE Main 2025 (22 Jan Shift 1)",
        year: 2025,
        label: "22 Jan Shift 1",
        date: "2025-01-22T09:00:00.000Z",
        questionCount: 2,
        sources: [0],
      },
      {
        title: "JEE Main 2024 (27 Jan Shift 2)",
        year: 2024,
        label: "27 Jan Shift 2",
        date: "2024-01-27T14:00:00.000Z",
        questionCount: 3,
        sources: [0],
      },
      {
        title: "JEE Main 2024 (27 Jan Shift 1)",
        year: 2024,
        label: "27 Jan Shift 1",
        date: "2024-01-27T09:00:00.000Z",
        questionCount: 3,
        sources: [0],
      },
    ],
  };

  const normalized = normalizePaperCatalog(catalog);
  assert.deepEqual(availablePaperYears(normalized), ["2025", "2024"]);
  assert.deepEqual(
    papersForYear(normalized, 2024).map((paper) => paper.label),
    ["27 Jan Shift 1", "27 Jan Shift 2"],
  );
  assert.equal(normalized[0].sources[0].file, "Physics/Mechanics.json");
});

test("exact-paper assembly keeps every matching question in stable subject order", () => {
  const title = "JEE Advanced 2024 (Paper 1)";
  const groups = [
    {
      subject: "math",
      chapter: "Calculus",
      questions: [{ question_id: "math-1", paper_year_title: title }],
    },
    {
      subject: "physics",
      chapter: "Mechanics",
      questions: [
        { question_id: "physics-1", paper_year_title: title },
        {
          question_id: "physics-2",
          paper_year_title: "JEE Advanced 2023 (Paper 1)",
        },
      ],
    },
    {
      subject: "chemistry",
      chapter: "Equilibrium",
      questions: [{ question_id: "chemistry-1", paper_year_title: title }],
    },
    {
      subject: "physics",
      chapter: "Optics",
      questions: [{ question_id: "physics-1", paper_year_title: title }],
    },
  ];

  const paperQuestions = buildExactPaperQuestions(groups, "JEE_Advanced", {
    title,
  });
  assert.deepEqual(
    paperQuestions.map((question) => question.question_id),
    ["physics-1", "chemistry-1", "math-1"],
  );
  assert.ok(
    paperQuestions.every((question) => question.exam === "JEE_Advanced"),
  );
  assert.ok(
    paperQuestions.every((question) =>
      question.uid.startsWith("JEE_Advanced:"),
    ),
  );
  assert.equal(new Set(paperQuestions.map((question) => question.uid)).size, 3);
});

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

test("multiple-correct source-key items are reported as unscored rather than incorrect", () => {
  const report = analyzeTest({
    questions: [
      {
        uid: "multi",
        type: "multipleCorrect",
        userAnswer: ["A", "C"],
        correct_answer: "A",
      },
      {
        uid: "single-right",
        type: "singleCorrect",
        options: [{ id: "A" }],
        correct_answer: "A",
        userAnswer: "A",
      },
      {
        uid: "single-wrong",
        type: "singleCorrect",
        options: [{ id: "A" }, { id: "B" }],
        correct_answer: "A",
        userAnswer: "B",
      },
      { uid: "blank", type: "singleCorrect" },
    ],
  });

  assert.deepEqual(
    {
      total: report.total,
      scoreableTotal: report.scoreableTotal,
      attempted: report.attempted,
      correct: report.correct,
      incorrect: report.incorrect,
      skipped: report.skipped,
      unscored: report.unscored,
      accuracy: report.accuracy,
      score: report.score,
      multiStatus: report.questions[0].status,
    },
    {
      total: 4,
      scoreableTotal: 3,
      attempted: 2,
      correct: 1,
      incorrect: 1,
      skipped: 1,
      unscored: 1,
      accuracy: 50,
      score: 3,
      multiStatus: "unscored",
    },
  );
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

test("exact-paper assembly orders JEE sections as MCQs then numericals per subject", () => {
  const title = "JEE Main 2026 (21 January Shift 1)";
  const makeGroup = (subject, chapter, mcqCount, numCount, prefix) => ({
    subject,
    chapter,
    questions: [
      // Deliberately interleave numericals before MCQs in source input
      ...Array.from({ length: numCount }, (_, i) => ({
        question_id: `${prefix}-num-${String(i + 1).padStart(2, "0")}`,
        type: "numerical",
        paper_year_title: title,
      })),
      ...Array.from({ length: mcqCount }, (_, i) => ({
        question_id: `${prefix}-mcq-${String(i + 1).padStart(2, "0")}`,
        type: "singleCorrect",
        paper_year_title: title,
      })),
    ],
  });

  const groups = [
    makeGroup("math", "Calculus", 20, 5, "m"),
    makeGroup("chemistry", "Organic", 20, 5, "c"),
    makeGroup("physics", "Mechanics", 20, 5, "p"),
  ];

  const ordered = buildExactPaperQuestions(groups, "JEE_Main", { title });
  assert.equal(ordered.length, 75);

  const sliceSummary = (start, end) => {
    const slice = ordered.slice(start, end);
    return {
      subjects: [...new Set(slice.map((q) => q.subject))],
      types: [...new Set(slice.map((q) => q.type))],
      count: slice.length,
    };
  };

  assert.deepEqual(sliceSummary(0, 20), {
    subjects: ["physics"],
    types: ["singleCorrect"],
    count: 20,
  });
  assert.deepEqual(sliceSummary(20, 25), {
    subjects: ["physics"],
    types: ["numerical"],
    count: 5,
  });
  assert.deepEqual(sliceSummary(25, 45), {
    subjects: ["chemistry"],
    types: ["singleCorrect"],
    count: 20,
  });
  assert.deepEqual(sliceSummary(45, 50), {
    subjects: ["chemistry"],
    types: ["numerical"],
    count: 5,
  });
  assert.deepEqual(sliceSummary(50, 70), {
    subjects: ["math"],
    types: ["singleCorrect"],
    count: 20,
  });
  assert.deepEqual(sliceSummary(70, 75), {
    subjects: ["math"],
    types: ["numerical"],
    count: 5,
  });
});

test("real JEE Main 2026 exact paper from data/ builds 20 MCQ + 5 numerical per subject", () => {
  const examIndex = paperIndex.exams.JEE_Main;
  const catalog = normalizePaperCatalog(examIndex);
  const paper = catalog.find(
    (entry) => entry.title === "JEE Main 2026 (21 January Shift 1)",
  );
  assert.ok(paper);

  const groups = paper.sources.map((source) => ({
    subject: source.subject,
    chapter: source.chapter,
    questions: JSON.parse(
      readFileSync(
        new URL(`../data/JEE_Main/${source.file}`, import.meta.url),
        "utf8",
      ),
    ),
  }));

  const built = buildExactPaperQuestions(groups, "JEE_Main", paper);
  assert.equal(built.length, 75);
  assert.ok(
    built
      .slice(0, 20)
      .every((q) => q.subject === "physics" && q.type === "singleCorrect"),
  );
  assert.ok(
    built
      .slice(20, 25)
      .every((q) => q.subject === "physics" && q.type === "numerical"),
  );
  assert.ok(
    built
      .slice(25, 45)
      .every((q) => q.subject === "chemistry" && q.type === "singleCorrect"),
  );
  assert.ok(
    built
      .slice(45, 50)
      .every((q) => q.subject === "chemistry" && q.type === "numerical"),
  );
  assert.ok(
    built
      .slice(50, 70)
      .every((q) => q.subject === "math" && q.type === "singleCorrect"),
  );
  assert.ok(
    built
      .slice(70, 75)
      .every((q) => q.subject === "math" && q.type === "numerical"),
  );
});

test("analyzeTest computes subject-wise marks, MCQ vs numerical split, and chapters without changing storage format", () => {
  const report = analyzeTest({
    id: "t-1",
    exam: "JEE_Main",
    title: "Full Mock",
    minutes: 180,
    seconds: 3200,
    questions: [
      {
        uid: "p1",
        subject: "physics",
        chapter: "Mechanics",
        topic: "Kinematics",
        type: "singleCorrect",
        options: [{ id: "A" }, { id: "B" }],
        correct_answer: "A",
        userAnswer: "A",
        timeSpentSeconds: 60,
      },
      {
        uid: "p2",
        subject: "physics",
        chapter: "Mechanics",
        topic: "Dynamics",
        type: "numerical",
        correct_answer: "5",
        userAnswer: "4",
        timeSpentSeconds: 90,
      },
      {
        uid: "c1",
        subject: "chemistry",
        chapter: "Thermodynamics",
        topic: "Enthalpy",
        type: "singleCorrect",
        options: [{ id: "A" }, { id: "B" }],
        correct_answer: "B",
        userAnswer: "B",
        timeSpentSeconds: 45,
      },
      {
        uid: "m1",
        subject: "math",
        chapter: "Calculus",
        topic: "Limits",
        type: "numerical",
        correct_answer: "10",
        timeSpentSeconds: 20,
      },
    ],
  });

  assert.equal(report.score, 7);
  assert.equal(report.maxScore, 16);
  assert.equal(report.positiveMarks, 8);
  assert.equal(report.negativeMarks, 1);
  assert.deepEqual(
    report.subjects.map((s) => ({
      key: s.key,
      score: s.score,
      maxScore: s.maxScore,
      correct: s.correct,
      incorrect: s.incorrect,
      skipped: s.skipped,
      mcqScore: s.mcq.score,
      numScore: s.numerical.score,
    })),
    [
      {
        key: "physics",
        score: 3,
        maxScore: 8,
        correct: 1,
        incorrect: 1,
        skipped: 0,
        mcqScore: 4,
        numScore: -1,
      },
      {
        key: "chemistry",
        score: 4,
        maxScore: 4,
        correct: 1,
        incorrect: 0,
        skipped: 0,
        mcqScore: 4,
        numScore: 0,
      },
      {
        key: "math",
        score: 0,
        maxScore: 4,
        correct: 0,
        incorrect: 0,
        skipped: 1,
        mcqScore: 0,
        numScore: 0,
      },
    ],
  );
  assert.equal(report.chapters.length, 3);
  assert.equal(report.questionTypes.length, 2);
});

test("TestAnalysisScreen renders subject marks and overview tree with lightweight React stub", () => {
  const mockReact = {
    createElement: (type, props, children) => ({ type, props: props || {}, children }),
    useMemo: (fn) => fn(),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };

  const tree = TestAnalysisScreen({
    React: mockReact,
    test: {
      id: "1",
      exam: "JEE_Main",
      title: "JEE Main 2026 (21 January Shift 1)",
      date: "2026-01-21T09:00:00.000Z",
      minutes: 180,
      seconds: 5400,
      questions: [
        {
          uid: "q1",
          subject: "physics",
          chapter: "Optics",
          type: "singleCorrect",
          options: [{ id: "A", text: "10" }],
          correct_answer: "A",
          userAnswer: "A",
        },
        {
          uid: "q2",
          subject: "chemistry",
          chapter: "Solutions",
          type: "numerical",
          correct_answer: "3",
          userAnswer: "2",
        },
      ],
    },
    onBack: () => {},
    onReview: () => {},
  });

  const serialized = JSON.stringify(tree);
  assert.ok(serialized.includes("analysis-screen"));
  assert.ok(serialized.includes("Marks & accuracy by subject"));
  assert.ok(serialized.includes("Physics"));
  assert.ok(serialized.includes("Chemistry"));
});

test("year-wise numerical keys support ranges, alternatives, and bonus items", () => {
  assert.deepEqual(parseNumericalAnswerKey("18TO24"), {
    kind: "range",
    min: 18,
    max: 24,
    raw: "18TO24",
  });
  assert.deepEqual(parseNumericalAnswerKey("190 OR 210").values, [190, 210]);
  assert.equal(parseNumericalAnswerKey("BONUS").kind, "bonus");

  const range = { type: "numerical", correct_answer: "18TO24" };
  const alternatives = { type: "numerical", correct_answer: "3730OR6460" };
  const bonus = { type: "numerical", correct_answer: "BONUS" };
  assert.equal(isScoreableQuestion(range), true);
  assert.equal(isCorrectAnswer(range, "22"), true);
  assert.equal(isCorrectAnswer(range, "25"), false);
  assert.equal(isCorrectAnswer(alternatives, "6460"), true);
  assert.equal(isCorrectAnswer(alternatives, "3731"), false);
  assert.equal(isScoreableQuestion(bonus), false);
  assert.equal(isCorrectAnswer(bonus, "1"), false);

  const report = analyzeTest({
    questions: [
      { uid: "range", ...range, userAnswer: "22" },
      { uid: "bonus", ...bonus, userAnswer: "1" },
    ],
  });
  assert.deepEqual(
    report.questions.map((question) => question.status),
    ["correct", "unscored"],
  );
  assert.equal(report.scoreableTotal, 1);
  assert.equal(report.maxScore, 4);
  assert.equal(report.score, 4);
});
