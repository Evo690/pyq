import {
  dataJson,
  exactPaperYearJson,
  parseNumericalAnswerKey,
  requestExamFullscreen,
} from "./experience.mjs";
import { EXACT_PAPER_CATALOG } from "./exact-paper-catalog.mjs";
import {
  getCachedPaper,
  hydrateQuestionImages,
  listCachedPapers,
  paperCacheKey,
} from "./offline-storage.mjs";
import { OfflinePaperControls } from "./offline-ui.mjs";

const JEE_MAIN_ARCHIVE = "jee-main-papers-by-year.zip";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATH_DEFS_ID = "exact-paper-mathjax-defs";
const MAX_CACHED_YEARS = 2;

const SUBJECT_ORDER = { physics: 0, chemistry: 1, math: 2 };
const QUESTION_TYPE_ORDER = {
  singleCorrect: 0,
  multipleCorrect: 1,
  numerical: 2,
};
const SUBJECT_KEYS = {
  physics: "physics",
  chemistry: "chemistry",
  mathematics: "math",
  maths: "math",
  math: "math",
};

function questionTypeRank(question) {
  return QUESTION_TYPE_ORDER[question?.type] ?? 1;
}

function normalizeSubject(value) {
  return SUBJECT_KEYS[String(value || "").trim().toLowerCase()] || "general";
}

/** Return a normalized, stable catalog for the paper selector. */
export function normalizePaperCatalog(source = []) {
  const papers = Array.isArray(source) ? source : source?.papers || [];
  const sourceCatalog = Array.isArray(source?.chapters) ? source.chapters : [];
  return (Array.isArray(papers) ? papers : [])
    .filter(
      (paper) => paper && typeof paper.title === "string" && paper.title.trim(),
    )
    .map((paper) => {
      const title = paper.title.trim();
      const yearMatch = title.match(/(?:19|20)\d{2}/);
      const labelMatch = title.match(/\d{4}\s*\(([^)]+)\)/);
      const questionCount = Number(paper.questionCount ?? paper.count);

      return {
        ...paper,
        id: String(paper.id || paper.slug || title),
        slug: String(paper.slug || ""),
        title,
        year: String(paper.year || yearMatch?.[0] || ""),
        label: String(paper.label || labelMatch?.[1] || "Full paper"),
        questionCount: Number.isFinite(questionCount) ? questionCount : 0,
        archiveFile: String(paper.archiveFile || ""),
        source: String(paper.source || (paper.archiveFile ? JEE_MAIN_ARCHIVE : "data.zip")),
        sessionOrder: Number.isFinite(Number(paper.sessionOrder))
          ? Number(paper.sessionOrder)
          : 0,
        sources: Array.isArray(paper.sources)
          ? paper.sources
              .map((sourceIndex) =>
                Number.isInteger(sourceIndex)
                  ? sourceCatalog[sourceIndex]
                  : sourceIndex,
              )
              .filter(Boolean)
          : [],
      };
    })
    .filter((paper) => paper.year && paper.questionCount > 0);
}

/** Available years, newest first, for an exam's exact-paper selector. */
export function availablePaperYears(papers = []) {
  return [
    ...new Set(normalizePaperCatalog(papers).map((paper) => paper.year)),
  ].sort((left, right) => Number(right) - Number(left));
}

/** Papers for one year, ordered by exam date/session and then display label. */
export function papersForYear(papers = [], year) {
  return normalizePaperCatalog(papers)
    .filter((paper) => paper.year === String(year))
    .sort(
      (left, right) =>
        String(left.date || "").localeCompare(String(right.date || "")) ||
        Number(left.sessionOrder || 0) - Number(right.sessionOrder || 0) ||
        left.label.localeCompare(right.label),
    );
}

/**
 * Use the year-wise archive for every year it covers; keep older chapter-bank
 * papers (and JEE Advanced papers) available as a fallback.
 */
export function mergePaperCatalogs(archivePapers = [], fallbackPapers = []) {
  const primary = normalizePaperCatalog(archivePapers);
  const coveredYears = new Set(primary.map((paper) => String(paper.year)));
  const archiveDates = new Set(
    primary.map(
      (paper) =>
        `${paper.year}:${String(paper.examDate || paper.date || "").slice(0, 10)}`,
    ),
  );
  const fallback = normalizePaperCatalog(fallbackPapers).filter((paper) => {
    const year = String(paper.year);
    if (!coveredYears.has(year)) return true;
    // Keep chapter-bank sittings from a covered year only when the archive
    // has no paper on that exam date (for example, JEE Main 2018 08 Apr).
    const legacyDate = String(paper.date || paper.examDate || "").slice(0, 10);
    return !archiveDates.has(`${year}:${legacyDate}`);
  });
  const seen = new Set();
  return [...primary, ...fallback].filter((paper) => {
    const key = paper.id || paper.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Load the selector catalog, preferring loose/checked-in catalog data. */
export async function loadPaperCatalog(exam, options = {}) {
  const loadIndex = options.loadIndex || dataJson;
  const builtIn = options.archiveCatalog || EXACT_PAPER_CATALOG;

  if (exam !== "JEE_Main") {
    const index = await loadIndex("papers.json");
    return normalizePaperCatalog(index?.exams?.[exam] || index);
  }

  let archivePapers = normalizePaperCatalog(builtIn?.exams?.[exam] || builtIn);
  try {
    const diskIndex = await loadIndex("exact-papers.json");
    const diskPapers = normalizePaperCatalog(
      diskIndex?.exams?.[exam] || diskIndex,
    );
    if (diskPapers.length) archivePapers = diskPapers;
  } catch {
    // The built-in generated catalog keeps the selector usable offline.
  }

  let legacyPapers = [];
  try {
    const legacyIndex = await loadIndex("papers.json");
    legacyPapers = normalizePaperCatalog(
      legacyIndex?.exams?.[exam] || legacyIndex,
    );
  } catch {
    // Archive papers are still available when the chapter index is missing.
  }

  const merged = mergePaperCatalogs(archivePapers, legacyPapers);
  if (!merged.length) throw new Error("The paper list could not be loaded.");
  return merged;
}

/**
 * Build a complete paper from its source chapter files in JEE section order.
 * This is retained for years/exams that are not present in the year-wise ZIP.
 */
export function buildExactPaperQuestions(groups, exam, paper) {
  if (!paper?.title) return [];

  const seen = new Set();
  const orderedGroups = [...(Array.isArray(groups) ? groups : [])].sort(
    (left, right) => {
      const leftSubject = SUBJECT_ORDER[left.subject] ?? 99;
      const rightSubject = SUBJECT_ORDER[right.subject] ?? 99;
      return (
        leftSubject - rightSubject ||
        String(left.chapter?.name || left.chapter || "").localeCompare(
          String(right.chapter?.name || right.chapter || ""),
        )
      );
    },
  );
  const selected = [];
  let sourceOrder = 0;

  for (const group of orderedGroups) {
    const chapterName =
      typeof group.chapter === "string" ? group.chapter : group.chapter?.name;
    for (const question of group.questions || []) {
      if (question?.paper_year_title !== paper.title) continue;
      const questionId = question.question_id || question.uid;
      if (!questionId) continue;

      const uid = question.uid || `${exam}:${questionId}`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      selected.push({
        order: sourceOrder++,
        item: {
          ...question,
          uid,
          exam,
          subject: group.subject,
          chapter: chapterName || question.chapter || "",
        },
      });
    }
  }

  selected.sort((left, right) => {
    const a = left.item;
    const b = right.item;
    const leftSubject = SUBJECT_ORDER[a.subject] ?? 99;
    const rightSubject = SUBJECT_ORDER[b.subject] ?? 99;
    if (leftSubject !== rightSubject) return leftSubject - rightSubject;

    const leftType = questionTypeRank(a);
    const rightType = questionTypeRank(b);
    if (leftType !== rightType) return leftType - rightType;

    const leftId = String(a.question_id || "");
    const rightId = String(b.question_id || "");
    const idDiff = leftId.localeCompare(rightId);
    if (idDiff !== 0) return idDiff;

    return left.order - right.order;
  });

  return selected.map((entry) => entry.item);
}

function compactPaperSource(paper = {}) {
  const fields = [
    "id",
    "slug",
    "title",
    "year",
    "label",
    "date",
    "examDate",
    "examDateLabel",
    "questionCount",
    "archiveFile",
    "source",
    "sourceUrl",
  ];
  const source = {};
  for (const field of fields) {
    if (paper[field] !== undefined && paper[field] !== null) {
      source[field] = paper[field];
    }
  }
  source.archiveFile = String(paper.archiveFile || "");
  source.slug = String(paper.slug || paper.id || "");
  source.source = String(paper.source || JEE_MAIN_ARCHIVE);
  source.questionCount = Number(paper.questionCount) || 0;
  return source;
}

function parseMathDefPaths(defs, doc) {
  const xml = `<svg xmlns="${SVG_NS}"><defs>${String(defs || "")}</defs></svg>`;
  const Parser =
    typeof DOMParser !== "undefined" ? DOMParser : doc?.defaultView?.DOMParser;
  if (Parser) {
    const parsed = new Parser().parseFromString(xml, "image/svg+xml");
    if (!parsed.querySelector("parsererror")) {
      return [...parsed.querySelectorAll("path")];
    }
  }
  const holder = doc.createElement("div");
  holder.innerHTML = xml;
  return [...holder.querySelectorAll("path")];
}

/**
 * MathJax SVG in the archive references shared <path> definitions by ID.
 * Install only those safe path nodes once in a hidden, global SVG defs host.
 */
export function installExactPaperMathDefs(
  defs,
  sourceKey = "default",
  doc = typeof document !== "undefined" ? document : null,
) {
  if (!doc) return false;
  let host = doc.getElementById(MATH_DEFS_ID);
  const key = String(sourceKey || "default");
  if (host?.getAttribute?.("data-source") === key) return true;

  if (!host) {
    host = doc.createElementNS(SVG_NS, "svg");
    host.setAttribute("id", MATH_DEFS_ID);
    host.setAttribute("class", "exact-paper-mathjax-defs");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("focusable", "false");
    if (host.style) {
      host.style.cssText =
        "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    }
    (doc.body || doc.documentElement).appendChild(host);
  }

  const targetDefs = doc.createElementNS(SVG_NS, "defs");
  let installed = 0;
  for (const sourcePath of parseMathDefPaths(defs, doc)) {
    const id = sourcePath.getAttribute("id");
    const d = sourcePath.getAttribute("d");
    if (!id || !d || !/^[A-Za-z][\w:.-]*$/.test(id)) continue;
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("id", id);
    path.setAttribute("d", d);
    targetDefs.appendChild(path);
    installed += 1;
  }

  if (typeof host.replaceChildren === "function") {
    host.replaceChildren(targetDefs);
  } else {
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(targetDefs);
  }
  host.setAttribute("data-source", key);
  return installed > 0;
}

function sourceTags(question) {
  return (Array.isArray(question?.tags) ? question.tags : [])
    .map((tag) => String(tag).toLowerCase())
    .join(" ");
}

function isBonusSourceQuestion(question) {
  const tags = sourceTags(question);
  const key = String(question?.answerKey || "").trim().toUpperCase();
  return (
    tags.includes("dropped") ||
    tags.includes("bonus") ||
    /^(BONUS|DROP(PED)?|ALL|ALL CORRECT|MARKS TO ALL)$/.test(key)
  );
}

function normalizeArchiveType(question) {
  if (question?.type === "integer") return "numerical";
  const correctCount = Array.isArray(question?.correctOptions)
    ? question.correctOptions.length
    : 0;
  if (
    question?.type === "mcqm" ||
    correctCount > 1 ||
    isBonusSourceQuestion(question)
  ) {
    return "multipleCorrect";
  }
  return "singleCorrect";
}

function normalizeArchiveQuestion(source, context, index) {
  const position = Number.isFinite(Number(source?.position))
    ? Number(source.position)
    : index + 1;
  const sourceId = String(source?.sourceId || `${context.paper.slug}-${position}`);
  const uid = `${context.exam}:exact:${context.paper.slug}:${position}:${sourceId}`;
  const subjectName = String(source?.subject || "General");
  const subject = normalizeSubject(subjectName);
  const type = normalizeArchiveType(source);
  const bonus = isBonusSourceQuestion(source);
  const answerKey = String(source?.answerKey ?? "").trim();
  const options = (Array.isArray(source?.options) ? source.options : []).map(
    (option, optionIndex) => ({
      id: String(option?.label || String.fromCharCode(65 + optionIndex)),
      text: String(option?.html || ""),
      correct: Boolean(option?.correct),
    }),
  );
  const correctOptionIds = (Array.isArray(source?.correctOptions)
    ? source.correctOptions
    : []
  )
    .map((optionIndex) => options[optionIndex]?.id)
    .filter(Boolean);
  const answerKeyLabels = answerKey
    .split(/[^A-D]+/)
    .filter((label) => /^[A-D]$/.test(label));

  let correctAnswer;
  if (type === "numerical") {
    correctAnswer = answerKey;
  } else if (type === "multipleCorrect") {
    correctAnswer = correctOptionIds.length ? correctOptionIds : answerKeyLabels;
  } else {
    correctAnswer =
      correctOptionIds[0] ||
      (/^[A-D]$/.test(answerKey) ? answerKey : options[0]?.id || "");
  }

  const answerRule =
    type === "numerical"
      ? parseNumericalAnswerKey(correctAnswer)
      : bonus
        ? { kind: "bonus", raw: answerKey }
        : undefined;

  return {
    uid,
    question_id: sourceId,
    exam: context.exam,
    subject,
    subjectName,
    chapter: "Original paper",
    topic: "Exact paper",
    difficulty_level: null,
    paper_year_title: context.title,
    paper_year_short: String(context.year),
    paperPosition: position,
    position,
    subjectNumber: source?.subjectNumber ?? null,
    type,
    sourceType: String(source?.type || ""),
    typeLabel: bonus
      ? "Dropped · all options accepted"
      : String(source?.typeLabel || ""),
    marks: source?.marks || { correct: 4, wrong: -1 },
    question_text: String(source?.questionHtml || ""),
    solution_text: String(source?.solutionHtml || ""),
    options,
    correct_answer: correctAnswer,
    answerKey,
    answerSource: String(source?.answerSource || ""),
    correctOptions: Array.isArray(source?.correctOptions)
      ? [...source.correctOptions]
      : [],
    tags: Array.isArray(source?.tags) ? [...source.tags] : [],
    sourceUrl: String(source?.sourceUrl || ""),
    bonus,
    answerRule,
    paperSource: context.paperSource,
    source: JEE_MAIN_ARCHIVE,
  };
}

function findArchivePaper(yearData, paper) {
  const papers = Array.isArray(yearData?.papers)
    ? yearData.papers
    : Array.isArray(yearData?.questions)
      ? [yearData]
      : [];
  return (
    papers.find(
      (entry) => paper?.slug && String(entry?.slug) === String(paper.slug),
    ) ||
    papers.find(
      (entry) => paper?.title && String(entry?.title) === String(paper.title),
    ) ||
    papers.find(
      (entry) => paper?.id && String(entry?.id) === String(paper.id),
    ) ||
    null
  );
}

/**
 * Convert one source paper into app questions while keeping the archive's
 * exact `position` order, subject sequence, HTML, options, keys, and solutions.
 */
export function normalizeArchivePaperQuestions(
  yearData,
  paper,
  exam = "JEE_Main",
  options = {},
) {
  const sourcePaper = findArchivePaper(yearData, paper);
  if (!sourcePaper) {
    throw new Error(`The selected paper was not found in ${paper?.archiveFile || JEE_MAIN_ARCHIVE}.`);
  }

  const archiveFile = String(paper?.archiveFile || sourcePaper.archiveFile || "");
  const mergedPaper = {
    ...paper,
    ...sourcePaper,
    slug: String(paper?.slug || sourcePaper.slug || ""),
    archiveFile,
    title: String(sourcePaper.title || paper?.title || ""),
    year: sourcePaper.year || paper?.year,
    questionCount: Number(
      sourcePaper.questions?.length ?? paper?.questionCount ?? 0,
    ),
    source: JEE_MAIN_ARCHIVE,
  };
  const paperSource = compactPaperSource(mergedPaper);
  const context = {
    exam,
    paper: mergedPaper,
    paperSource,
    title: mergedPaper.title,
    year: mergedPaper.year,
  };

  if (options.installDefs !== false) {
    installExactPaperMathDefs(yearData?.mathjaxDefs, archiveFile || mergedPaper.slug);
  }

  return (Array.isArray(sourcePaper.questions) ? sourcePaper.questions : [])
    .map((question, index) => normalizeArchiveQuestion(question, context, index))
    .sort(
      (left, right) =>
        Number(left.paperPosition) - Number(right.paperPosition) ||
        left.uid.localeCompare(right.uid),
    );
}

const exactPaperYearCache = new Map();

/** Drop memoized year files (so the offline copy is the only source left). */
export function resetExactPaperYearCache() {
  exactPaperYearCache.clear();
}

/** Small LRU cache: one 45 MB year file is enough; avoid retaining all years. */
export async function loadExactPaperYear(
  fileName,
  loader = exactPaperYearJson,
) {
  const key = String(fileName || "");
  if (!key) throw new Error("The exact-paper archive file is missing.");
  if (!exactPaperYearCache.has(key)) {
    const promise = Promise.resolve()
      .then(() => loader(key))
      .catch((error) => {
        if (exactPaperYearCache.get(key) === promise) {
          exactPaperYearCache.delete(key);
        }
        throw error;
      });
    exactPaperYearCache.set(key, promise);
    while (exactPaperYearCache.size > MAX_CACHED_YEARS) {
      const oldest = exactPaperYearCache.keys().next().value;
      exactPaperYearCache.delete(oldest);
    }
  }
  return exactPaperYearCache.get(key);
}

/**
 * Load the exact paper. A previously downloaded offline copy (IndexedDB)
 * is preferred so the paper — with every embedded diagram — works with no
 * network and still scores through the normal result flow. Otherwise the
 * paper is read from the year-wise ZIP (or chapter files) and any cached
 * images are hydrated to blob: URLs.
 */
export async function loadExactPaperQuestions(exam, paper, options = {}) {
  const useCache = options.useCache !== false;
  if (useCache && paper?.title) {
    try {
      const cached = await getCachedPaper(paper);
      if (
        cached &&
        Array.isArray(cached.questions) &&
        cached.questions.length
      ) {
        const expected = Number(
          paper.questionCount || cached.questionCount || 0,
        );
        if (!expected || cached.questions.length === expected) {
          if (cached.mathjaxDefs) {
            installExactPaperMathDefs(
              cached.mathjaxDefs,
              paper.archiveFile || paper.slug || cached.key,
            );
          }
          return await hydrateQuestionImages(cached.questions);
        }
      }
    } catch {
      // Cache read failures must never break online loading.
    }
  }

  let questions;
  if (exam === "JEE_Main" && paper?.archiveFile) {
    const yearData = await loadExactPaperYear(
      paper.archiveFile,
      options.loadYear || exactPaperYearJson,
    );
    questions = normalizeArchivePaperQuestions(yearData, paper, exam, options);
    if (!questions.length) {
      throw new Error("No questions were found for this paper in the source archive.");
    }
  } else {
    const sources = [...(paper?.sources || [])].sort((left, right) => {
      const leftSubject = SUBJECT_ORDER[left.subject] ?? 99;
      const rightSubject = SUBJECT_ORDER[right.subject] ?? 99;
      return (
        leftSubject - rightSubject ||
        String(left.chapter || "").localeCompare(String(right.chapter || ""))
      );
    });

    const groups = await Promise.all(
      sources.map(async (source) => ({
        subject: source.subject,
        chapter: source.chapter,
        questions: await dataJson(`${exam}/${source.file}`),
      })),
    );

    questions = buildExactPaperQuestions(groups, exam, paper);
  }

  if (useCache) {
    try {
      return await hydrateQuestionImages(questions);
    } catch {
      return questions;
    }
  }
  return questions;
}

function responseFields(stored) {
  if (!stored) return {};
  const fields = ["userAnswer", "isCorrect", "timeSpentSeconds"];
  const response = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(stored, field)) {
      response[field] = stored[field];
    }
  }
  return response;
}

/**
 * Completed exact-paper tests store small response refs rather than repeating
 * megabytes of HTML/MathJax in localStorage. Rehydrate them from the ZIP.
 */
export function compactExactPaperTest(test) {
  if (!test?.exactPaperSource) return test;
  return {
    ...test,
    questions: (Array.isArray(test.questions) ? test.questions : []).map(
      (question) => ({
        uid: question.uid,
        question_id: question.question_id,
        subject: question.subject,
        chapter: question.chapter,
        topic: question.topic,
        type: question.type,
        difficulty_level: question.difficulty_level ?? null,
        paper_year_title: question.paper_year_title,
        paper_year_short: question.paper_year_short,
        paperPosition: question.paperPosition,
        correct_answer: question.correct_answer,
        answerKey: question.answerKey,
        answerRule: question.answerRule,
        bonus: Boolean(question.bonus),
        options: (question.options || []).map((option) => ({ id: option.id })),
        userAnswer: question.userAnswer,
        isCorrect: question.isCorrect,
        timeSpentSeconds: question.timeSpentSeconds || 0,
      }),
    ),
  };
}

export async function restoreExactPaperTest(
  test,
  loader = loadExactPaperQuestions,
) {
  if (!test?.exactPaperSource) return test;
  const sourceQuestions = await loader("JEE_Main", test.exactPaperSource);
  const stored = new Map(
    (Array.isArray(test.questions) ? test.questions : []).map((question) => [
      question.uid,
      question,
    ]),
  );
  return {
    ...test,
    questions: sourceQuestions.map((question) => ({
      ...question,
      ...responseFields(stored.get(question.uid)),
    })),
  };
}

export async function restoreExactPaperSession(
  draft,
  loader = loadExactPaperQuestions,
) {
  if (!draft?.exactPaperSource) return [];
  const refs = Array.isArray(draft.questionRefs) ? draft.questionRefs : [];
  const restored = await restoreExactPaperTest(
    {
      ...draft,
      questions: refs.map((ref) => ({
        ...ref,
        userAnswer: draft.answers?.[ref.uid],
        timeSpentSeconds: draft.questionTimes?.[ref.uid] || 0,
        isCorrect: null,
      })),
    },
    loader,
  );
  return restored.questions;
}

function PaperSelect({ React, label, value, disabled, onChange, children }) {
  const h = React.createElement;
  return h("label", { className: "exact-paper-field" }, [
    h("span", { key: "label" }, label),
    h(
      "select",
      {
        key: "select",
        value,
        disabled,
        onChange: (event) => onChange(event.target.value),
      },
      children,
    ),
  ]);
}

/**
 * Test Studio's exact-paper picker. React is passed by the built application so
 * this source module can stay independent of the bundled React runtime.
 */
export function ExactPaperPicker({ React, exam, start }) {
  const h = React.createElement;
  const [catalog, setCatalog] = React.useState([]);
  const [catalogExam, setCatalogExam] = React.useState("");
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [catalogError, setCatalogError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const [year, setYear] = React.useState("");
  const [paperId, setPaperId] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState("");
  const [cachedKeys, setCachedKeys] = React.useState(() => new Set());

  const refreshCachedKeys = React.useCallback(async () => {
    try {
      const summaries = await listCachedPapers();
      setCachedKeys(new Set(summaries.map((entry) => entry.key)));
    } catch {
      // Offline badges are best-effort.
    }
  }, []);

  React.useEffect(() => {
    refreshCachedKeys();
  }, [refreshCachedKeys, exam]);

  React.useEffect(() => {
    let current = true;
    setCatalogLoading(true);
    setCatalogError("");
    setCatalogExam("");
    loadPaperCatalog(exam)
      .then((papers) => {
        if (!current) return;
        const years = availablePaperYears(papers);
        const firstYear = years[0] || "";
        setCatalog(papers);
        setCatalogExam(exam);
        setYear(firstYear);
        setPaperId(papersForYear(papers, firstYear)[0]?.id || "");
      })
      .catch((loadError) => {
        if (current)
          setCatalogError(
            loadError?.message || "The paper list could not be loaded.",
          );
      })
      .finally(() => {
        if (current) setCatalogLoading(false);
      });
    return () => {
      current = false;
    };
  }, [exam, retry]);

  const papers = catalogExam === exam ? catalog : [];
  const years = availablePaperYears(papers);
  const yearPapers = papersForYear(papers, year);
  const selected =
    yearPapers.find((paper) => paper.id === paperId) || yearPapers[0] || null;
  const examName = exam === "JEE_Main" ? "JEE Main" : "JEE Advanced";
  const fromArchive = Boolean(selected?.archiveFile);

  const beginMock = async () => {
    if (!selected || starting) return;
    setStarting(true);
    setError("");
    requestExamFullscreen();
    try {
      const questions = await loadExactPaperQuestions(exam, selected);
      if (!questions.length) {
        throw new Error(
          "No questions were found for this paper in the source archive.",
        );
      }
      if (questions.length !== selected.questionCount) {
        throw new Error(
          `The source returned ${questions.length} of ${selected.questionCount} questions. The mock was not started so you won't get a partial paper.`,
        );
      }
      start(questions, selected.title, "test", 180, true);
    } catch (loadError) {
      setError(
        loadError?.message || "The selected paper could not be prepared.",
      );
    } finally {
      setStarting(false);
    }
  };

  const yearOptions = years.map((availableYear) =>
    h("option", { key: availableYear, value: availableYear }, availableYear),
  );
  const paperOptions = yearPapers.map((paper) =>
    h(
      "option",
      { key: paper.id, value: paper.id },
      `${paper.label} · ${paper.questionCount} questions${
        cachedKeys.has(paperCacheKey(paper)) ? " · saved offline" : ""
      }`,
    ),
  );
  const selectedCached = selected
    ? cachedKeys.has(paperCacheKey(selected))
    : false;
  const count = selected?.questionCount || 0;
  const subjectSummary = selected
    ? [
        ["physics", "Physics"],
        ["chemistry", "Chemistry"],
        ["math", "Mathematics"],
      ]
        .filter(([key]) => Number(selected.subjects?.[key]) > 0)
        .map(([key, label]) => `${label} ${selected.subjects[key]}`)
        .join(" · ")
    : "";

  const description =
    exam === "JEE_Main"
      ? "Choose a year and shift to sit the original JEE Main paper. Its questions, options, answer keys and worked solutions come directly from the year-wise archive in the exact source order. Papers not represented in the archive use the chapter question bank."
      : "Choose a year and paper to sit a complete JEE Advanced paper from the question bank, ordered by subject—MCQs first, then numerical-value questions.";

  const note =
    exam === "JEE_Advanced"
      ? "Choose Paper 1 or Paper 2. This practice mock uses +4 / −1 scoring; multi-correct responses are included but left unscored when source keys are incomplete."
      : "Three-hour timed mock using +4 / −1 scoring. Range, alternate-value, dropped and bonus keys are preserved from the source and left unscored rather than marked wrong.";

  return h(
    "section",
    { className: "exact-paper-card", "aria-labelledby": "exact-paper-heading" },
    [
      h("div", { className: "exact-paper-copy", key: "copy" }, [
        h("div", { className: "exact-paper-eyebrow", key: "eyebrow" }, [
          h(
            "span",
            {
              className: "exact-paper-mark",
              "aria-hidden": "true",
              key: "mark",
            },
            "✦",
          ),
          " ORIGINAL PAPER · TIMED MOCK",
        ]),
        h("h2", { id: "exact-paper-heading", key: "heading" }, [
          "The exact PYQ paper",
          h("span", { className: "exact-paper-period", key: "period" }, "."),
        ]),
        h(
          "p",
          { className: "exact-paper-description", key: "description" },
          description,
        ),
        h("div", { className: "exact-paper-facts", key: "facts" }, [
          h(
            "span",
            { key: "count" },
            count ? `${count} original questions` : "Full original paper",
          ),
          h(
            "span",
            {
              className: "exact-paper-fact-divider",
              "aria-hidden": "true",
              key: "dot",
            },
            "·",
          ),
          h("span", { key: "duration" }, "3-hour timer"),
          h(
            "span",
            {
              className: "exact-paper-fact-divider",
              "aria-hidden": "true",
              key: "dot-2",
            },
            "·",
          ),
          h("span", { key: "solutions" }, "Worked solutions"),
        ]),
        h("p", { className: "exact-paper-note", key: "note" }, note),
      ]),
      h("div", { className: "exact-paper-setup", key: "setup" }, [
        h("div", { className: "exact-paper-selectors", key: "selectors" }, [
          h(PaperSelect, {
            React,
            key: "year-select",
            label: "Year",
            value: year,
            disabled: catalogLoading || !years.length,
            onChange: (nextYear) => {
              setYear(nextYear);
              setPaperId(papersForYear(papers, nextYear)[0]?.id || "");
              setError("");
            },
            children: yearOptions,
          }),
          h(PaperSelect, {
            React,
            key: "paper-select",
            label: exam === "JEE_Main" ? "Shift / session" : "Paper",
            value: selected?.id || "",
            disabled: catalogLoading || !yearPapers.length,
            onChange: (nextPaper) => {
              setPaperId(nextPaper);
              setError("");
            },
            children: paperOptions,
          }),
        ]),
        selected &&
          h("div", { className: "exact-paper-selection", key: "selection" }, [
            h("strong", { key: "title" }, selected.title),
            subjectSummary && h("span", { key: "subjects" }, subjectSummary),
            h(
              "span",
              { key: "source", className: "exact-paper-source-note" },
              fromArchive
                ? "Year-wise ZIP · exact order · worked solutions"
                : "Chapter bank · JEE section order",
            ),
          ]),
        catalogError
          ? h(
              "div",
              {
                className: "exact-paper-error",
                role: "alert",
                key: "catalog-error",
              },
              [
                h("span", { key: "message" }, catalogError),
                h(
                  "button",
                  {
                    type: "button",
                    className: "exact-paper-retry",
                    onClick: () => setRetry((value) => value + 1),
                    key: "retry",
                  },
                  "Try again",
                ),
              ],
            )
          : error &&
            h(
              "p",
              { className: "exact-paper-error", role: "alert", key: "error" },
              error,
            ),
        h(
          "button",
          {
            type: "button",
            className: "btn primary exact-paper-start",
            disabled:
              catalogLoading ||
              starting ||
              !selected ||
              typeof start !== "function",
            onClick: beginMock,
            key: "start",
          },
          starting
            ? "Preparing the original paper…"
            : catalogLoading
              ? "Loading available papers…"
              : "Start exact mock",
        ),
        h(
          "span",
          { className: "exact-paper-start-hint", key: "hint" },
          catalogLoading
            ? "Getting the paper list ready"
            : selected
              ? `${examName} · ${selected.year} · ${selected.label}${
                  selectedCached ? " · offline ready" : ""
                }`
              : "No papers available for this exam",
        ),
        selected &&
          h(OfflinePaperControls, {
            React,
            key: `offline-${selected.id}`,
            exam,
            paper: selected,
            loadQuestions: (loadExam, loadPaper) =>
              loadExactPaperQuestions(loadExam, loadPaper, { useCache: false }),
            loadYearData: (fileName) => exactPaperYearJson(fileName),
            onStatusChange: refreshCachedKeys,
          }),
      ]),
    ],
  );
}
