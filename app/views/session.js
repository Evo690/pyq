import {
  DIFFICULTY_LABEL,
  SUBJECT_LABEL,
  TYPE_LABEL,
  TYPE_SHORT,
  formatClock,
  isAnswered,
  paperSections,
  scoreQuestion,
} from "../core.js";
import { confirmDialog, escapeHtml, hydrateQuestion, toast } from "../dom.js";
import {
  answeredCount,
  clearAnswer,
  elapsedSeconds,
  getCurrent,
  goTo,
  remainingSeconds,
  restoreSession,
  setAnswer,
  submit,
  toggleFlag,
} from "../session.js";

const OPTION_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H"];
let timerHandle = null;

const isPractice = (session) => session.mode === "practice";

function settled(session, question) {
  return isPractice(session) && isAnswered(question, session.answers[question.uid]);
}

function expectedOptions(question) {
  return new Set(
    String(question.answer)
      .split(/[\s,|]+/)
      .filter(Boolean),
  );
}

function optionState(session, question, option) {
  const answer = session.answers[question.uid];
  const chosen = Array.isArray(answer) ? answer.includes(option.id) : answer === option.id;
  if (!settled(session, question)) return { chosen, correct: false, wrong: false };
  const isCorrect = expectedOptions(question).has(option.id);
  return { chosen, correct: isCorrect, wrong: chosen && !isCorrect };
}

function stripTags(value) {
  const text = String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

function optionLetter(question, optionId) {
  const index = question.options.findIndex((option) => option.id === optionId);
  if (index === -1) return optionId;
  return `${OPTION_KEYS[index] || index + 1}. ${stripTags(question.options[index].text)}`;
}

function questionBody(session) {
  const question = session.questions[session.index];
  const practice = isPractice(session);
  const answer = session.answers[question.uid];
  const result = practice && isAnswered(question, answer) ? scoreQuestion(question, answer) : null;

  const options = question.options
    .map((option, index) => {
      const state = optionState(session, question, option);
      const classes = ["option"];
      if (state.chosen) classes.push("is-selected");
      if (state.correct) classes.push("is-correct");
      if (state.wrong) classes.push("is-wrong");
      return `<button type="button" class="${classes.join(" ")}" data-option="${escapeHtml(option.id)}">
        <span class="key">${OPTION_KEYS[index] || index + 1}</span>
        <span class="body">${escapeHtml(option.text)}</span>
      </button>`;
    })
    .join("");

  const numeric = `<div class="numeric-entry">
    <input type="text" inputmode="decimal" autocomplete="off" data-numeric
      value="${escapeHtml(typeof answer === "string" ? answer : "")}" placeholder="Your answer"
      aria-label="Numerical answer" ${result ? "readonly" : ""} />
    ${
      practice && !result
        ? `<button class="btn tiny" type="button" data-action="check">Check answer</button>`
        : `<span class="numeric-hint">Enter the numerical value, e.g. 12 or -0.5</span>`
    }
  </div>`;

  const banner = result
    ? result.status === "correct"
      ? `<div class="answer-banner good">Correct · +${result.marks} marks</div>`
      : result.status === "partial"
        ? `<div class="answer-banner skip">Partly correct · +${result.marks} marks</div>`
        : `<div class="answer-banner bad">Not quite · ${result.marks} marks. The answer is ${escapeHtml(
            question.type === "numerical" ? question.answer : optionLetter(question, question.answer),
          )}</div>`
    : "";

  const solution =
    practice && result
      ? `<div class="solution">
          <div class="solution-head">Worked solution</div>
          <div data-solution-text>${escapeHtml(question.solution || "No solution is bundled for this question.")}</div>
        </div>`
      : "";

  return `
    <div class="q-head">
      <span class="q-index">Question <b>${session.index + 1}</b> of ${session.questions.length}</span>
      <span class="chip subject-${question.subject}">${SUBJECT_LABEL[question.subject] || question.subject}</span>
      <span class="chip plain">${TYPE_LABEL[question.type]}</span>
      <span class="chip plain">${DIFFICULTY_LABEL[question.difficulty] || "Medium"}</span>
      <span class="chip plain" title="Chapter">${escapeHtml(question.chapter || "Unclassified")}</span>
    </div>
    <div class="q-stem">${escapeHtml(question.text)}</div>
    ${question.type === "numerical" ? numeric : `<div class="options">${options}</div>`}
    ${banner}
    <div class="q-tools">
      <button class="btn tiny ghost" type="button" data-action="clear">Clear response</button>
      ${
        question.type === "multipleCorrect"
          ? `<span class="faint" style="font-size:11.5px">Select every correct option</span>`
          : ""
      }
      <span class="spacer"></span>
      <button class="btn tiny ghost" type="button" data-action="flag">
        ${session.flags.includes(question.uid) ? "Unmark review" : "Mark for review"}
      </button>
    </div>
    ${solution}`;
}

function paletteHtml(session) {
  const sections = paperSections(session.questions);
  const practice = isPractice(session);
  let cursor = 0;

  const legend = `<div class="palette-legend">
    <span><i style="background:rgba(131,166,141,.5)"></i>${practice ? "Correct" : "Answered"}</span>
    ${practice ? `<span><i style="background:rgba(185,134,134,.5)"></i>Wrong</span>` : ""}
    <span><i style="background:#252a30;border:1px solid var(--line)"></i>Open</span>
    <span><i style="background:rgba(189,168,124,.45)"></i>Marked</span>
  </div>`;

  const groups = sections
    .map((section) => {
      const cells = section.questions
        .map((question) => {
          const index = cursor;
          cursor += 1;
          const answered = isAnswered(question, session.answers[question.uid]);
          const flagged = session.flags.includes(question.uid);
          const classes = ["palette-cell"];
          if (practice && answered) {
            const result = scoreQuestion(question, session.answers[question.uid]);
            classes.push(
              result.status === "correct"
                ? "is-correct"
                : result.status === "partial"
                  ? "is-flagged"
                  : "is-wrong",
            );
          } else if (answered) {
            classes.push("is-answered");
          }
          if (flagged) classes.push("is-flagged");
          if (index === session.index) classes.push("is-current");
          return `<button type="button" class="${classes.join(" ")}" data-jump="${index}"
            title="Question ${index + 1}">${index + 1}</button>`;
        })
        .join("");
      return `<div class="palette-section">
        <div class="palette-section-head">
          <span>${SUBJECT_LABEL[section.subject] || section.subject} · ${TYPE_SHORT[section.type] || section.type}</span>
          <span>${section.questions.length}</span>
        </div>
        <div class="palette-grid">${cells}</div>
      </div>`;
    })
    .join("");

  return `${legend}${groups}`;
}

function shellHtml(session, ctx) {
  const practice = isPractice(session);
  const question = session.questions[session.index];

  return `
  <div class="exam-shell">
    <div class="exam-bar">
      <button class="btn tiny ghost" type="button" data-action="exit">Exit</button>
      <div style="min-width:0">
        <div class="exam-title">${escapeHtml(session.title || "Practice session")}</div>
        <div class="exam-sub">${practice ? "Practice · untimed" : "Timed paper"} · ${
          SUBJECT_LABEL[question.subject] || question.subject
        } · ${TYPE_LABEL[question.type]}</div>
      </div>
      ${ctx.online ? "" : `<span class="chip offline" title="All questions and solutions are stored locally">Offline</span>`}
      <div class="exam-timer" data-timer aria-live="off"></div>
    </div>

    <div class="exam-body">
      <section class="question-card" data-question></section>
      <aside class="palette" data-palette></aside>
    </div>

    <div class="session-dock">
      <button class="btn small" type="button" data-action="prev">← Prev</button>
      <span class="progress-text" data-progress></span>
      <button class="btn small" type="button" data-action="palette">Questions</button>
      <span class="spacer"></span>
      <button class="btn small" type="button" data-action="next">Next →</button>
      <button class="btn small accent" type="button" data-action="submit">${
        practice ? "Finish practice" : "Submit paper"
      }</button>
    </div>
  </div>`;
}

function emptyStateHtml() {
  return `<div class="page narrow">
    <div class="empty">
      <strong>No sitting in progress</strong>
      Start an exact paper or a chapter practice set, and it will open here.
      <div class="actions" style="justify-content:center;margin-top:18px">
        <a class="btn primary" href="#/papers">Exact papers</a>
        <a class="btn" href="#/practice">Practice</a>
      </div>
    </div>
  </div>`;
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

export async function render(ctx, mount) {
  const session = getCurrent() || restoreSession();
  if (!session?.questions?.length) return emptyStateHtml();

  mount.innerHTML = shellHtml(session, ctx);
  const questionCard = mount.querySelector("[data-question]");
  const palette = mount.querySelector("[data-palette]");
  const timer = mount.querySelector("[data-timer]");
  const progress = mount.querySelector("[data-progress]");
  let submitted = false;

  const paintProgress = () => {
    const answered = answeredCount();
    progress.textContent = `${answered}/${session.questions.length} answered${
      session.flags.length ? ` · ${session.flags.length} marked` : ""
    }`;
  };

  const paintQuestion = () => {
    questionCard.innerHTML = questionBody(session);
    hydrateQuestion(questionCard, session.questions[session.index]);
  };

  const paintPalette = () => {
    palette.innerHTML = paletteHtml(session);
    palette.classList.remove("is-open");
    paintProgress();
  };

  const paint = () => {
    paintQuestion();
    paintPalette();
  };

  const finish = async ({ auto = false } = {}) => {
    if (submitted) return;
    submitted = true;
    const attempt = submit({ auto });
    stopTimer();
    if (!attempt) {
      ctx.navigate("#/");
      return;
    }
    ctx.navigate(`#/attempt/${encodeURIComponent(attempt.id)}`);
  };

  const autoSubmit = () => {
    if (submitted) return;
    toast("Time is up — the paper was submitted automatically.", "warn");
    void finish({ auto: true });
  };

  const updateTimer = () => {
    if (!timer) return;
    const remaining = remainingSeconds();
    if (remaining === null) {
      timer.textContent = formatClock(elapsedSeconds());
      timer.title = "Time on this set";
      timer.classList.remove("is-low");
      return;
    }
    timer.textContent = formatClock(remaining);
    timer.title = "Time remaining";
    timer.classList.toggle("is-low", remaining <= 300);
    if (remaining <= 0) autoSubmit();
  };

  const go = (index) => {
    goTo(index);
    paint();
    updateTimer();
  };

  const choose = (optionId) => {
    const question = session.questions[session.index];
    if (settled(session, question)) return;
    if (question.type === "multipleCorrect") {
      const current = Array.isArray(session.answers[question.uid])
        ? session.answers[question.uid]
        : [];
      setAnswer(
        current.includes(optionId)
          ? current.filter((value) => value !== optionId)
          : [...current, optionId],
      );
    } else {
      setAnswer(optionId);
    }
    paint();
  };

  const onSubmitClick = async () => {
    const answered = answeredCount();
    const total = session.questions.length;
    const blank = total - answered;
    const ok = await confirmDialog({
      title: isPractice(session) ? "Finish this practice set?" : "Submit the paper?",
      body: isPractice(session)
        ? `${answered} answered, ${blank} left open. The full analysis opens next.`
        : `${answered} of ${total} answered. ${blank} unanswered question${
            blank === 1 ? "" : "s"
          } will score zero, and the paper cannot be resumed after submitting.`,
      confirm: isPractice(session) ? "Finish and analyse" : "Submit paper",
    });
    if (ok) await finish();
  };

  questionCard.addEventListener("click", (event) => {
    const option = event.target.closest("[data-option]");
    if (option) {
      choose(option.dataset.option);
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "clear") {
      clearAnswer();
      paint();
    }
    if (action === "check") {
      paint();
    }
    if (action === "flag") {
      toggleFlag();
      paint();
    }
  });

  questionCard.addEventListener("input", (event) => {
    const input = event.target.closest("[data-numeric]");
    if (!input) return;
    setAnswer(input.value);
    paintProgress();
    palette.querySelector(`[data-jump="${session.index}"]`)?.classList.toggle("is-answered", input.value.trim() !== "");
  });

  questionCard.addEventListener("keydown", (event) => {
    if (!event.target.closest("[data-numeric]")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      paint();
      if (session.index < session.questions.length - 1) go(session.index + 1);
    }
  });

  mount.addEventListener("click", (event) => {
    const cell = event.target.closest("[data-jump]");
    if (cell) {
      go(Number(cell.dataset.jump));
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "prev") go(Math.max(0, session.index - 1));
    if (action === "next") go(Math.min(session.questions.length - 1, session.index + 1));
    if (action === "palette") {
      palette.classList.toggle("is-open");
      if (palette.classList.contains("is-open") && !palette.querySelector("[data-close-palette]")) {
        const close = document.createElement("button");
        close.className = "btn tiny ghost";
        close.dataset.closePalette = "1";
        close.textContent = "Close";
        close.style.display = "none";
        close.classList.add("palette-close");
        close.addEventListener("click", () => palette.classList.remove("is-open"));
        palette.prepend(close);
      }
    }
    if (action === "submit") void onSubmitClick();
    if (action === "exit") {
      void (async () => {
        const ok = await confirmDialog({
          title: "Leave this sitting?",
          body: "Your answers and the time already spent are saved in this browser. Resume from the overview whenever you are ready.",
          confirm: "Save and exit",
          cancel: "Keep sitting",
        });
        if (ok) {
          stopTimer();
          ctx.navigate("#/");
        }
      })();
    }
  });

  const onKey = (event) => {
    const inField = event.target.matches?.("input, textarea, select");
    if (inField && !/^[0-9]$/.test(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const index = Number(event.key);
    if (index >= 1 && index <= 9) {
      const question = session.questions[session.index];
      if (question.type !== "numerical" && !settled(session, question)) {
        const option = question.options[index - 1];
        if (option) {
          choose(option.id);
          event.preventDefault();
        }
      }
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(Math.min(session.questions.length - 1, session.index + 1));
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(Math.max(0, session.index - 1));
    }
    if (event.key.toLowerCase() === "m") {
      toggleFlag();
      paint();
    }
    if (event.key.toLowerCase() === "c") {
      clearAnswer();
      paint();
    }
  };

  document.addEventListener("keydown", onKey);
  paint();
  updateTimer();
  timerHandle = setInterval(updateTimer, 1000);

  return () => {
    document.removeEventListener("keydown", onKey);
    stopTimer();
  };
}
