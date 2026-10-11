const shuffle = (items) => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

let archivePromise;

async function readArchiveEntry(path) {
  archivePromise ??= fetch("/data.zip").then((response) => {
    if (!response.ok) {
      throw new Error("The bundled question archive could not be loaded.");
    }
    return response.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  });

  const bytes = await archivePromise;
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
  if (endOfDirectory < 0) throw new Error("The question archive is invalid.");

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

  throw new Error("The requested question file was not found in the archive.");
}

/** Fetch a loose data file first, then read it from the checked-in ZIP archive. */
export async function dataJson(path) {
  const url = `/data/${path.split("/").map(encodeURIComponent).join("/")}`;
  try {
    const response = await fetch(url);
    if (response.ok) return await response.json();
  } catch {
    // A static host may not unpack data.zip into /data; use the archive below.
  }

  const bytes = await readArchiveEntry(`data/${path}`);
  return JSON.parse(new TextDecoder().decode(bytes));
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

function answerIsCorrect(question, answer) {
  if (!isAttempted(answer) || question?.type === "multipleCorrect") return false;
  if (question?.type === "numerical") {
    return (
      Number.isFinite(Number(answer)) &&
      Number.isFinite(Number(question.correct_answer)) &&
      Math.abs(Number(answer) - Number(question.correct_answer)) < 1e-6
    );
  }
  return (
    (question?.options || []).some(
      (option) => String(option.id) === String(question.correct_answer),
    ) && String(answer) === String(question.correct_answer)
  );
}

const summarizeGroup = (questions) => {
  const attempted = questions.filter((question) => question.status !== "skipped");
  const correct = questions.filter((question) => question.status === "correct").length;
  const incorrect = questions.filter((question) => question.status === "incorrect").length;
  const skipped = questions.length - attempted.length;
  return {
    total: questions.length,
    attempted: attempted.length,
    correct,
    incorrect,
    skipped,
    accuracy: attempted.length ? Math.round((correct / attempted.length) * 100) : 0,
    score: correct * 4 - incorrect,
  };
};

/** Detailed, cohort-free performance summary for one completed custom test. */
export function analyzeTest(test = {}) {
  const questions = (Array.isArray(test.questions) ? test.questions : []).map(
    (question, index) => {
      const userAnswer = question.userAnswer;
      const attempted = isAttempted(userAnswer);
      const isCorrect = attempted
        ? typeof question.isCorrect === "boolean"
          ? question.isCorrect
          : answerIsCorrect(question, userAnswer)
        : false;
      const level = Number(question.difficulty_level);
      return {
        ...question,
        index: index + 1,
        attempted,
        status: attempted ? (isCorrect ? "correct" : "incorrect") : "skipped",
        isCorrect: attempted && isCorrect,
        difficulty: [1, 2, 3].includes(level) ? level : null,
        timeSpentSeconds: Math.max(0, Number(question.timeSpentSeconds) || 0),
      };
    },
  );
  const overall = summarizeGroup(questions);
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
      ...summarizeGroup(group),
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
      ...summarizeGroup(group),
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
  const half = Math.ceil(questions.length / 2);
  const firstHalf = summarizeGroup(questions.slice(0, half));
  const secondHalf = summarizeGroup(questions.slice(half));
  return {
    ...overall,
    score: Number.isFinite(Number(test.score)) ? Number(test.score) : overall.score,
    totalSeconds: Math.max(0, Number(test.seconds) || measuredSeconds),
    measuredSeconds,
    measuredQuestions: measured.length,
    averageSecondsPerAttempt: measuredAttempts.length
      ? Math.round(attemptedSeconds / measuredAttempts.length)
      : null,
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
