/** The practice/test engine: scoring state, timing, autosave and submission. */

import { isAnswered, scoreQuestion } from "./core.js";
import { clearSession, getSession, markSeen, saveAttempt, saveSession } from "./store.js";

let current = null;
let flushTimer = null;

const SAVE_INTERVAL = 5000;

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function getCurrent() {
  return current;
}

function flushTime() {
  if (!current) return;
  const now = Date.now();
  const delta = Math.round((now - (current.questionStartedAt || now)) / 1000);
  current.questionStartedAt = now;
  if (delta <= 0) return;
  const uid = current.questions[current.index]?.uid;
  if (!uid) return;
  current.times[uid] = (current.times[uid] || 0) + delta;
  current.elapsed = (current.elapsed || 0) + delta;
}

function persist() {
  if (!current) return;
  flushTime();
  saveSession({ ...current, savedAt: Date.now() });
}

export function startSession({
  mode = "paper",
  exam,
  title,
  paperKey = "",
  questions = [],
  allowedSeconds = 0,
  source = "network",
}) {
  current = {
    id: makeId("s"),
    mode,
    exam,
    title,
    paperKey,
    source,
    questions,
    answers: {},
    times: {},
    flags: [],
    index: 0,
    allowedSeconds,
    startedAt: Date.now(),
    questionStartedAt: Date.now(),
    elapsed: 0,
    savedAt: Date.now(),
  };
  persist();
  startTicker();
  return current;
}

export function restoreSession() {
  const saved = getSession();
  if (!saved?.questions?.length) return null;
  current = { ...saved, questionStartedAt: Date.now() };
  startTicker();
  return current;
}

/** Stop the clock while the student is elsewhere; the sitting stays resumable. */
export function pauseSession() {
  if (!current) return;
  flushTime();
  stopTicker();
  saveSession({ ...current, savedAt: Date.now() });
}

/** Restart the clock when the sitting view is opened again. */
export function resumeSession() {
  if (!current) return;
  current.questionStartedAt = Date.now();
  startTicker();
}

export function endSession() {
  stopTicker();
  current = null;
  clearSession();
}

function startTicker() {
  stopTicker();
  flushTimer = setInterval(() => {
    if (!current) return;
    flushTime();
    saveSession({ ...current, savedAt: Date.now() });
  }, SAVE_INTERVAL);
}

function stopTicker() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
}

export function remainingSeconds() {
  if (!current || !current.allowedSeconds) return null;
  const used = Math.floor((Date.now() - current.startedAt) / 1000);
  return Math.max(0, current.allowedSeconds - used);
}

export function goTo(index) {
  if (!current) return;
  flushTime();
  current.index = Math.max(0, Math.min(current.questions.length - 1, index));
  current.questionStartedAt = Date.now();
  persist();
}

export function setAnswer(value) {
  if (!current) return;
  const question = current.questions[current.index];
  if (!question) return;
  if (isAnswered(question, value)) current.answers[question.uid] = value;
  else delete current.answers[question.uid];
  persist();
}

export function clearAnswer() {
  if (!current) return;
  const question = current.questions[current.index];
  if (!question) return;
  delete current.answers[question.uid];
  persist();
}

export function toggleFlag() {
  if (!current) return;
  const uid = current.questions[current.index]?.uid;
  if (!uid) return;
  current.flags = current.flags.includes(uid)
    ? current.flags.filter((value) => value !== uid)
    : [...current.flags, uid];
  persist();
}

export function answeredCount() {
  if (!current) return 0;
  return current.questions.filter((question) => isAnswered(question, current.answers[question.uid])).length;
}

export function elapsedSeconds() {
  if (!current) return 0;
  const live =
    current.allowedSeconds > 0
      ? Math.min(current.allowedSeconds, Math.floor((Date.now() - current.startedAt) / 1000))
      : Math.round(((current.elapsed || 0) * 1000 + (Date.now() - current.questionStartedAt)) / 1000);
  return Math.max(0, live);
}

export function submit({ auto = false } = {}) {
  if (!current) return null;
  flushTime();
  const questions = current.questions;
  const attempt = {
    id: makeId("a"),
    mode: current.mode,
    exam: current.exam,
    title: current.title,
    paperKey: current.paperKey,
    source: current.source,
    createdAt: current.startedAt,
    finishedAt: Date.now(),
    allowedSeconds: current.allowedSeconds,
    timeUsed: elapsedSeconds(),
    autoSubmitted: Boolean(auto),
    questions,
    answers: { ...current.answers },
    times: { ...current.times },
    flags: [...current.flags],
  };
  saveAttempt(attempt);
  markSeen(questions.map((question) => question.uid));
  endSession();
  return attempt;
}

/** Flush any pending timing when the page is hidden or closed. */
export function flush() {
  if (!current) return;
  persist();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
