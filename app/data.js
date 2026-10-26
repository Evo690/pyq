/**
 * Data access: the bundled question bank plus the localStorage copy that makes
 * downloaded papers work with no network at all.
 */

import {
  buildPaperQuestions,
  normalizePaperCatalog,
  normalizeQuestion,
  orderPaperQuestions,
  paperSources,
} from "./core.js";
import { getOfflinePaper, listOfflinePapers, saveOfflinePaper } from "./store.js";

const cache = new Map();

export async function fetchJson(path, options = {}) {
  const url = `/data/${path.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, { cache: options.cache || "default" });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? `The file ${path} is missing from the question bank.`
        : `The question bank could not be read (${response.status}).`,
    );
  }
  return response.json();
}

function once(key, loader) {
  if (!cache.has(key)) {
    cache.set(
      key,
      loader().catch((error) => {
        cache.delete(key);
        throw error;
      }),
    );
  }
  return cache.get(key);
}

/** Compact chapter catalog (names, files, counts) for the practice browser. */
export function getIndex() {
  return once("index", () => fetchJson("index.json"));
}

/** Raw papers.json, which holds both the chapter list and the paper catalog. */
export function getPapersFile() {
  return once("papers", () => fetchJson("papers.json"));
}

export async function getExamIndex(exam) {
  const file = await getPapersFile();
  return file?.exams?.[exam] || { chapters: [], papers: [] };
}

export async function getPaperCatalog(exam) {
  const examIndex = await getExamIndex(exam);
  return normalizePaperCatalog(exam, { exams: { [exam]: examIndex } });
}

export function isOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Fetch a paper from the network and return its questions in exam order:
 * subject by subject, MCQs first, then numericals.
 */
export async function fetchPaperQuestions(exam, paper, { onProgress } = {}) {
  const examIndex = await getExamIndex(exam);
  const sources = paperSources({ exams: { [exam]: examIndex } }, exam, paper);
  const unique = [];
  const seenFiles = new Set();
  for (const source of sources) {
    if (seenFiles.has(source.file)) continue;
    seenFiles.add(source.file);
    unique.push(source);
  }
  if (!unique.length) {
    throw new Error(
      "This paper has no chapter references in the bundled index, so its questions cannot be loaded.",
    );
  }

  let done = 0;
  onProgress?.(0, unique.length);
  const groups = await mapLimit(unique, 6, async (source) => {
    const questions = await fetchJson(`${exam}/${source.file}`);
    done += 1;
    onProgress?.(done, unique.length);
    return { subject: source.subject, chapter: source.chapter, questions };
  });

  return buildPaperQuestions(groups, exam, paper);
}

/**
 * Resolve a paper for a session. An offline copy always wins: it was captured
 * with the same ordering and needs no network.
 */
export async function loadPaperQuestions(exam, paper, options = {}) {
  const offline = getOfflinePaper(paper.key);
  if (offline?.questions?.length) {
    return { questions: offline.questions, source: "offline", savedAt: offline.savedAt };
  }
  const questions = await fetchPaperQuestions(exam, paper, options);
  return { questions, source: "network" };
}

const IMAGE_PATTERN = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;

function collectImageUrls(questions) {
  const urls = new Set();
  for (const question of questions) {
    const blobs = [question.text, question.solution];
    for (const option of question.options || []) blobs.push(option.text);
    for (const blob of blobs) {
      if (!blob || !blob.includes("<img")) continue;
      IMAGE_PATTERN.lastIndex = 0;
      let match;
      while ((match = IMAGE_PATTERN.exec(blob))) {
        if (/^https?:/i.test(match[1])) urls.add(match[1]);
      }
    }
  }
  return [...urls];
}

/**
 * Warm the service-worker cache with diagram images. Cross-origin images are
 * fetched as opaque responses, which Cache Storage can still replay offline.
 */
async function warmImages(urls, onProgress) {
  if (!urls.length) return { total: 0, cached: 0 };
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
    return { total: urls.length, cached: 0 };
  }
  let cached = 0;
  let done = 0;
  await mapLimit(urls, 5, async (url) => {
    try {
      await fetch(url, { mode: "no-cors", cache: "force-cache" });
      cached += 1;
    } catch {
      /* diagrams stay online-only */
    }
    done += 1;
    onProgress?.(done, urls.length);
  });
  return { total: urls.length, cached };
}

/**
 * Download a paper into localStorage so it can be opened with no network and
 * analysed later. `onStatus` receives short human-readable progress lines.
 */
export async function downloadPaper(exam, paper, { onStatus } = {}) {
  onStatus?.({ phase: "fetch", message: "Reading the paper from the question bank…" });
  const questions = await fetchPaperQuestions(exam, paper, {
    onProgress: (done, total) =>
      onStatus?.({
        phase: "fetch",
        message: `Reading chapter files… ${done}/${total}`,
        done,
        total,
      }),
  });

  if (!questions.length) {
    throw new Error("No questions from this paper were found in the question bank.");
  }

  const images = collectImageUrls(questions);
  let imageResult = { total: 0, cached: 0 };
  if (images.length) {
    onStatus?.({
      phase: "images",
      message: `Caching ${images.length} diagram${images.length === 1 ? "" : "s"} for offline use…`,
    });
    imageResult = await warmImages(images, (done, total) =>
      onStatus?.({ phase: "images", message: `Caching diagrams… ${done}/${total}`, done, total }),
    );
  }

  onStatus?.({ phase: "save", message: "Saving to this browser…" });
  const entry = {
    key: paper.key,
    exam,
    title: paper.title,
    label: paper.label,
    year: paper.year,
    questionCount: questions.length,
    subjects: questions.reduce((acc, question) => {
      acc[question.subject] = (acc[question.subject] || 0) + 1;
      return acc;
    }, {}),
    questions,
    images: imageResult,
  };

  const saved = saveOfflinePaper(entry);
  saved.bytes = Math.round(JSON.stringify(saved).length * 2);
  return saved;
}

/** Offline library entries, decorated with how they compare to the catalog. */
export function offlineLibrary(exam) {
  const entries = listOfflinePapers();
  return exam ? entries.filter((entry) => entry.exam === exam) : entries;
}

/**
 * Load chapter questions for a free-practice session and take a balanced
 * random sample: unseen questions first, MCQ/numerical mixed.
 */
export async function loadPracticeQuestions(exam, chapterFiles, count, { seen = {} } = {}) {
  const seenFiles = [...new Set(chapterFiles)];
  const groups = await mapLimit(seenFiles, 5, async (source) => {
    const raw = await fetchJson(`${exam}/${source.file}`);
    return raw
      .map((item) =>
        normalizeQuestion(item, {
          exam,
          subject: source.subject,
          chapter: source.name,
        }),
      )
      .filter(Boolean);
  });

  const pool = [];
  const seenUids = new Set();
  for (const group of groups) {
    for (const question of group) {
      if (seenUids.has(question.uid)) continue;
      seenUids.add(question.uid);
      question.order = pool.length;
      pool.push(question);
    }
  }

  const fresh = pool.filter((question) => !seen[question.uid]);
  const stale = pool
    .filter((question) => seen[question.uid])
    .sort((left, right) => (seen[left.uid] || 0) - (seen[right.uid] || 0));

  const candidates = [...shuffle(fresh), ...stale].slice(0, Math.max(1, count));
  const ordered = orderPaperQuestions(candidates);

  // Section order groups MCQs first; shuffle stays inside a section.
  return rebalanceTypes(ordered);
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/** Mix numericals through a practice set instead of dumping them at the end. */
function rebalanceTypes(questions) {
  const numerical = shuffle(questions.filter((question) => question.type === "numerical"));
  const choices = shuffle(questions.filter((question) => question.type !== "numerical"));
  if (!numerical.length || !choices.length) return shuffle(questions);
  const mixed = [];
  let numericalIndex = 0;
  let choiceIndex = 0;
  while (numericalIndex < numerical.length || choiceIndex < choices.length) {
    for (let i = 0; i < 2 && choiceIndex < choices.length; i += 1) {
      mixed.push(choices[choiceIndex++]);
    }
    if (numericalIndex < numerical.length) mixed.push(numerical[numericalIndex++]);
  }
  return mixed;
}
