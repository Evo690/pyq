import {
  DIFFICULTY_LABEL,
  SUBJECT_LABEL,
  TYPE_LABEL,
  TYPE_SHORT,
  analyzeAttempt,
  formatClock,
  formatDate,
  formatDuration,
} from "../core.js";
import { confirmDialog, escapeHtml, hydrateQuestion, percent, scoreLabel, toast } from "../dom.js";
import { downloadPaper, getPaperCatalog } from "../data.js";
import { getAttempt, hasOfflinePaper, removeAttempt } from "../store.js";
import { beginPaper, emptyState, examLabel } from "./shared.js";

const FILTERS = [
  ["all", "All"],
  ["incorrect", "Wrong"],
  ["skipped", "Skipped"],
  ["correct", "Correct"],
];

function statusClass(status) {
  return status === "correct" ? "correct" : status === "partial" ? "partial" : status === "incorrect" ? "incorrect" : "skipped";
}

function barTone(accuracy, attempted) {
  if (!attempted) return "";
  if (accuracy >= 0.7) return "good";
  if (accuracy >= 0.45) return "warn";
  return "bad";
}

function optionRows(question, given) {
  const givenSet = new Set(Array.isArray(given) ? given : given ? [given] : []);
  const expected = new Set(String(question.answer).split(/[\s,|]+/).filter(Boolean));
  return question.options
    .map((option, index) => {
      const chosen = givenSet.has(option.id);
      const correct = expected.has(option.id);
      const classes = ["option"];
      if (correct) classes.push("is-correct");
      if (chosen) classes.push("is-selected");
      if (chosen && !correct) classes.push("is-wrong");
      return `<div class="${classes.join(" ")}" data-option="${escapeHtml(option.id)}" style="cursor:default">
        <span class="key">${"ABCDEFGH"[index] || index + 1}</span>
        <span class="body">${escapeHtml(option.text)}</span>
      </div>`;
    })
    .join("");
}

function answerText(question, value) {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) {
    return "<span class='faint'>Not answered</span>";
  }
  if (question.type === "numerical") return escapeHtml(String(value));
  const ids = Array.isArray(value) ? value : [value];
  return ids
    .map((id) => {
      const index = question.options.findIndex((option) => option.id === id);
      return index === -1 ? escapeHtml(id) : `${"ABCDEFGH"[index]}`;
    })
    .join(", ");
}

function correctText(question) {
  if (question.type === "numerical") return escapeHtml(question.answer || "—");
  const index = question.options.findIndex((option) => option.id === question.answer);
  return index === -1 ? escapeHtml(question.answer || "—") : "ABCDEFGH"[index];
}

/** Rebuilt when a review row is opened, so 75 questions do not typeset up front. */
function reviewBodyHtml(question, answer) {
  const answerRow = `<div class="review-answer-row">
      <span><span class="k">Your answer</span><span class="v">${answerText(question, answer)}</span></span>
      <span><span class="k">Correct answer</span><span class="v">${correctText(question)}</span></span>
    </div>`;

  return `
    <div class="q-stem">${escapeHtml(question.text)}</div>
    ${
      question.type === "numerical"
        ? answerRow
        : `<div class="options">${optionRows(question, answer)}</div>${answerRow}`
    }
    <div class="solution">
      <div class="solution-head">Worked solution</div>
      <div data-solution-text>${escapeHtml(question.solution || "No solution is bundled for this question.")}</div>
    </div>`;
}

export async function render(ctx) {
  const attempt = getAttempt(ctx.params.id);
  if (!attempt) {
    return `<div class="page narrow">${emptyState({
      title: "That analysis is not in this browser",
      body: "Attempts live in local storage. If this browser's data was cleared, the analysis cannot be rebuilt — take the paper again to get a fresh one.",
      action: `<a class="btn primary" href="#/papers">Choose a paper</a>`,
    })}</div>`;
  }

  const data = analyzeAttempt(attempt);
  const { totals, bySubject, byType, byDifficulty, byChapter, slowest, rows } = data;
  const accuracy = totals.attempted ? (totals.correct + totals.partial * 0.5) / totals.attempted : 0;
  const scoreShare = totals.max ? Math.max(0, totals.score) / totals.max : 0;
  const timeShare = attempt.allowedSeconds ? Math.min(1, data.totalTime / attempt.allowedSeconds) : 0;

  let paper = null;
  try {
    const catalog = await getPaperCatalog(attempt.exam);
    paper = catalog.find((entry) => entry.key === attempt.paperKey) || null;
  } catch {
    paper = null;
  }

  const marksLost = rows.filter((row) => row.marks < 0).reduce((sum, row) => sum + Math.abs(row.marks), 0);
  const marksWon = rows.filter((row) => row.marks > 0).reduce((sum, row) => sum + row.marks, 0);

  const answeredRows = rows.filter((row) => row.status !== "skipped");
  const slowestAvg = data.avgTime;

  return `
  <div class="page">
    <div class="analysis-head">
      <div>
        <div class="eyebrow">Analysis · ${attempt.mode === "paper" ? "Timed paper" : "Practice"} · ${examLabel(attempt.exam)}</div>
        <h1>${escapeHtml(attempt.title || "Practice session")}</h1>
        <div class="analysis-meta">
          <span>${formatDate(attempt.finishedAt)}</span>
          <span>${totals.total} questions</span>
          <span>${formatDuration(data.totalTime)} ${attempt.allowedSeconds ? `of ${formatDuration(attempt.allowedSeconds)}` : "spent"}</span>
          <span>${attempt.source === "offline" ? "Offline paper" : attempt.source === "network" ? "Loaded online" : "Practice set"}</span>
          ${attempt.autoSubmitted ? "<span>Auto-submitted at time</span>" : ""}
        </div>
      </div>
      <div class="actions">
        ${
          paper
            ? `<button class="btn primary" type="button" data-action="retake">Retake paper</button>`
            : `<a class="btn primary" href="#/practice">New practice set</a>`
        }
        ${
          paper && !hasOfflinePaper(paper.key)
            ? `<button class="btn" type="button" data-action="download-paper">Download for offline</button>`
            : ""
        }
        <button class="btn ghost" type="button" data-action="delete-attempt">Delete</button>
      </div>
    </div>

    <section class="score-band" aria-label="Score summary">
      <div class="score-hero">
        <div class="label">Score</div>
        <div class="score-big">${scoreLabel(totals.score)}<small> / ${scoreLabel(totals.max)}</small></div>
        <div class="sub">${marksWon} marks earned · ${marksLost ? `${scoreLabel(marksLost)} lost to wrong answers` : "no negative marking"}</div>
        <div class="bar ${scoreShare >= 0.6 ? "good" : scoreShare >= 0.35 ? "warn" : "bad"}">
          <span style="width:${Math.max(1.5, Math.min(100, scoreShare * 100))}%"></span>
        </div>
      </div>
      <div class="score-cells">
        <div class="score-cell">
          <div class="label">Accuracy</div>
          <div class="value">${totals.attempted ? percent(accuracy) : "—"}<span class="sub">${totals.correct}✓ ${totals.incorrect}✕ ${totals.skipped}–</span></div>
        </div>
        <div class="score-cell">
          <div class="label">Attempted</div>
          <div class="value">${totals.attempted}<span class="sub">of ${totals.total}</span></div>
        </div>
        <div class="score-cell">
          <div class="label">Skipped</div>
          <div class="value">${totals.skipped}<span class="sub">${percent(totals.total ? totals.skipped / totals.total : 0)} of paper</span></div>
        </div>
        <div class="score-cell">
          <div class="label">Time on questions</div>
          <div class="value">${formatDuration(totals.time)}<span class="sub">${attempt.allowedSeconds ? percent(timeShare) + " of clock" : "untimed"}</span></div>
        </div>
        <div class="score-cell">
          <div class="label">Average per answer</div>
          <div class="value">${formatClock(slowestAvg)}<span class="sub">${answeredRows.length} answered</span></div>
        </div>
        <div class="score-cell">
          <div class="label">Negative marking</div>
          <div class="value ${marksLost ? "bad" : ""}">${marksLost ? `−${scoreLabel(marksLost)}` : "0"}<span class="sub">marks</span></div>
        </div>
      </div>
    </section>

    <div class="panel">
      <h3>What this sitting says</h3>
      <div class="insight-list">
        ${data.insights.map((insight) => `<div class="insight"><span>${insight.text}</span></div>`).join("")}
      </div>
    </div>

    <section class="analysis-section">
      <div class="analysis-grid split">
        <div class="panel">
          <h3>By subject</h3>
          ${bySubject
            .map(
              (subject) => `
            <div class="kv-row">
              <span class="k"><span class="subject-dot" style="background:var(--${subject.key})"></span>${subject.label}</span>
              <span class="bar ${barTone(subject.accuracy, subject.attempted)}"><span style="width:${
                subject.attempted ? Math.max(2, subject.accuracy * 100) : 0
              }%"></span></span>
              <span class="v"><b>${subject.attempted ? percent(subject.accuracy) : "—"}</b> · ${scoreLabel(subject.score)}</span>
            </div>
            <div class="paper-meta" style="padding:0 0 8px 13px;font-size:11px">
              <span>${subject.attempted}/${subject.total} attempted</span>
              <span>${subject.correct} correct</span>
              <span>${subject.incorrect} wrong</span>
              <span>${formatDuration(subject.time)}</span>
            </div>`,
            )
            .join("")}
          ${
            byType.length > 1
              ? `<div style="margin-top:18px;border-top:1px solid var(--line-soft);padding-top:14px">
                  <h3 style="margin-bottom:10px">By question type</h3>
                  ${byType
                    .map(
                      (type) => `
                    <div class="kv-row">
                      <span class="k">${TYPE_LABEL[type.key] || type.key}</span>
                      <span class="bar ${barTone(type.accuracy, type.attempted)}"><span style="width:${
                        type.attempted ? Math.max(2, type.accuracy * 100) : 0
                      }%"></span></span>
                      <span class="v"><b>${type.attempted ? percent(type.accuracy) : "—"}</b> · ${type.attempted}/${type.total}</span>
                    </div>`,
                    )
                    .join("")}
                </div>`
              : ""
          }
        </div>

        <div class="panel">
          <h3>By difficulty</h3>
          ${byDifficulty
            .map(
              (level) => `
            <div class="kv-row">
              <span class="k">${DIFFICULTY_LABEL[level.key] || level.label}</span>
              <span class="bar ${barTone(level.accuracy, level.attempted)}"><span style="width:${
                level.attempted ? Math.max(2, level.accuracy * 100) : 0
              }%"></span></span>
              <span class="v"><b>${level.attempted ? percent(level.accuracy) : "—"}</b> · ${level.attempted}/${level.total}</span>
            </div>`,
            )
            .join("")}

          <h3 style="margin-top:20px">Time distribution</h3>
          ${
            bySubject.some((subject) => subject.time > 0)
              ? bySubject
                  .map((subject) => {
                    const share = totals.time ? subject.time / totals.time : 0;
                    return `<div class="kv-row">
                      <span class="k"><span class="subject-dot" style="background:var(--${subject.key})"></span>${subject.label}</span>
                      <span class="bar"><span style="width:${Math.max(1, share * 100)}%;background:var(--${subject.key})"></span></span>
                      <span class="v">${formatDuration(subject.time)}</span>
                    </div>`;
                  })
                  .join("")
              : `<p class="faint" style="font-size:12.5px">Per-question timing was not recorded for this sitting.</p>`
          }
          ${
            attempt.allowedSeconds
              ? `<div class="kv-row" style="margin-top:8px">
                  <span class="k">Clock used</span>
                  <span class="bar ${timeShare > 0.97 ? "warn" : ""}"><span style="width:${Math.max(1, timeShare * 100)}%"></span></span>
                  <span class="v">${formatDuration(data.totalTime)}</span>
                </div>`
              : ""
          }

          ${
            slowest.length
              ? `<h3 style="margin-top:20px">Slowest questions</h3>
                ${slowest
                  .map(
                    (row) => `<div class="kv-row">
                      <span class="k" style="font-family:var(--mono);font-size:11.5px">Q${row.index}</span>
                      <span style="font-size:12px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        ${escapeHtml(row.question.chapter || "")} · ${TYPE_SHORT[row.question.type] || ""}
                      </span>
                      <span class="v" style="color:${row.status === "correct" ? "var(--good)" : row.status === "skipped" ? "var(--text-faint)" : "var(--bad)"}">
                        ${formatClock(row.time)}
                      </span>
                    </div>`,
                  )
                  .join("")}`
              : ""
          }
        </div>
      </div>
    </section>

    <section class="analysis-section">
      <div class="panel">
        <div class="section-head" style="margin-bottom:12px">
          <h3 style="margin:0">Chapter breakdown</h3>
          <span class="hint">Weakest first · tap a chapter to drill it</span>
        </div>
        <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Chapter</th>
              <th class="num">Attempted</th>
              <th class="num">Correct</th>
              <th>Accuracy</th>
              <th class="num">Marks</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${byChapter
              .map(
                (chapter) => `
              <tr>
                <td>
                  <div class="chapter-name">${escapeHtml(chapter.chapter)}</div>
                  <div class="subject-tag">${SUBJECT_LABEL[chapter.subject] || chapter.subject}</div>
                </td>
                <td class="num">${chapter.attempted}/${chapter.total}</td>
                <td class="num">${chapter.correct}</td>
                <td style="min-width:120px">
                  <div class="bar ${barTone(chapter.accuracy, chapter.attempted)}"><span style="width:${
                    chapter.attempted ? Math.max(2, chapter.accuracy * 100) : 0
                  }%"></span></div>
                  <span class="faint" style="font-size:10.5px">${chapter.attempted ? percent(chapter.accuracy) : "not attempted"}</span>
                </td>
                <td class="num" style="color:${chapter.score > 0 ? "var(--good)" : chapter.score < 0 ? "var(--bad)" : "var(--text-faint)"}">
                  ${scoreLabel(chapter.score)}
                </td>
                <td>
                  <a class="btn tiny ghost" href="#/practice?exam=${attempt.exam}&chapter=${encodeURIComponent(
                    `${chapter.subject}:${chapter.chapter}`,
                  )}">Practise</a>
                </td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
        </div>
      </div>
    </section>

    <section class="analysis-section">
      <div class="panel">
        <div class="section-head" style="margin-bottom:14px">
          <h3 style="margin:0">Answer sheet</h3>
          <div class="palette-legend" style="margin:0">
            <span><i style="background:rgba(131,166,141,.5)"></i>Correct</span>
            <span><i style="background:rgba(185,134,134,.5)"></i>Wrong</span>
            <span><i style="background:rgba(189,168,124,.5)"></i>Partial</span>
            <span><i style="background:#252a30;border:1px solid var(--line)"></i>Skipped</span>
          </div>
        </div>
        <div class="answer-sheet">
          ${rows
            .map(
              (row) => `
            <button type="button" class="sheet-cell ${row.status === "correct" ? "is-correct" : row.status === "incorrect" ? "is-wrong" : row.status === "partial" ? "is-partial" : ""}"
              data-goto="${row.index}" title="Q${row.index} · ${row.status}${row.time ? ` · ${formatClock(row.time)}` : ""}">
              ${row.index}
            </button>`,
            )
            .join("")}
        </div>
      </div>
    </section>

    <section class="analysis-section" id="review">
      <div class="section-head" style="margin-bottom:12px">
        <h2>Question review</h2>
        <span class="hint">Answers, worked solutions and time per question</span>
      </div>
      <div class="review-filters" data-review-filters>
        ${FILTERS.map(
          ([key, label], index) =>
            `<button class="btn tiny ${index === 0 ? "primary" : ""}" type="button" data-filter="${key}">${label} <span class="faint">${
              key === "all" ? rows.length : rows.filter((row) => row.status === key).length
            }</span></button>`,
        ).join("")}
      </div>
      <div data-review-list>
        ${rows
          .map(
            (row) => `
          <details class="review-item" data-status="${row.status}" data-index="${row.index}" id="q${row.index}">
            <summary>
              <span class="st ${statusClass(row.status)}"></span>
              <span class="rn">${row.index}</span>
              <span class="rt">${escapeHtml(row.question.chapter || "")} · ${TYPE_SHORT[row.question.type] || ""} · ${
                DIFFICULTY_LABEL[row.question.difficulty] || ""
              }</span>
              <span class="rmeta">${row.marks > 0 ? "+" : ""}${scoreLabel(row.marks)} · ${row.time ? formatClock(row.time) : "0:00"}</span>
            </summary>
            <div class="review-body">
              <div class="chip-row" style="margin-bottom:12px">
                <span class="chip subject-${row.question.subject}">${SUBJECT_LABEL[row.question.subject] || row.question.subject}</span>
                <span class="chip plain">${TYPE_LABEL[row.question.type] || row.question.type}</span>
                <span class="chip plain">${escapeHtml(row.question.paper || "")}</span>
              </div>
              <div class="review-body-inner" data-review-body></div>
            </div>
          </details>`,
          )
          .join("")}
      </div>
    </section>
  </div>`;
}

export function mount(root, ctx) {
  const attempt = getAttempt(ctx.params.id);
  const reviewList = root.querySelector("[data-review-list]");
  const hydrateRow = (details) => {
    if (!details.open) return;
    const body = details.querySelector("[data-review-body]");
    if (!body || body.dataset.hydrated === "1") return;
    const question = attempt?.questions?.[Number(details.dataset.index) - 1];
    if (!question) return;
    body.innerHTML = reviewBodyHtml(question, attempt.answers?.[question.uid]);
    body.dataset.hydrated = "1";
    hydrateQuestion(body, question);
  };

  if (reviewList) {
    reviewList.addEventListener(
      "toggle",
      (event) => {
        if (event.target?.tagName === "DETAILS") hydrateRow(event.target);
      },
      true,
    );
  }

  root.addEventListener("click", async (event) => {
    const filter = event.target.closest("[data-filter]");
    if (filter) {
      const key = filter.dataset.filter;
      for (const button of root.querySelectorAll("[data-filter]")) {
        button.classList.toggle("primary", button === filter);
      }
      for (const item of root.querySelectorAll("[data-review-list] .review-item")) {
        item.style.display = key === "all" || item.dataset.status === key ? "" : "none";
      }
      return;
    }

    const goto = event.target.closest("[data-goto]");
    if (goto) {
      const index = goto.dataset.goto;
      const item = root.querySelector(`[data-index="${index}"]`);
      if (item) {
        for (const other of root.querySelectorAll("[data-review-list] .review-item")) {
          other.style.display = "";
        }
        root.querySelector('[data-filter="all"]')?.classList.add("primary");
        for (const button of root.querySelectorAll("[data-filter]")) {
          button.classList.toggle("primary", button.dataset.filter === "all");
        }
        item.open = true;
        hydrateRow(item);
        item.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;

    if (!attempt) return;

    if (action === "retake") {
      const ok = await confirmDialog({
        title: "Retake this paper?",
        body: "The current analysis stays in your library. This opens a new three-hour sitting of the same paper.",
        confirm: "Start sitting",
      });
      if (!ok) return;
      try {
        const catalog = await getPaperCatalog(attempt.exam);
        const paper = catalog.find((entry) => entry.key === attempt.paperKey);
        if (!paper) throw new Error("This paper is no longer in the catalog.");
        await beginPaper(ctx, paper);
      } catch (error) {
        toast(error?.message || "The paper could not be prepared.", "bad");
      }
    }

    if (action === "download-paper") {
      try {
        const catalog = await getPaperCatalog(attempt.exam);
        const paper = catalog.find((entry) => entry.key === attempt.paperKey);
        if (!paper) throw new Error("This paper is no longer in the catalog.");
        toast("Downloading the paper…");
        await downloadPaper(attempt.exam, paper, { onStatus: () => {} });
        toast("Paper saved for offline use.", "good");
        ctx.rerender();
      } catch (error) {
        toast(error?.message || "The paper could not be downloaded.", "bad");
      }
    }

    if (action === "delete-attempt") {
      const ok = await confirmDialog({
        title: "Delete this analysis?",
        body: "The score, timings and question review for this sitting will be removed from this browser.",
        confirm: "Delete",
        danger: true,
      });
      if (!ok) return;
      removeAttempt(attempt.id);
      toast("Analysis deleted.");
      ctx.navigate("#/library");
    }
  });
}
