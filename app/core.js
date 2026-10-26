/**
 * Pure domain logic: paper ordering, scoring, and analysis summaries.
 * This module has no DOM or network access so it can be unit tested with Node.
 */

export const SUBJECT_ORDER = ["physics", "chemistry", "math"];

export const SUBJECT_LABEL = {
  physics: "Physics",
  chemistry: "Chemistry",
  math: "Mathematics",
};

/** MCQ items first, then multiple-correct, then numerical — per subject. */
export const TYPE_ORDER = ["singleCorrect", "multipleCorrect", "numerical"];

export const TYPE_LABEL = {
  singleCorrect: "MCQ",
  multipleCorrect: "Multiple correct",
  numerical: "Numerical",
};

export const TYPE_SHORT = {
  singleCorrect: "MCQ",
  multipleCorrect: "MSQ",
  numerical: "NUM",
};

export const DIFFICULTY_LABEL = { 1: "Easy", 2: "Medium", 3: "Hard" };

export const MARKS = {
  correct: 4,
  incorrect: -1,
  mcqPartial: 1,
  mcqIncorrect: -2,
};

export const EXAM_LABEL = {
  JEE_Main: "JEE Main",
  JEE_Advanced: "JEE Advanced",
};

export function subjectRank(subject) {
  const index = SUBJECT_ORDER.indexOf(String(subject || "").toLowerCase());
  return index === -1 ? 99 : index;
}

export function typeRank(type) {
  const index = TYPE_ORDER.indexOf(type);
  return index === -1 ? 99 : index;
}

/** Stable identity for a paper across sessions and offline storage. */
export function paperKey(exam, title) {
  return `${exam}::${String(title || "").trim()}`;
}

/** Normalize the papers.json catalog entry into a display-friendly object. */
export function normalizePaper(paper, exam) {
  if (!paper || typeof paper.title !== "string") return null;
  const title = paper.title.trim();
  if (!title) return null;
  const yearMatch = title.match(/(?:19|20)\d{2}/);
  const labelMatch = title.match(/\d{4}\s*\(([^)]+)\)/);
  const questionCount = Number(paper.questionCount ?? paper.count);
  const subjects = {};
  for (const key of SUBJECT_ORDER) {
    const value = Number(paper.subjects?.[key] ?? 0);
    subjects[key] = Number.isFinite(value) ? value : 0;
  }
  return {
    id: String(paper.id || title),
    key: paperKey(exam, title),
    exam,
    title,
    year: String(paper.year || yearMatch?.[0] || ""),
    label: String(paper.label || labelMatch?.[1] || "Full paper"),
    date: paper.date || "",
    questionCount: Number.isFinite(questionCount) ? questionCount : 0,
    subjects,
    sources: Array.isArray(paper.sources) ? paper.sources : [],
  };
}

export function normalizePaperCatalog(exam, index) {
  const list = index?.exams?.[exam]?.papers;
  if (!Array.isArray(list)) return [];
  return list
    .map((paper) => normalizePaper(paper, exam))
    .filter((paper) => paper && paper.year && paper.questionCount > 0)
    .sort(
      (left, right) =>
        Number(right.year) - Number(left.year) ||
        String(left.date).localeCompare(String(right.date)) ||
        left.label.localeCompare(right.label),
    );
}

/** Expand papers.json `sources` (chapter indexes) into {subject, chapter, file}. */
export function paperSources(index, exam, paper) {
  const chapters = index?.exams?.[exam]?.chapters;
  return (paper?.sources || [])
    .map((source) => (Number.isInteger(source) ? chapters?.[source] : source))
    .filter((source) => source && source.file)
    .map((source) => ({
      subject: String(source.subject || "").toLowerCase(),
      chapter: source.chapter,
      file: source.file,
    }));
}

/** Turn a raw question record into the app's normalized question shape. */
export function normalizeQuestion(raw, context = {}) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.question_id || raw.uid;
  if (!id) return null;
  const options = Array.isArray(raw.options)
    ? raw.options
        .filter((option) => option && (option.text || option.image))
        .map((option) => ({
          id: String(option.id),
          text: String(option.text || ""),
        }))
    : [];
  const type =
    raw.type === "numerical"
      ? "numerical"
      : raw.type === "multipleCorrect"
        ? "multipleCorrect"
        : "singleCorrect";
  const answer =
    type === "numerical"
      ? String(raw.correct_answer ?? "").trim()
      : String(raw.correct_answer ?? "").trim();
  const difficulty = Number(raw.difficulty_level);
  return {
    uid: context.exam ? `${context.exam}:${id}` : String(id),
    id: String(id),
    exam: context.exam || "",
    subject: String(context.subject || "").toLowerCase(),
    chapter: context.chapter || raw.chapter || "",
    topic: raw.topic || "",
    type,
    difficulty: difficulty >= 1 && difficulty <= 3 ? difficulty : 2,
    text: String(raw.question_text || ""),
    options,
    answer,
    solution: String(raw.solution_text || ""),
    paper: raw.paper_year_title || "",
    heldOn: raw.held_on || "",
  };
}

/**
 * Order a full paper: for each subject in turn, all MCQs, then all
 * multiple-correct items, then all numericals. Within a section questions keep
 * their chapter (alphabetical) and source-file order, which is stable.
 */
export function orderPaperQuestions(questions) {
  return [...questions].sort((left, right) => {
    return (
      subjectRank(left.subject) - subjectRank(right.subject) ||
      typeRank(left.type) - typeRank(right.type) ||
      String(left.chapter).localeCompare(String(right.chapter)) ||
      (left.order ?? 0) - (right.order ?? 0)
    );
  });
}

/** Group an ordered paper into display sections (subject + question type). */
export function paperSections(questions) {
  const sections = [];
  for (const question of questions) {
    const last = sections[sections.length - 1];
    if (last && last.subject === question.subject && last.type === question.type) {
      last.questions.push(question);
    } else {
      sections.push({
        subject: question.subject,
        type: question.type,
        questions: [question],
      });
    }
  }
  return sections;
}

/**
 * Build the questions for one exact paper from already-loaded chapter groups.
 * `groups` is [{subject, chapter, questions: raw[]}] and every question is
 * matched on its `paper_year_title`.
 */
export function buildPaperQuestions(groups, exam, paper) {
  if (!paper?.title) return [];
  const seen = new Set();
  const selected = [];
  let order = 0;

  for (const group of groups) {
    for (const raw of group.questions || []) {
      if (!raw || raw.paper_year_title !== paper.title) continue;
      const question = normalizeQuestion(raw, {
        exam,
        subject: group.subject,
        chapter: typeof group.chapter === "string" ? group.chapter : group.chapter?.name,
      });
      if (!question || seen.has(question.uid)) continue;
      seen.add(question.uid);
      question.order = order++;
      selected.push(question);
    }
  }

  return orderPaperQuestions(selected);
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  const text = String(value).replace(/[,\s]/g, "");
  if (!text) return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

/** Numerical answers are compared with a small tolerance for decimals. */
export function numericalMatches(given, expected) {
  const left = toNumber(given);
  const right = toNumber(expected);
  if (!Number.isFinite(right)) return String(given).trim() === String(expected).trim();
  if (!Number.isFinite(left)) return false;
  return Math.abs(left - right) < 0.011 || left === right;
}

export function isAnswered(question, answer) {
  if (answer === undefined || answer === null) return false;
  if (Array.isArray(answer)) return answer.length > 0;
  return String(answer).trim() !== "";
}

/**
 * Score one response. `answer` is an option id (single), an array of option ids
 * (multiple correct), or a string (numerical).
 */
export function scoreQuestion(question, answer) {
  const answered = isAnswered(question, answer);
  const max = MARKS.correct;

  if (!answered) {
    return {
      status: "skipped",
      marks: 0,
      max,
      correct: false,
      expected: question.answer,
      given: answer ?? "",
    };
  }

  if (question.type === "numerical") {
    const correct = numericalMatches(answer, question.answer);
    return {
      status: correct ? "correct" : "incorrect",
      marks: correct ? MARKS.correct : MARKS.incorrect,
      max,
      correct,
      expected: question.answer,
      given: String(answer),
    };
  }

  if (question.type === "multipleCorrect") {
    const given = new Set((Array.isArray(answer) ? answer : [answer]).map(String));
    const expected = new Set(
      String(question.answer)
        .split(/[\s,|]+/)
        .filter(Boolean),
    );
    if (!expected.size) {
      return { status: "skipped", marks: 0, max, correct: false, expected: "", given: [...given] };
    }
    let hits = 0;
    let misses = 0;
    for (const optionId of given) {
      if (expected.has(optionId)) hits += 1;
      else misses += 1;
    }
    if (misses === 0 && hits === expected.size) {
      return { status: "correct", marks: MARKS.correct, max, correct: true, expected: question.answer, given: [...given] };
    }
    if (misses === 0 && hits > 0) {
      return {
        status: "partial",
        marks: hits * MARKS.mcqPartial,
        max,
        correct: false,
        expected: question.answer,
        given: [...given],
      };
    }
    return { status: "incorrect", marks: MARKS.mcqIncorrect, max, correct: false, expected: question.answer, given: [...given] };
  }

  const correct = String(answer) === String(question.answer);
  return {
    status: correct ? "correct" : "incorrect",
    marks: correct ? MARKS.correct : MARKS.incorrect,
    max,
    correct,
    expected: question.answer,
    given: String(answer),
  };
}

const BLANK = { total: 0, attempted: 0, correct: 0, incorrect: 0, skipped: 0, partial: 0, score: 0, max: 0, time: 0 };

function bucket(key, label) {
  return { key, label, ...BLANK, _questions: 0 };
}

function accumulate(target, result) {
  target.total += 1;
  target.max += result.max;
  target.score += result.marks;
  target.time += result.time || 0;
  if (result.status === "skipped") target.skipped += 1;
  else target.attempted += 1;
  if (result.status === "correct") target.correct += 1;
  if (result.status === "incorrect") target.incorrect += 1;
  if (result.status === "partial") target.partial += 1;
}

function finish(bucketValue) {
  const accuracy = bucketValue.attempted
    ? (bucketValue.correct + bucketValue.partial * 0.5) / bucketValue.attempted
    : 0;
  return {
    ...bucketValue,
    accuracy,
    score: Math.round(bucketValue.score * 100) / 100,
    time: Math.round(bucketValue.time),
  };
}

/**
 * Build the complete analysis for an attempt:
 * { attempt: {...}, rows: [...], totals, bySubject, byType, byDifficulty,
 *   byChapter, slowest, insights }
 */
export function analyzeAttempt(attempt, now = Date.now()) {
  const questions = Array.isArray(attempt.questions) ? attempt.questions : [];
  const answers = attempt.answers || {};
  const times = attempt.times || {};
  const totalTime = Number(attempt.timeUsed) || 0;

  const rows = questions.map((question, index) => {
    const result = scoreQuestion(question, answers[question.uid]);
    return {
      index: index + 1,
      question,
      time: Math.max(0, Math.round(Number(times[question.uid]) || 0)),
      ...result,
    };
  });

  const totals = finish(rows.reduce((acc, row) => {
    accumulate(acc, row);
    return acc;
  }, { ...BLANK }));

  const makeGroup = (map, key, label) => {
    if (!map.has(key)) map.set(key, bucket(key, label));
    return map.get(key);
  };

  const subjectMap = new Map();
  const typeMap = new Map();
  const difficultyMap = new Map();
  const chapterMap = new Map();

  for (const row of rows) {
    const question = row.question;
    accumulate(
      makeGroup(subjectMap, question.subject, SUBJECT_LABEL[question.subject] || "Other"),
      row,
    );
    accumulate(
      makeGroup(typeMap, question.type, TYPE_LABEL[question.type] || "Other"),
      row,
    );
    accumulate(
      makeGroup(difficultyMap, String(question.difficulty), DIFFICULTY_LABEL[question.difficulty] || "Medium"),
      row,
    );
    const chapterBucket = makeGroup(
      chapterMap,
      `${question.subject}::${question.chapter}`,
      question.chapter || "Unclassified",
    );
    chapterBucket.subject = question.subject;
    chapterBucket.questionType = question.type;
    accumulate(chapterBucket, row);
  }

  const subjectOrderOf = (map) =>
    [...map.values()]
      .map(finish)
      .sort((left, right) => subjectRank(left.key) - subjectRank(right.key));

  const bySubject = subjectOrderOf(subjectMap);
  const byType = [...typeMap.values()]
    .map(finish)
    .sort((left, right) => typeRank(left.key) - typeRank(right.key));
  const byDifficulty = [...difficultyMap.values()]
    .map(finish)
    .sort((left, right) => Number(left.key) - Number(right.key));

  const byChapter = [...chapterMap.values()]
    .map((value) => ({
      ...finish(value),
      subject: value.subject,
      chapter: value.label,
    }))
    .sort(
      (left, right) =>
        // Chapters you actually answered come first, weakest accuracy on top;
        // untouched chapters trail so they do not read as "weak".
        Number(!left.attempted) - Number(!right.attempted) ||
        left.accuracy - right.accuracy ||
        right.attempted - left.attempted ||
        left.chapter.localeCompare(right.chapter),
    );

  const answeredTimes = rows.filter((row) => row.time > 0);
  const avgTime = answeredTimes.length
    ? answeredTimes.reduce((sum, row) => sum + row.time, 0) / answeredTimes.length
    : 0;

  const slowest = [...rows]
    .filter((row) => row.time > 0)
    .sort((left, right) => right.time - left.time)
    .slice(0, 5);

  const insights = buildInsights({ rows, bySubject, byType, byDifficulty, byChapter, totals, totalTime, attempt });

  return {
    attempt,
    rows,
    totals,
    bySubject,
    byType,
    byDifficulty,
    byChapter,
    slowest,
    avgTime,
    totalTime,
    computedAt: now,
    insights,
  };
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

/** Short, human insights derived strictly from the attempt data. */
function buildInsights({ rows, bySubject, byType, byChapter, totals, totalTime, attempt }) {
  const insights = [];
  const attempted = bySubject.filter((subject) => subject.attempted > 0);
  const usedOfTime = totals.time ? totals.time : totalTime;

  if (!rows.length) {
    return [{ text: "There is no scored data for this attempt yet." }];
  }

  if (totals.attempted === 0) {
    insights.push({
      text: "No questions were attempted, so there is no accuracy to read yet.",
    });
    return insights;
  }

  const strongest = [...attempted].sort((a, b) => b.accuracy - a.accuracy)[0];
  const weakest = [...attempted].sort((a, b) => a.accuracy - b.accuracy)[0];

  const attemptWord = totals.attempted === 1 ? "question" : "questions";

  if (strongest && weakest && strongest.key !== weakest.key) {
    insights.push({
      text: `<strong>${strongest.label}</strong> was your steadiest subject at ${pct(strongest.accuracy)} accuracy, while <strong>${weakest.label}</strong> came in at ${pct(weakest.accuracy)}. Start the next session with ${weakest.label.toLowerCase()}.`,
    });
  } else if (strongest) {
    insights.push({
      text: `You answered ${totals.attempted} ${attemptWord} in this paper at <strong>${pct(
        strongest.accuracy,
      )}</strong> accuracy. One subject is enough to find a pattern — finish the paper next time for a full read.`,
    });
  }

  const negative = rows.filter((row) => row.marks < 0);
  if (negative.length >= 3) {
    const lost = Math.round(Math.abs(negative.reduce((sum, row) => sum + row.marks, 0)) * 10) / 10;
    const wrongType = byType
      .filter((type) => type.incorrect > 0)
      .sort((a, b) => b.incorrect - a.incorrect)[0];
    insights.push({
      text: `<strong>${negative.length} wrong answer${negative.length === 1 ? "" : "s"}</strong> cost you ${lost} mark${lost === 1 ? "" : "s"}. ${wrongType ? `Most of them were ${wrongType.label.toLowerCase()} questions (${wrongType.incorrect}).` : ""} A single re-check before marking each answer is worth more than speed here.`,
    });
  }

  if (totals.skipped > 0) {
    const ratio = totals.skipped / totals.total;
    insights.push({
      text: `You left <strong>${totals.skipped} question${totals.skipped === 1 ? "" : "s"}</strong> blank (${pct(ratio)} of the paper). Blank is free of penalty, but it also hides topics you cannot diagnose — attempt them and let the analysis name the gap.`,
    });
  }

  const weakChapters = byChapter
    .filter((chapter) => chapter.attempted >= 2 && chapter.accuracy < 0.5)
    .slice(0, 3)
    .map((chapter) => `<strong>${chapter.chapter}</strong>`);
  if (weakChapters.length) {
    insights.push({
      text: `Chapters to revise first: ${weakChapters.join(", ")}. Each is under 50% accuracy on at least two attempts.`,
    });
  }

  const numerical = byType.find((type) => type.key === "numerical");
  const mcq = byType.find((type) => type.key === "singleCorrect");
  if (numerical && mcq && numerical.attempted >= 2 && mcq.attempted >= 2) {
    if (mcq.accuracy - numerical.accuracy > 0.15) {
      insights.push({
        text: `Options served you better than blanks: MCQ accuracy ${pct(mcq.accuracy)} against ${pct(numerical.accuracy)} on numericals. Practise the numerical flow without options.`,
      });
    } else if (numerical.accuracy - mcq.accuracy > 0.15) {
      insights.push({
        text: `Numericals landed at ${pct(numerical.accuracy)} while MCQs sat at ${pct(mcq.accuracy)} — the options may be pulling you toward traps. Read every option before committing.`,
      });
    }
  }

  const allowed = Number(attempt.allowedSeconds) || 0;
  if (allowed > 0 && usedOfTime > 0) {
    const used = usedOfTime / allowed;
    if (used > 0.97) {
      insights.push({
        text: `You used essentially the whole clock (${pct(Math.min(1, used))} of the allotted time). Since accuracy, not speed, is the margin, plan a 6–8 minute reserve for the final revision pass.`,
      });
    } else if (used < 0.7 && totals.attempted > totals.total * 0.8) {
      insights.push({
        text: `You finished in ${pct(used)} of the available time. With that much headroom, slow down on the last third of the paper and re-derive the answers you were least sure about.`,
      });
    }
  }

  return insights;
}

/**
 * Aggregate answered questions from past attempts into chapter and topic
 * progress, so the question bank can show where you actually stand.
 * Keys are `subject::chapter` and `subject::chapter::topic`.
 */
export function practiceProgress(attempts = []) {
  const chapters = new Map();
  const topics = new Map();

  const bump = (map, key, result, at) => {
    let entry = map.get(key);
    if (!entry) {
      entry = { attempted: 0, correct: 0, partial: 0, incorrect: 0, lastAt: 0 };
      map.set(key, entry);
    }
    entry.attempted += 1;
    if (result.status === "correct") entry.correct += 1;
    else if (result.status === "partial") entry.partial += 1;
    else if (result.status === "incorrect") entry.incorrect += 1;
    entry.lastAt = Math.max(entry.lastAt, at || 0);
  };

  for (const attempt of attempts || []) {
    const finishedAt = attempt.finishedAt || 0;
    for (const question of attempt.questions || []) {
      const answer = attempt.answers?.[question.uid];
      if (!isAnswered(question, answer)) continue;
      const result = scoreQuestion(question, answer);
      const chapter = question.chapter || "";
      bump(chapters, `${question.subject}::${chapter}`, result, finishedAt);
      if (question.topic) {
        bump(topics, `${question.subject}::${chapter}::${question.topic}`, result, finishedAt);
      }
    }
  }

  return { chapters, topics };
}

/** Accuracy for one aggregated progress entry. */
export function progressAccuracy(entry) {
  if (!entry?.attempted) return 0;
  return (entry.correct + entry.partial * 0.5) / entry.attempted;
}

/** Group a list of attempts into a compact history for the library page. */
export function recentAttempts(attempts, limit = 6) {
  return [...(attempts || [])]
    .sort((left, right) => (right.finishedAt || 0) - (left.finishedAt || 0))
    .slice(0, limit);
}

export function formatClock(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
