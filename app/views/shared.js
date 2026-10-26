/** Bits of UI and flow shared by several views. */

import { EXAM_LABEL, SUBJECT_LABEL } from "../core.js";
import { confirmDialog, escapeHtml, toast } from "../dom.js";
import { loadPaperQuestions, loadPracticeQuestions } from "../data.js";
import { getSession, hasOfflinePaper, seenMap } from "../store.js";
import { startSession } from "../session.js";

export const EXAMS = [
  ["JEE_Main", "JEE Main"],
  ["JEE_Advanced", "JEE Advanced"],
];

export function examLabel(exam) {
  return EXAM_LABEL[exam] || exam;
}

export function examSwitch(ctx) {
  return `<div class="seg" role="group" aria-label="Exam">
    ${EXAMS.map(
      ([key, label]) =>
        `<button type="button" data-action="set-exam" data-exam="${key}" class="${
          ctx.exam === key ? "is-active" : ""
        }" aria-pressed="${ctx.exam === key}">${label}</button>`,
    ).join("")}
  </div>`;
}

export function bindExamSwitch(root, ctx) {
  root.addEventListener("click", (event) => {
    const button = event.target.closest('[data-action="set-exam"]');
    if (!button) return;
    ctx.setExam(button.dataset.exam);
  });
}

export function subjectSplit(subjects) {
  const entries = ["physics", "chemistry", "math"]
    .map((key) => ({ key, count: Number(subjects?.[key] || 0) }))
    .filter((entry) => entry.count > 0);
  if (!entries.length) return "";
  return `<span class="paper-subjects">${entries
    .map(
      (entry) =>
        `<span class="s-${entry.key}" title="${SUBJECT_LABEL[entry.key]} ${entry.count} questions">${
          SUBJECT_LABEL[entry.key].slice(0, 3)
        } <b class="mono">${entry.count}</b></span>`,
    )
    .join("")}</span>`;
}

export function offlineChip(paper) {
  return hasOfflinePaper(paper.key)
    ? `<span class="chip saved" title="Saved in this browser">Saved offline</span>`
    : "";
}

/**
 * Load a paper's questions (offline copy first) and open the timed session.
 */
/** Starting something new silently would throw away recorded answers. */
async function confirmReplace(next) {
  const paused = getSession();
  const answered = Object.keys(paused?.answers || {}).length;
  if (!answered) return true;
  return confirmDialog({
    title: "Replace the unfinished sitting?",
    body: `“${paused.title || "An earlier sitting"}” is still open with ${answered} answer${
      answered === 1 ? "" : "s"
    } recorded. Starting ${next} discards it.`,
    confirm: "Start new sitting",
  });
}

export async function beginPaper(ctx, paper, { onStatus } = {}) {
  if (!(await confirmReplace("this paper"))) return null;
  onStatus?.("Loading the paper…");
  const result = await loadPaperQuestions(paper.exam, paper, {
    onProgress: (done, total) => onStatus?.(`Reading chapter files… ${done}/${total}`),
  });
  if (!result.questions.length) {
    throw new Error("This paper could not be assembled from the question bank.");
  }
  const session = startSession({
    mode: "paper",
    exam: paper.exam,
    title: paper.title,
    paperKey: paper.key,
    questions: result.questions,
    allowedSeconds: 3 * 60 * 60,
    source: result.source,
  });
  if (result.source === "offline") {
    toast("Starting from the offline copy saved in this browser.", "warn");
  }
  ctx.navigate("#/session");
  return session;
}

/** Build and open an untimed chapter practice session. */
export async function beginPractice(ctx, { exam, chapters, count, difficulty, title }) {
  if (!chapters.length) throw new Error("Select at least one chapter to practise.");
  if (!(await confirmReplace("a practice set"))) return null;
  const questions = await loadPracticeQuestions(exam, chapters, count, { seen: seenMap() });
  const filtered =
    difficulty && difficulty !== "all"
      ? questions.filter((question) => String(question.difficulty) === difficulty)
      : questions;
  const chosen = filtered.length ? filtered : questions;
  if (!chosen.length) throw new Error("No questions matched those chapters.");
  startSession({
    mode: "practice",
    exam,
    title: title || `${examLabel(exam)} practice`,
    paperKey: "",
    questions: chosen,
    allowedSeconds: 0,
    source: "network",
  });
  ctx.navigate("#/session");
  return chosen;
}

export function errorHtml(message) {
  return `<div class="notice bad" role="alert">${escapeHtml(message)}</div>`;
}

export function emptyState({ title, body, action = "" }) {
  return `<div class="empty"><strong>${escapeHtml(title)}</strong>${escapeHtml(body)}${
    action ? `<div class="actions" style="justify-content:center;margin-top:16px">${action}</div>` : ""
  }</div>`;
}
