import { SUBJECT_LABEL, SUBJECT_ORDER, practiceProgress, progressAccuracy } from "../core.js";
import { escapeHtml, percent, toast } from "../dom.js";
import { getIndex } from "../data.js";
import { listAttempts } from "../store.js";
import { beginPractice, bindExamSwitch, emptyState, examLabel, examSwitch } from "./shared.js";

/** Which chapters are expanded to show their topics. */
const state = {
  exam: "",
  query: "",
  subject: "all",
  size: 20,
  open: new Set(),
  busy: "",
  error: "",
};

function matchesQuery(chapter, query) {
  if (!query) return true;
  const haystack = `${chapter.name} ${chapter.topics.map((topic) => topic.name).join(" ")}`.toLowerCase();
  return haystack.includes(query);
}

function progressChip(entry) {
  if (!entry?.attempted) return `<span class="chip plain faint">not attempted</span>`;
  const accuracy = progressAccuracy(entry);
  const tone = accuracy >= 0.7 ? "saved" : accuracy >= 0.4 ? "" : "offline";
  return `<span class="chip ${tone}" title="${entry.correct} correct, ${entry.incorrect} wrong">${percent(
    accuracy,
  )} · ${entry.attempted} tried</span>`;
}

export async function render(ctx) {
  if (state.exam !== ctx.exam) {
    state.exam = ctx.exam;
    state.open = new Set();
  }

  // Deep link from an analysis page: open the weak chapter straight away.
  const deepLink = ctx.params?.chapter;
  if (deepLink) {
    const [subject, ...rest] = deepLink.split(":");
    const chapterName = rest.join(":");
    if (subject && chapterName) {
      state.open.add(`${subject}::${chapterName}`);
      state.subject = "all";
      state.query = "";
    }
  }

  let index = null;
  try {
    index = await getIndex();
  } catch {
    index = null;
  }

  if (!index) {
    return `<div class="page">${emptyState({
      title: "The chapter index could not be read",
      body: "The bundled question bank is missing data/index.json. Exact papers still work if you downloaded them.",
      action: `<a class="btn" href="#/papers">Exact papers</a>`,
    })}</div>`;
  }

  const examData = index.exams?.[ctx.exam];
  const progress = practiceProgress(listAttempts());
  const query = state.query.trim().toLowerCase();

  const subjects = SUBJECT_ORDER.map((key) => ({
    key,
    data: examData?.subjects?.find((subject) => subject.key === key),
  })).filter((subject) => subject.data && (state.subject === "all" || state.subject === subject.key));

  const chapterCount = subjects.reduce((sum, subject) => sum + subject.data.chapters.length, 0);
  const topicCount = subjects.reduce(
    (sum, subject) => sum + subject.data.chapters.reduce((inner, chapter) => inner + chapter.topics.length, 0),
    0,
  );
  const questionCount = subjects.reduce(
    (sum, subject) => sum + subject.data.chapters.reduce((inner, chapter) => inner + chapter.count, 0),
    0,
  );

  const matched = subjects
    .map((subject) => ({
      ...subject,
      chapters: subject.data.chapters.filter((chapter) => matchesQuery(chapter, query)),
    }))
    .filter((subject) => subject.chapters.length);

  const attemptedChapters = [...progress.chapters.keys()].length;

  const chapterCard = (subjectKey, chapter) => {
    const id = `${subjectKey}::${chapter.name}`;
    const chapterProgress = progress.chapters.get(id);
    const open = state.open.has(id) && !query;

    const topics = chapter.topics
      .filter((topic) => !query || topic.name.toLowerCase().includes(query) || chapter.name.toLowerCase().includes(query))
      .map((topic) => {
        const topicProgress = progress.topics.get(`${id}::${topic.name}`);
        return `<div class="topic-row">
          <div class="topic-main">
            <span class="topic-name">${escapeHtml(topic.name)}</span>
            <span class="topic-count mono">${topic.count}</span>
          </div>
          <div class="topic-side">
            ${progressChip(topicProgress)}
            <button class="btn tiny" type="button" data-action="practise-topic"
              data-subject="${subjectKey}" data-chapter="${escapeHtml(chapter.name)}" data-topic="${escapeHtml(topic.name)}"
              ${state.busy ? "disabled" : ""}>Practise</button>
          </div>
        </div>`;
      })
      .join("");

    return `<article class="chapter-card ${open ? "is-open" : ""}" data-chapter-card="${escapeHtml(id)}">
      <header class="chapter-card-head">
        <div class="chapter-card-copy">
          <h3 class="chapter-card-name">${escapeHtml(chapter.name)}</h3>
          <div class="chapter-card-meta">
            <span><b>${chapter.count}</b> PYQs</span>
            <span>${chapter.topics.length} topic${chapter.topics.length === 1 ? "" : "s"}</span>
            ${progressChip(chapterProgress)}
          </div>
        </div>
        <div class="chapter-card-actions">
          <button class="btn tiny primary" type="button" data-action="practise-chapter"
            data-subject="${subjectKey}" data-chapter="${escapeHtml(chapter.name)}"
            ${state.busy ? "disabled" : ""}>Practise</button>
          <button class="btn tiny ghost" type="button" data-action="toggle-topics" data-key="${escapeHtml(id)}"
            aria-expanded="${open}">${open ? "Hide topics" : "Topics"}</button>
        </div>
      </header>
      ${open ? `<div class="topic-list">${topics || `<p class="faint" style="font-size:12px">No topics match that search.</p>`}</div>` : ""}
    </article>`;
  };

  return `
  <div class="page">
    <div class="section-head" style="align-items:flex-start;margin-bottom:10px">
      <div>
        <div class="eyebrow">Question bank</div>
        <h1 class="display" style="font-size:clamp(26px,3.6vw,36px);margin-top:12px">Every PYQ, chapter by chapter.</h1>
        <p class="lede" style="margin-top:12px;font-size:14.5px">
          Browse the ${examLabel(ctx.exam)} bank ${chapterCount} chapters deep, open any chapter to see its topics,
          and start a set from exactly the slice you want. Your accuracy on each chapter and topic shows up as you practise.
        </p>
      </div>
      ${examSwitch(ctx)}
    </div>

    <div class="stat-row" style="margin-top:20px">
      <div class="stat">
        <div class="stat-label">questions</div>
        <div class="stat-value">${questionCount.toLocaleString()}</div>
        <div class="stat-foot">${chapterCount} chapters in view</div>
      </div>
      <div class="stat">
        <div class="stat-label">topics</div>
        <div class="stat-value">${topicCount.toLocaleString()}</div>
        <div class="stat-foot">tap a chapter to see them</div>
      </div>
      <div class="stat">
        <div class="stat-label">chapters touched</div>
        <div class="stat-value">${attemptedChapters}</div>
        <div class="stat-foot">from your saved sittings</div>
      </div>
      <div class="stat">
        <div class="stat-label">set size</div>
        <div class="stat-value">${state.size}<small> qs</small></div>
        <div class="stat-foot">per practise run</div>
      </div>
    </div>

    <div class="toolbar" style="margin-top:18px">
      <div class="field grow">
        <label for="bank-search">Search chapters and topics</label>
        <input id="bank-search" type="search" data-role="search" value="${escapeHtml(state.query)}"
          placeholder="e.g. rotational, amines, definite integral…" autocomplete="off" />
      </div>
      <div class="field">
        <label for="bank-subject">Subject</label>
        <select id="bank-subject" data-role="subject">
          <option value="all" ${state.subject === "all" ? "selected" : ""}>All subjects</option>
          ${SUBJECT_ORDER.map(
            (key) => `<option value="${key}" ${state.subject === key ? "selected" : ""}>${SUBJECT_LABEL[key]}</option>`,
          ).join("")}
        </select>
      </div>
      <div class="field">
        <label for="bank-size">Questions per set</label>
        <select id="bank-size" data-role="size">
          ${[10, 15, 20, 30, 45]
            .map((value) => `<option value="${value}" ${state.size === value ? "selected" : ""}>${value}</option>`)
            .join("")}
        </select>
      </div>
      <a class="btn small ghost" href="#/practice">Build a mixed set →</a>
    </div>

    ${state.error ? `<div class="notice bad" role="alert" style="margin-bottom:14px">${escapeHtml(state.error)}</div>` : ""}
    ${state.busy ? `<div class="notice" style="margin-bottom:14px"><span class="spin" style="border-color:var(--accent);border-right-color:transparent"></span> Preparing ${escapeHtml(state.busy)}…</div>` : ""}

    ${
      matched.length
        ? matched
            .map(
              (subject) => `
      <section class="bank-subject">
        <div class="bank-subject-head">
          <span class="subject-dot" style="background:var(--${subject.key})"></span>
          <h2>${SUBJECT_LABEL[subject.key]}</h2>
          <span class="chip plain">${subject.chapters.length} chapter${subject.chapters.length === 1 ? "" : "s"}</span>
          <span class="spacer"></span>
          <span class="hint">${subject.chapters.reduce((sum, chapter) => sum + chapter.count, 0).toLocaleString()} PYQs</span>
        </div>
        <div class="chapter-grid">
          ${subject.chapters.map((chapter) => chapterCard(subject.key, chapter)).join("")}
        </div>
      </section>`,
            )
            .join("")
        : emptyState({
            title: "Nothing matches that search",
            body: "Try a chapter name (“Thermodynamics”), a topic (“Nernst equation”), or a subject.",
            action: `<button class="btn" type="button" data-action="clear-search">Clear search</button>`,
          })
    }
  </div>`;
}

export function mount(root, ctx) {
  bindExamSwitch(root, ctx);

  const findChapter = async (subjectKey, chapterName) => {
    const index = await getIndex();
    const chapter = index?.exams?.[ctx.exam]?.subjects
      ?.find((subject) => subject.key === subjectKey)
      ?.chapters?.find((entry) => entry.name === chapterName);
    return chapter || null;
  };

  const start = async ({ subjectKey, chapterName, topic }) => {
    const chapter = await findChapter(subjectKey, chapterName);
    if (!chapter) {
      toast("That chapter is no longer in the bank.", "bad");
      return;
    }
    const label = topic ? `${chapter.name} · ${topic}` : chapter.name;
    state.busy = label;
    state.error = "";
    ctx.rerender();
    try {
      const topics = topic ? new Map([[`${subjectKey}::${chapter.name}`, new Set([topic])]]) : null;
      await beginPractice(ctx, {
        exam: ctx.exam,
        chapters: [{ subject: subjectKey, name: chapter.name, file: chapter.file }],
        count: state.size,
        topics,
        title: `${examLabel(ctx.exam)} · ${label}`,
      });
      state.busy = "";
    } catch (error) {
      state.busy = "";
      state.error = error?.message || "That set could not be prepared.";
      toast(state.error, "bad");
      ctx.rerender();
    }
  };

  root.addEventListener("change", (event) => {
    if (event.target.matches('[data-role="subject"]')) {
      state.subject = event.target.value;
      ctx.rerender();
    }
    if (event.target.matches('[data-role="size"]')) {
      state.size = Number(event.target.value) || 20;
      ctx.rerender();
    }
  });

  let searchTimer;
  root.addEventListener("input", (event) => {
    if (!event.target.matches('[data-role="search"]')) return;
    const value = event.target.value;
    state.query = value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const caret = value.length;
      ctx.rerender();
      const next = document.querySelector('[data-role="search"]');
      if (next) {
        next.focus();
        next.setSelectionRange(caret, caret);
      }
    }, 240);
  });

  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;

    if (action === "toggle-topics") {
      const key = button.dataset.key;
      if (state.open.has(key)) state.open.delete(key);
      else state.open.add(key);
      ctx.rerender();
      return;
    }

    if (action === "clear-search") {
      state.query = "";
      state.subject = "all";
      ctx.rerender();
      return;
    }

    if (action === "practise-chapter") {
      event.preventDefault();
      void start({
        subjectKey: button.dataset.subject,
        chapterName: button.dataset.chapter,
      });
      return;
    }

    if (action === "practise-topic") {
      event.preventDefault();
      void start({
        subjectKey: button.dataset.subject,
        chapterName: button.dataset.chapter,
        topic: button.dataset.topic,
      });
    }
  });
}
