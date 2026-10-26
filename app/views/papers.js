import { SUBJECT_LABEL, analyzeAttempt, formatDate } from "../core.js";
import { escapeHtml, scoreLabel, toast } from "../dom.js";
import { downloadPaper, getPaperCatalog } from "../data.js";
import { getOfflinePaper, hasOfflinePaper, listAttempts } from "../store.js";
import { beginPaper, examLabel, examSwitch, bindExamSwitch } from "./shared.js";

const state = {
  exam: "",
  year: "",
  query: "",
  selected: "",
  busy: "",
  message: "",
  error: "",
  progress: null,
};

function papersInYear(catalog) {
  return state.year && state.year !== "all"
    ? catalog.filter((paper) => paper.year === state.year)
    : catalog;
}

function selectedPaper(catalog) {
  return (
    catalog.find((paper) => paper.title === state.selected) ||
    papersInYear(catalog)[0] ||
    catalog[0] ||
    null
  );
}

function yearOptions(catalog) {
  const years = [...new Set(catalog.map((paper) => paper.year))].sort(
    (left, right) => Number(right) - Number(left),
  );
  return years;
}

export async function render(ctx) {
  if (state.exam !== ctx.exam) {
    state.exam = ctx.exam;
    state.year = "";
    state.selected = "";
    state.query = "";
  }

  let catalog = [];
  let loadError = "";
  try {
    catalog = await getPaperCatalog(ctx.exam);
  } catch (error) {
    loadError = error?.message || "The paper index could not be read.";
  }

  const years = yearOptions(catalog);
  if (!state.year || (state.year !== "all" && !years.includes(state.year))) {
    state.year = years[0] || "";
  }

  const params = ctx.params || {};
  if (params.paper) state.selected = params.paper;
  else if (params.year && years.includes(params.year)) state.year = params.year;

  const selected = selectedPaper(catalog);
  if (selected && !state.selected) state.selected = selected.title;

  const query = state.query.trim().toLowerCase();
  const visible = query
    ? catalog.filter((paper) => paper.title.toLowerCase().includes(query))
    : papersInYear(catalog);

  const attempts = listAttempts();
  const related = selected
    ? attempts.filter((attempt) => attempt.paperKey === selected.key)
    : [];
  const latest = related.length
    ? analyzeAttempt(related.sort((left, right) => (right.finishedAt || 0) - (left.finishedAt || 0))[0])
    : null;

  const downloaded = selected ? hasOfflinePaper(selected.key) : false;
  const isBusy = Boolean(state.busy);
  const blocked = !ctx.online && !downloaded;

  return `
  <div class="page">
    <div class="section-head" style="align-items:flex-start;margin-bottom:10px">
      <div>
        <div class="eyebrow">Exact paper</div>
        <h1 class="display" style="font-size:clamp(26px,3.6vw,36px);margin-top:12px">One sitting, entire paper.</h1>
        <p class="lede" style="margin-top:12px;font-size:14.5px">
          Questions load in exam order — every MCQ of Physics, then its numericals, then Chemistry,
          then Mathematics — exactly the sequence the paper was sat in.
        </p>
      </div>
      ${examSwitch(ctx)}
    </div>

    ${loadError ? `<div class="notice bad" role="alert">${escapeHtml(loadError)}</div>` : ""}

    <div class="toolbar">
      <div class="field">
        <label for="paper-year">Year</label>
        <select id="paper-year" data-role="year" ${isBusy ? "disabled" : ""}>
          <option value="all" ${state.year === "all" ? "selected" : ""}>All years</option>
          ${years
            .map(
              (year) =>
                `<option value="${year}" ${year === state.year ? "selected" : ""}>${year}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div class="field grow">
        <label for="paper-search">Find a paper</label>
        <input id="paper-search" type="search" data-role="search" placeholder="Search any year or shift…"
          value="${escapeHtml(state.query)}" autocomplete="off" ${isBusy ? "disabled" : ""} />
      </div>
      <span class="chip plain">${visible.length} paper${visible.length === 1 ? "" : "s"}</span>
      <span class="chip ${ctx.online ? "plain" : "offline"}">${
        ctx.online ? "Question bank ready" : "Offline — saved papers only"
      }</span>
    </div>

    <div class="setup-grid">
      <div>
        <div class="paper-list" data-role="paper-list">
          ${
            visible.length
              ? visible
                  .map((paper) => {
                    const active = selected && paper.title === selected.title;
                    const saved = hasOfflinePaper(paper.key);
                    return `<div class="paper-row ${active ? "is-selected" : ""}" data-paper="${escapeHtml(paper.title)}" role="button" tabindex="0">
                      <div>
                        <div class="paper-name">${escapeHtml(paper.title)}</div>
                        <div class="paper-meta">
                          <span><b>${paper.questionCount}</b> questions</span>
                          <span>${escapeHtml(paper.label)}</span>
                          <span>${[["physics", "Phy"], ["chemistry", "Chem"], ["math", "Math"]]
                            .map(([key, label]) => `${label} ${paper.subjects[key]}`)
                            .join(" · ")}</span>
                        </div>
                      </div>
                      <div class="paper-row-actions">
                        ${saved ? `<span class="chip saved">Saved</span>` : ""}
                        <button class="btn tiny" type="button" data-action="download" data-paper="${escapeHtml(paper.title)}" ${
                          isBusy || !ctx.online ? "disabled" : ""
                        }>
                          ${saved ? "Update" : "Download"}
                        </button>
                        <button class="btn tiny primary" type="button" data-action="start" data-paper="${escapeHtml(paper.title)}" ${
                          isBusy || (!ctx.online && !saved) ? "disabled" : ""
                        }>Start</button>
                      </div>
                    </div>`;
                  })
                  .join("")
              : `<div class="empty" style="border:0;border-radius:0"><strong>No paper matches that search</strong>Try a year, a month, or “Shift 2”.</div>`
          }
        </div>
      </div>

      <div class="selection-panel">
        ${
          selected
            ? `<div class="card paper-summary">
                <div class="chip-row" style="margin-bottom:12px">
                  <span class="chip">${examLabel(ctx.exam)}</span>
                  <span class="chip">${selected.year}</span>
                  ${downloaded ? `<span class="chip saved">Offline ready</span>` : `<span class="chip plain">Not downloaded</span>`}
                </div>
                <h3>${escapeHtml(selected.title)}</h3>
                <div class="summary-meta">
                  ${selected.questionCount} questions · ${selected.subjects.physics} physics · ${selected.subjects.chemistry} chemistry · ${selected.subjects.math} mathematics
                </div>

                <div class="split-list">
                  ${["physics", "chemistry", "math"]
                    .map((key) => {
                      const count = selected.subjects[key];
                      const share = selected.questionCount ? count / selected.questionCount : 0;
                      return `<div class="split-item">
                        <span class="name">${SUBJECT_LABEL[key]}</span>
                        <span class="bar"><span style="width:${(share * 100).toFixed(1)}%;background:var(--${key})"></span></span>
                        <span class="count">${count}</span>
                      </div>`;
                    })
                    .join("")}
                </div>

                ${
                  state.error
                    ? `<div class="notice bad" role="alert" style="margin-bottom:12px">${escapeHtml(state.error)}</div>`
                    : ""
                }
                ${
                  state.progress
                    ? `<div style="margin-bottom:12px">
                        <div class="bar"><span data-progress-bar style="width:${state.progress.share || 2}%"></span></div>
                        <div class="progress-note" data-progress-text>${escapeHtml(state.progress.message || "")}</div>
                      </div>`
                    : ""
                }

                <div class="actions">
                  <button class="btn primary" type="button" data-action="start" data-paper="${escapeHtml(selected.title)}" ${isBusy || blocked ? "disabled" : ""}>
                    ${state.busy === "start" ? `<span class="spin"></span> Preparing paper…` : blocked ? "Needs a connection" : "Start three-hour mock"}
                  </button>
                  <button class="btn" type="button" data-action="download" data-paper="${escapeHtml(selected.title)}" ${isBusy || !ctx.online ? "disabled" : ""}>
                    ${state.busy === "download" ? `<span class="spin"></span> Saving…` : downloaded ? "Update offline copy" : "Download for offline"}
                  </button>
                  ${
                    latest
                      ? `<a class="btn ghost" href="#/attempt/${encodeURIComponent(latest.attempt.id)}">Last analysis · ${scoreLabel(latest.totals.score)}/${scoreLabel(latest.totals.max)}</a>`
                      : ""
                  }
                </div>

                <p class="progress-note" style="text-align:left">
                  ${
                    downloaded
                      ? `Stored in this browser since ${formatDate(relatedOfflineDate(selected.key))}. Opens without a connection.`
                      : "Download stores every question and styles the paper for offline sitting; diagrams are cached when the browser allows it."
                  }
                </p>

                <p class="note">
                  Marking follows the practice scheme: +4 for a correct answer, −1 for a wrong MCQ or
                  numerical. Multiple-correct items score +4 fully, +1 per correct option when nothing
                  wrong is chosen, and −2 if a wrong option is picked.
                  ${ctx.exam === "JEE_Advanced" ? " Some Advanced answer keys contain a single option, so those items are marked as single-answer." : ""}
                </p>
              </div>`
            : `<div class="empty"><strong>Choose a paper</strong>Pick a year and shift from the list.</div>`
        }
      </div>
    </div>
  </div>`;
}

function relatedOfflineDate(key) {
  return getOfflinePaper(key)?.savedAt || "";
}

function setProgress(progress) {
  state.progress = progress;
  const bar = document.querySelector("[data-progress-bar]");
  const text = document.querySelector("[data-progress-text]");
  if (bar && progress?.share) bar.style.width = `${Math.max(2, Math.min(100, progress.share))}%`;
  if (text && progress?.message) text.textContent = progress.message;
}

export function mount(root, ctx) {
  bindExamSwitch(root, ctx);

  const findPaper = async (title) => {
    const catalog = await getPaperCatalog(ctx.exam);
    return catalog.find((paper) => paper.title === title) || null;
  };

  const select = (title) => {
    state.selected = title;
    state.error = "";
    const next = `#/papers?exam=${ctx.exam}&paper=${encodeURIComponent(title)}`;
    if (window.location.hash !== next) window.history.replaceState(null, "", next);
    ctx.rerender();
  };

  root.addEventListener("click", async (event) => {
    const row = event.target.closest(".paper-row[data-paper]");
    const action = event.target.closest("[data-action]")?.dataset.action;

    if (action === "download") {
      event.stopPropagation();
      const title = event.target.closest("[data-action]").dataset.paper;
      const paper = await findPaper(title);
      if (!paper) return;
      state.selected = title;
      state.busy = "download";
      state.error = "";
      setProgress({ message: "Starting download…", share: 2 });
      ctx.rerender();
      try {
        const entry = await downloadPaper(ctx.exam, paper, {
          onStatus: (status) => {
            const share =
              status.total && status.done ? (status.done / status.total) * 100 : status.share || 4;
            setProgress({ message: status.message, share });
          },
        });
        state.busy = "";
        state.progress = null;
        toast(
          `Saved ${paper.title} · ${entry.questionCount} questions${
            entry.images?.total ? `, ${entry.images.cached}/${entry.images.total} diagrams cached` : ""
          }`,
          "good",
        );
        ctx.rerender();
      } catch (error) {
        state.busy = "";
        state.progress = null;
        state.error = error?.message || "The paper could not be downloaded.";
        toast(state.error, "bad");
        ctx.rerender();
      }
      return;
    }

    if (action === "start") {
      event.stopPropagation();
      const title = event.target.closest("[data-action]").dataset.paper;
      const paper = await findPaper(title);
      if (!paper) return;
      state.selected = title;
      state.busy = "start";
      state.error = "";
      setProgress({ message: "Assembling the paper…", share: 6 });
      ctx.rerender();
      try {
        await beginPaper(ctx, paper, {
          onStatus: (message) => setProgress({ message, share: 40 }),
        });
        state.busy = "";
        state.progress = null;
      } catch (error) {
        state.busy = "";
        state.progress = null;
        state.error = error?.message || "The paper could not be prepared.";
        ctx.rerender();
      }
      return;
    }

    if (row) select(row.dataset.paper);
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest?.(".paper-row[data-paper]");
    if (!row) return;
    event.preventDefault();
    select(row.dataset.paper);
  });

  root.addEventListener("change", (event) => {
    if (event.target.matches('[data-role="year"]')) {
      state.year = event.target.value;
      state.query = "";
      state.selected = "";
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
      const active = document.activeElement;
      ctx.rerender();
      if (active?.matches?.('[data-role="search"]')) {
        const next = document.querySelector('[data-role="search"]');
        if (next) {
          next.focus();
          next.setSelectionRange(next.value.length, next.value.length);
        }
      }
    }, 260);
  });
}
