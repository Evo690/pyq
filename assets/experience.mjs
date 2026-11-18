const shuffle = (items) => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

export const DATA_ARCHIVE_URL = "/data.zip";
export const JEE_MAIN_ARCHIVE_URL = "/jee-main-papers-by-year.zip";

const archivePromises = new Map();

function loadArchive(archiveUrl) {
  if (!archivePromises.has(archiveUrl)) {
    const promise = fetch(archiveUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`The ${archiveUrl} question archive could not be loaded.`);
        }
        return response.arrayBuffer().then((buffer) => new Uint8Array(buffer));
      })
      .catch((error) => {
        // A transient failure should not poison every later retry.
        archivePromises.delete(archiveUrl);
        throw error;
      });
    archivePromises.set(archiveUrl, promise);
  }
  return archivePromises.get(archiveUrl);
}

async function readArchiveEntry(archiveUrl, path) {
  const bytes = await loadArchive(archiveUrl);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOfDirectory = -1;
  const searchStart = Math.max(0, bytes.length - 65_557);

  // Locate the ZIP end-of-central-directory record (including its comment).
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOfDirectory = offset;
      break;
    }
  }
  if (endOfDirectory < 0) throw new Error(`The ${archiveUrl} archive is invalid.`);

  const totalEntries = view.getUint16(endOfDirectory + 10, true);
  let cursor = view.getUint32(endOfDirectory + 16, true);
  const decoder = new TextDecoder();

  for (let index = 0; index < totalEntries; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;

    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    if (name === path) {
      const localNameLength = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);

      if (method === 0) return compressed;
      if (method !== 8 || typeof DecompressionStream === "undefined") {
        throw new Error("This browser cannot unpack the bundled question archive.");
      }

      const stream = new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`The requested question file was not found in ${archiveUrl}.`);
}

/** Read one JSON member from a checked-in ZIP archive. */
export async function archiveJson(archiveUrl, path) {
  const bytes = await readArchiveEntry(archiveUrl, path);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function dataUrl(path) {
  return `/data/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Fetch a loose data file first, then read it from the checked-in ZIP archive. */
export async function dataJson(path) {
  try {
    const response = await fetch(dataUrl(path));
    if (response.ok) return await response.json();
  } catch {
    // A static host may not unpack data.zip into /data; use the archive below.
  }

  return archiveJson(DATA_ARCHIVE_URL, `data/${path}`);
}

/**
 * Load one year of exact JEE Main papers. A deployment may extract the large
 * year files beneath /data/exact-papers; otherwise the checked-in year-wise
 * ZIP is the source of truth.
 */
export async function exactPaperYearJson(fileName) {
  try {
    const response = await fetch(dataUrl(`exact-papers/${fileName}`));
    if (response.ok) return await response.json();
  } catch {
    // Fall through to the checked-in archive.
  }

  return archiveJson(JEE_MAIN_ARCHIVE_URL, fileName);
}

/** Uniform Fisher-Yates shuffle. */
function shuffleInPlaceCopy(items) {
  return shuffle(items);
}

/**
 * Sample unique questions without repeating viewed/answered questions until
 * the fresh pool is exhausted. When it is, prefer the least-recently seen.
 * The round-robin topic/difficulty buckets keep a test from clumping together.
 */
export function pickQuestions(questions, count, store = {}, options = {}) {
  const unique = [
    ...new Map((questions || []).filter((question) => question?.uid).map((question) => [question.uid, question])).values(),
  ];
  const requested = Number(count);
  const limit = Math.min(
    unique.length,
    Math.max(0, Number.isFinite(requested) ? Math.floor(requested) : unique.length),
  );
  if (!limit) return [];

  const seenAt = new Map();
  const timestamp = (value) => {
    const raw = typeof value === "string" || typeof value === "number" ? value : value?.date;
    const parsed = typeof raw === "number" ? raw : Date.parse(raw || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const remember = (uid, value) => {
    if (!uid) return;
    const time = timestamp(value);
    if (!seenAt.has(uid) || time > seenAt.get(uid)) seenAt.set(uid, time);
  };

  for (const [uid, date] of Object.entries(store.seenQuestions || {})) remember(uid, date);
  for (const [uid, attempt] of Object.entries(store.attempts || {})) remember(uid, attempt?.date);
  for (const test of store.tests || []) {
    for (const question of test.questions || []) remember(question.uid, test.date);
  }

  const fresh = unique.filter((question) => !seenAt.has(question.uid));
  let pool = fresh;
  if (fresh.length < limit) {
    const oldestSeen = shuffle(unique.filter((question) => seenAt.has(question.uid))).sort(
      (left, right) => seenAt.get(left.uid) - seenAt.get(right.uid),
    );
    pool = [...fresh, ...oldestSeen.slice(0, limit - fresh.length)];
  }

  const prioritizeRecentYears = options.prioritizeRecentYears === true;
  const yearOf = (question) => {
    const match = String(question.paper_year_short || question.paper_year_title || "").match(/(?:19|20)\d{2}/);
    return match ? Number(match[0]) : 0;
  };
  const buckets = new Map();
  const bucketYears = new Map();
  for (const question of shuffleInPlaceCopy(pool)) {
    const year = prioritizeRecentYears ? yearOf(question) : null;
    const key = JSON.stringify([
      question.subject || "",
      question.chapter || "",
      question.topic || "Other",
      question.difficulty_level ?? "unknown",
      year,
    ]);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      bucketYears.set(key, year || 0);
    }
    buckets.get(key).push(question);
  }

  const sortYearsNewestFirst = (keys) => {
    if (prioritizeRecentYears) {
      keys.sort((left, right) => bucketYears.get(right) - bucketYears.get(left));
    }
    return keys;
  };
  let bucketKeys = sortYearsNewestFirst(shuffle([...buckets.keys()]));
  const selected = [];
  while (selected.length < limit) {
    let added = false;
    for (const key of bucketKeys) {
      const bucket = buckets.get(key);
      if (!bucket?.length) continue;
      selected.push(bucket.pop());
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
    bucketKeys = sortYearsNewestFirst(shuffle(bucketKeys));
  }

  return shuffle(selected);
}

const attemptEvents = (store, exam) => {
  const history = Array.isArray(store.attemptHistory)
    ? store.attemptHistory.filter((attempt) => attempt?.exam === exam)
    : [];
  const representedQuestions = new Set(history.map((attempt) => attempt.uid).filter(Boolean));
  const legacyAttempts = Object.values(store.attempts || {}).filter(
    (attempt) => attempt?.exam === exam && attempt.uid && !representedQuestions.has(attempt.uid),
  );
  return [...history, ...legacyAttempts].filter(
    (attempt) =>
      attempt.exam === exam &&
      typeof attempt.correct === "boolean" &&
      Boolean(attempt.topic),
  );
};

/** Accuracy and short-term trend for each topic, based on its last 10 answers. */
export function topicPerformance(store, exam) {
  const groups = new Map();
  for (const attempt of attemptEvents(store, exam)) {
    const key = JSON.stringify([attempt.subject, attempt.chapter, attempt.topic]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(attempt);
  }

  return [...groups.values()]
    .map((events) => {
      const recent = events
        .sort((left, right) => (Date.parse(right.date) || 0) - (Date.parse(left.date) || 0))
        .slice(0, 10);
      const first = recent[0];
      const accuracyOf = (items) =>
        items.length
          ? Math.round((items.filter((attempt) => attempt.correct).length / items.length) * 100)
          : null;
      const recentAccuracy = accuracyOf(recent.slice(0, 5));
      const previousAccuracy = accuracyOf(recent.slice(5, 10));
      const correct = recent.filter((attempt) => attempt.correct === true).length;

      return {
        subject: first.subject,
        chapter: first.chapter,
        topic: first.topic,
        attempts: recent.length,
        correct,
        accuracy: accuracyOf(recent),
        trend: previousAccuracy === null ? null : recentAccuracy - previousAccuracy,
      };
    })
    .sort((left, right) => left.accuracy - right.accuracy || right.attempts - left.attempts);
}

/** Surface topics with a meaningful low-accuracy signal from the last 10 answers. */
export function topicInsights(store, exam) {
  return topicPerformance(store, exam)
    .filter((topic) => topic.attempts >= 3 && topic.accuracy < 65)
    .slice(0, 6);
}

/** Schedule the next review using a simple SM-2-inspired interval ladder. */
export function scheduleReview(previous, correct, now = Date.now()) {
  const repetitions = correct ? Math.max(0, Number(previous?.repetitions) || 0) + 1 : 0;
  const intervals = [1, 3, 7, 14, 30, 60, 90];
  const intervalDays = correct
    ? intervals[Math.min(repetitions - 1, intervals.length - 1)]
    : 1;

  return {
    repetitions,
    intervalDays,
    dueAt: new Date(now + intervalDays * 24 * 60 * 60 * 1000).toISOString(),
    lastAttemptAt: new Date(now).toISOString(),
    lastCorrect: correct,
  };
}

export function dueReviewEntries(store, exam, now = Date.now(), limit = Infinity) {
  return Object.values(store.reviewQueue || {})
    .filter((entry) => {
      const dueAt = Date.parse(entry?.dueAt || "");
      return entry?.exam === exam && entry.uid && Number.isFinite(dueAt) && dueAt <= now;
    })
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
    .slice(0, limit);
}

export function dueReviewCount(store, exam, now = Date.now()) {
  return dueReviewEntries(store, exam, now).length;
}

/**
 * Practice mixes delayed reviews, low-accuracy topics, and fresh variety. Weak
 * topics get easier levels first; sustained high accuracy gets harder levels.
 */
export function adaptivePracticeQuestions(questions, count, store = {}, options = {}) {
  const unique = [...new Map((questions || []).filter((question) => question?.uid).map((question) => [question.uid, question])).values()];
  const requested = Number(count);
  const limit = Math.min(
    unique.length,
    Math.max(0, Number.isFinite(requested) ? Math.floor(requested) : unique.length),
  );
  if (!limit) return [];

  const exam = unique.find((question) => question.exam)?.exam;
  const dueIds = new Set(dueReviewEntries(store, exam).map((entry) => entry.uid));
  const duePool = unique.filter((question) => dueIds.has(question.uid));
  const dueCount = Math.min(duePool.length, Math.ceil(limit * 0.35));
  const dueQuestions = pickQuestions(duePool, dueCount, store, options);
  const selectedIds = new Set(dueQuestions.map((question) => question.uid));
  const remaining = unique.filter((question) => !selectedIds.has(question.uid));
  const remainingCount = limit - dueQuestions.length;
  if (!remainingCount) return shuffle(dueQuestions);

  const metrics = new Map(
    topicPerformance(store, exam).map((metric) => [
      JSON.stringify([metric.subject, metric.chapter, metric.topic]),
      metric,
    ]),
  );
  const getMetric = (question) =>
    metrics.get(JSON.stringify([question.subject, question.chapter, question.topic]));
  const difficultyAdjusted = (pool) => {
    const preferred = pool.filter((question) => {
      const metric = getMetric(question);
      const level = Number(question.difficulty_level);
      if (!metric || metric.attempts < 3 || !Number.isFinite(level)) return true;
      if (metric.accuracy < 45) return level <= 2;
      if (metric.accuracy >= 85) return level >= 2;
      return true;
    });
    return preferred.length ? preferred : pool;
  };

  const weakPool = difficultyAdjusted(
    remaining.filter((question) => {
      const metric = getMetric(question);
      return metric?.attempts >= 3 && metric.accuracy < 75;
    }),
  );
  const weakCount = Math.min(weakPool.length, Math.ceil(remainingCount * 0.4));
  const weakQuestions = pickQuestions(weakPool, weakCount, store, options);
  for (const question of weakQuestions) selectedIds.add(question.uid);

  const generalPool = difficultyAdjusted(
    remaining.filter((question) => !selectedIds.has(question.uid)),
  );
  const generalQuestions = pickQuestions(
    generalPool,
    remainingCount - weakQuestions.length,
    store,
    options,
  );
  return shuffle([...dueQuestions, ...weakQuestions, ...generalQuestions]);
}

const isAttempted = (answer) =>
  answer !== undefined &&
  answer !== null &&
  answer !== "" &&
  (!Array.isArray(answer) || answer.length > 0);

const NUMERICAL_TOLERANCE = 1e-6;

/**
 * Year-wise JEE Main papers preserve the source answer key verbatim. Some
 * numerical keys are a range, alternative accepted values, or a bonus/dropped
 * marker. Parse those without changing the stored source key.
 */
export function parseNumericalAnswerKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { kind: "unscored", raw };
  const normalized = raw.toUpperCase();

  if (/^(BONUS|DROP(PED)?|ALL|ALL CORRECT|MARKS TO ALL)$/.test(normalized)) {
    return { kind: "bonus", raw };
  }

  const range = normalized.match(
    /^(-?\d+(?:\.\d+)?)\s*TO\s*(-?\d+(?:\.\d+)?)$/,
  );
  if (range) {
    const first = Number(range[1]);
    const second = Number(range[2]);
    if (Number.isFinite(first) && Number.isFinite(second)) {
      return {
        kind: "range",
        min: Math.min(first, second),
        max: Math.max(first, second),
        raw,
      };
    }
  }

  const parts = normalized
    .split(/\s*(?:OR|,|\||\/)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const values = parts.map(Number);
  if (parts.length > 0 && values.every(Number.isFinite)) {
    return { kind: "values", values, raw };
  }

  const exact = Number(raw);
  if (Number.isFinite(exact)) {
    return { kind: "values", values: [exact], raw };
  }
  return { kind: "unscored", raw };
}

function numericalRuleFor(question) {
  if (question?.type !== "numerical") return null;
  if (question.answerRule && typeof question.answerRule.kind === "string") {
    return question.answerRule;
  }
  return parseNumericalAnswerKey(question?.correct_answer);
}

/** Whether the app can award +4 / −1 for this source item. */
export function isScoreableQuestion(question) {
  if (!question) return false;
  if (question.type === "multipleCorrect" || question.bonus === true) return false;
  if (question.type === "numerical") {
    const rule = numericalRuleFor(question);
    return rule?.kind === "values" || rule?.kind === "range";
  }
  if (Array.isArray(question.correct_answer)) return false;
  return (question.options || []).some(
    (option) => String(option?.id) === String(question.correct_answer),
  );
}

/** Shared correctness check for live tests, practice, and historical reports. */
export function isCorrectAnswer(question, answer) {
  if (!isAttempted(answer) || !isScoreableQuestion(question)) return false;

  if (question.type === "numerical") {
    if (Array.isArray(answer)) return false;
    const value = Number(answer);
    if (!Number.isFinite(value)) return false;
    const rule = numericalRuleFor(question);
    if (rule?.kind === "range") {
      return (
        value >= rule.min - NUMERICAL_TOLERANCE &&
        value <= rule.max + NUMERICAL_TOLERANCE
      );
    }
    return (rule?.values || []).some(
      (expected) => Math.abs(value - expected) < NUMERICAL_TOLERANCE,
    );
  }

  return String(answer) === String(question.correct_answer);
}

function answerIsCorrect(question, answer) {
  return isCorrectAnswer(question, answer);
}

const SUBJECT_META = {
  physics: { key: "physics", label: "Physics", color: "mint", order: 0 },
  chemistry: { key: "chemistry", label: "Chemistry", color: "peach", order: 1 },
  math: { key: "math", label: "Mathematics", color: "lilac", order: 2 },
};

const summarizeGroup = (questions) => {
  const attempted = questions.filter(
    (question) => question.status === "correct" || question.status === "incorrect",
  );
  const correct = questions.filter((question) => question.status === "correct").length;
  const incorrect = questions.filter((question) => question.status === "incorrect").length;
  const skipped = questions.filter((question) => question.status === "skipped").length;
  const unscored = questions.filter((question) => question.status === "unscored").length;
  const scoreableTotal = questions.length - unscored;
  const maxScore = scoreableTotal * 4;
  const score = correct * 4 - incorrect;
  return {
    total: questions.length,
    scoreableTotal,
    maxScore,
    attempted: attempted.length,
    correct,
    incorrect,
    skipped,
    unscored,
    accuracy: attempted.length ? Math.round((correct / attempted.length) * 100) : 0,
    score,
    positiveMarks: correct * 4,
    negativeMarks: incorrect,
  };
};

/** Detailed, cohort-free performance summary for one completed custom test. */
export function analyzeTest(test = {}) {
  const questions = (Array.isArray(test.questions) ? test.questions : []).map(
    (question, index) => {
      const userAnswer = question.userAnswer;
      const hasAnswer = isAttempted(userAnswer);
      const answerRule = numericalRuleFor(question);
      const isMultiple = question.type === "multipleCorrect";
      const unscoredQuestion =
        isMultiple ||
        question.bonus === true ||
        answerRule?.kind === "bonus" ||
        answerRule?.kind === "unscored";
      const status = !hasAnswer
        ? "skipped"
        : unscoredQuestion
          ? "unscored"
          : (typeof question.isCorrect === "boolean"
                ? question.isCorrect
                : answerIsCorrect(question, userAnswer))
            ? "correct"
            : "incorrect";
      const attempted = status === "correct" || status === "incorrect";
      const isCorrect = status === "correct";
      const level = Number(question.difficulty_level);
      const normalizedType =
        question.type === "numerical"
          ? "numerical"
          : isMultiple
            ? "multipleCorrect"
            : "singleCorrect";
      return {
        ...question,
        index: index + 1,
        attempted,
        scoreable: !unscoredQuestion,
        unscored: unscoredQuestion && (hasAnswer || status === "unscored"),
        status,
        questionType: normalizedType,
        isCorrect,
        difficulty: [1, 2, 3].includes(level) ? level : null,
        timeSpentSeconds: Math.max(0, Number(question.timeSpentSeconds) || 0),
      };
    },
  );
  // Ensure scoreableTotal excludes all multipleCorrect questions regardless of attempt
  const normalizeSummary = (group) => {
    const base = summarizeGroup(group);
    const nonScorable = group.filter((q) => q.scoreable === false).length;
    const scoreableTotal = group.length - nonScorable;
    return {
      ...base,
      scoreableTotal,
      maxScore: scoreableTotal * 4,
    };
  };
  const overall = normalizeSummary(questions);

  const subjectKeys = [
    ...new Set([
      "physics",
      "chemistry",
      "math",
      ...questions.map((question) => question.subject).filter(Boolean),
    ]),
  ];
  const subjects = subjectKeys
    .map((key) => {
      const group = questions.filter((question) => (question.subject || "") === key);
      if (!group.length) return null;
      const meta = SUBJECT_META[key] || {
        key: key || "general",
        label: key ? key[0].toUpperCase() + key.slice(1) : "General",
        color: "mint",
        order: 99,
      };
      const seconds = group.reduce((sum, question) => sum + question.timeSpentSeconds, 0);
      const attemptedGroup = group.filter((question) => question.attempted);
      const mcqGroup = group.filter((question) => question.questionType !== "numerical");
      const numericalGroup = group.filter((question) => question.questionType === "numerical");
      return {
        key: meta.key,
        label: meta.label,
        color: meta.color,
        order: meta.order,
        ...normalizeSummary(group),
        seconds,
        averageSecondsPerAttempt: attemptedGroup.length
          ? Math.round(
              attemptedGroup.reduce((sum, q) => sum + q.timeSpentSeconds, 0) /
                attemptedGroup.length,
            )
          : null,
        mcq: normalizeSummary(mcqGroup),
        numerical: normalizeSummary(numericalGroup),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));

  const questionTypes = [
    ["singleCorrect", "Single-correct MCQ"],
    ["numerical", "Numerical value"],
    ["multipleCorrect", "Multiple-correct"],
  ]
    .map(([type, label]) => {
      const group = questions.filter((question) => question.questionType === type);
      return {
        type,
        label,
        ...normalizeSummary(group),
        seconds: group.reduce((sum, question) => sum + question.timeSpentSeconds, 0),
      };
    })
    .filter((group) => group.total > 0);

  const chaptersMap = new Map();
  for (const question of questions) {
    const key = JSON.stringify([question.subject || "", question.chapter || ""]);
    if (!chaptersMap.has(key)) chaptersMap.set(key, []);
    chaptersMap.get(key).push(question);
  }
  const chapters = [...chaptersMap.values()]
    .map((group) => ({
      subject: group[0].subject || "",
      chapter: group[0].chapter || "General",
      ...normalizeSummary(group),
      seconds: group.reduce((sum, question) => sum + question.timeSpentSeconds, 0),
    }))
    .sort((left, right) => right.score - left.score || right.total - left.total);

  const difficulty = [1, 2, 3, null].map((level) => {
    const group = questions.filter((question) => question.difficulty === level);
    return {
      level,
      label:
        level === 1
          ? "Easy"
          : level === 2
            ? "Medium"
            : level === 3
              ? "Hard"
              : "Unrated",
      ...normalizeSummary(group),
      seconds: group.reduce((sum, question) => sum + question.timeSpentSeconds, 0),
    };
  }).filter((group) => group.total > 0);
  const topics = new Map();
  for (const question of questions) {
    const key = JSON.stringify([
      question.subject || "",
      question.chapter || "",
      question.topic || "",
    ]);
    if (!topics.has(key)) topics.set(key, []);
    topics.get(key).push(question);
  }
  const topicBreakdown = [...topics.values()]
    .map((group) => ({
      subject: group[0].subject || "",
      chapter: group[0].chapter || "",
      topic: group[0].topic || group[0].chapter || "Other",
      ...normalizeSummary(group),
      seconds: group.reduce((sum, question) => sum + question.timeSpentSeconds, 0),
    }))
    .sort((left, right) => left.accuracy - right.accuracy || right.total - left.total);
  const measured = questions.filter((question) => question.timeSpentSeconds > 0);
  const measuredAttempts = measured.filter((question) => question.attempted);
  const measuredSeconds = measured.reduce(
    (sum, question) => sum + question.timeSpentSeconds,
    0,
  );
  const attemptedSeconds = measuredAttempts.reduce(
    (sum, question) => sum + question.timeSpentSeconds,
    0,
  );
  const correctSeconds = measured
    .filter((question) => question.status === "correct")
    .reduce((sum, question) => sum + question.timeSpentSeconds, 0);
  const incorrectSeconds = measured
    .filter((question) => question.status === "incorrect")
    .reduce((sum, question) => sum + question.timeSpentSeconds, 0);
  const skippedSeconds = measured
    .filter((question) => question.status === "skipped")
    .reduce((sum, question) => sum + question.timeSpentSeconds, 0);
  const half = Math.ceil(questions.length / 2);
  const firstHalf = normalizeSummary(questions.slice(0, half));
  const secondHalf = normalizeSummary(questions.slice(half));
  const finalScore = Number.isFinite(Number(test.score)) ? Number(test.score) : overall.score;
  return {
    ...overall,
    score: finalScore,
    scorePercent: overall.maxScore > 0 ? Math.max(0, Math.round((finalScore / overall.maxScore) * 100)) : 0,
    attemptRate: overall.scoreableTotal > 0 ? Math.round((overall.attempted / overall.scoreableTotal) * 100) : 0,
    totalSeconds: Math.max(0, Number(test.seconds) || measuredSeconds),
    measuredSeconds,
    measuredQuestions: measured.length,
    correctSeconds,
    incorrectSeconds,
    skippedSeconds,
    averageSecondsPerAttempt: measuredAttempts.length
      ? Math.round(attemptedSeconds / measuredAttempts.length)
      : null,
    subjects,
    questionTypes,
    chapters,
    difficulty,
    topics: topicBreakdown,
    halves: {
      first: firstHalf,
      second: secondHalf,
      delta: firstHalf.attempted && secondHalf.attempted
        ? secondHalf.accuracy - firstHalf.accuracy
        : null,
    },
    questions,
  };
}

export function requestExamFullscreen() {
  if (document.fullscreenElement || !document.documentElement?.requestFullscreen) return;
  try {
    const request = document.documentElement.requestFullscreen();
    request?.catch?.(() => {});
  } catch {
    // Embedded previews may deny browser fullscreen; the app still fills the viewport.
  }
}

export function releaseExamFullscreen() {
  if (!document.fullscreenElement || !document.exitFullscreen) return;
  try {
    const exit = document.exitFullscreen();
    exit?.catch?.(() => {});
  } catch {
    // Ignore browser-specific fullscreen errors during session cleanup.
  }
}
