/**
 * Local persistence. Everything the workspace knows lives in localStorage:
 * downloaded papers (for offline study), finished attempts, the in-progress
 * session, and interface preferences.
 */

const NS = "pyq.studio.v2";
const KEYS = {
  papers: `${NS}.offline-papers`,
  attempts: `${NS}.attempts`,
  session: `${NS}.session`,
  prefs: `${NS}.prefs`,
  seen: `${NS}.seen`,
};

const MAX_ATTEMPTS = 8;

function readRaw(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class StorageFullError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageFullError";
  }
}

function isQuotaError(error) {
  return (
    error &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.code === 22 ||
      error.code === 1014)
  );
}

function writeRaw(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    if (isQuotaError(error)) {
      const quota = new StorageFullError(
        "This browser's local storage is full. Remove a downloaded paper or an older analysis, then try again.",
      );
      quota.quota = true;
      throw quota;
    }
    throw error;
  }
}

/* ---------------------------------------------------------------- offline */

export function listOfflinePapers() {
  const map = readRaw(KEYS.papers, {});
  return Object.values(map || {}).sort((left, right) => (right.savedAt || 0) - (left.savedAt || 0));
}

export function getOfflinePaper(key) {
  const map = readRaw(KEYS.papers, {});
  return map?.[key] || null;
}

export function hasOfflinePaper(key) {
  return Boolean(getOfflinePaper(key));
}

/** Save a downloaded paper. Throws StorageFullError when the quota is hit. */
export function saveOfflinePaper(entry) {
  const map = readRaw(KEYS.papers, {}) || {};
  const previous = map[entry.key];
  map[entry.key] = {
    ...entry,
    savedAt: previous?.savedAt || Date.now(),
    updatedAt: Date.now(),
  };
  writeRaw(KEYS.papers, map);
  return map[entry.key];
}

export function removeOfflinePaper(key) {
  const map = readRaw(KEYS.papers, {}) || {};
  delete map[key];
  writeRaw(KEYS.papers, map);
}

/* --------------------------------------------------------------- attempts */

export function listAttempts() {
  return readRaw(KEYS.attempts, []) || [];
}

export function getAttempt(id) {
  return listAttempts().find((attempt) => attempt.id === id) || null;
}

/** Store an attempt, trimming the oldest ones when the quota is reached. */
export function saveAttempt(attempt) {
  let attempts = listAttempts().filter((entry) => entry.id !== attempt.id);
  attempts.unshift(attempt);
  attempts = attempts.slice(0, MAX_ATTEMPTS);

  for (let index = 0; index < 8; index += 1) {
    try {
      writeRaw(KEYS.attempts, attempts);
      return attempt;
    } catch (error) {
      if (!error.quota || attempts.length <= 1) throw error;
      attempts = attempts.slice(0, Math.max(1, attempts.length - 2));
    }
  }
  throw new StorageFullError("This browser's local storage is full. Remove an older analysis or a downloaded paper, then try again.");
}

export function removeAttempt(id) {
  writeRaw(
    KEYS.attempts,
    listAttempts().filter((attempt) => attempt.id !== id),
  );
}

/* ---------------------------------------------------------------- session */

export function getSession() {
  return readRaw(KEYS.session, null);
}

export function saveSession(session) {
  try {
    writeRaw(KEYS.session, session);
  } catch {
    // A session that cannot be autosaved still runs in memory.
  }
}

export function clearSession() {
  try {
    window.localStorage.removeItem(KEYS.session);
  } catch {
    /* no-op */
  }
}

/* ------------------------------------------------------------------ prefs */

const DEFAULT_PREFS = {
  exam: "JEE_Main",
  lastRoute: "#/",
  paletteOpen: false,
};

export function getPrefs() {
  return { ...DEFAULT_PREFS, ...(readRaw(KEYS.prefs, {}) || {}) };
}

export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  try {
    writeRaw(KEYS.prefs, next);
  } catch {
    /* preferences are best effort */
  }
  return next;
}

/* --------------------------------------------------------- seen questions */

export function markSeen(uids) {
  if (!uids?.length) return;
  const seen = readRaw(KEYS.seen, {}) || {};
  const now = Date.now();
  for (const uid of uids) seen[uid] = now;
  const entries = Object.entries(seen);
  if (entries.length > 4000) {
    entries.sort((left, right) => right[1] - left[1]);
    writeRaw(KEYS.seen, Object.fromEntries(entries.slice(0, 4000)));
  } else {
    writeRaw(KEYS.seen, seen);
  }
}

export function seenMap() {
  return readRaw(KEYS.seen, {}) || {};
}

/** Rough byte estimate for the workspace: localStorage keeps UTF-16 text. */
export function storageEstimate() {
  const papers = readRaw(KEYS.papers, {}) || {};
  let paperChars = 0;
  for (const entry of Object.values(papers)) {
    try {
      paperChars += JSON.stringify(entry).length;
    } catch {
      /* skip unreadable entry */
    }
  }
  let attemptChars = 0;
  try {
    attemptChars = JSON.stringify(readRaw(KEYS.attempts, []) || []).length;
  } catch {
    attemptChars = 0;
  }
  return {
    papers: paperChars * 2,
    attempts: attemptChars * 2,
    total: (paperChars + attemptChars) * 2,
  };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
