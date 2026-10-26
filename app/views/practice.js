import { SUBJECT_LABEL, SUBJECT_ORDER } from "../core.js";
import { escapeHtml, toast } from "../dom.js";
import { getIndex } from "../data.js";
import { beginPractice, bindExamSwitch, emptyState, examLabel, examSwitch } from "./shared.js";

const state = {
  exam: "",
  selected: new Set(),
  count: 20,
  difficulty: "all",
  busy: false,
  error: "",
};

export async function render(ctx) {
  if (state.exam !== ctx.exam) {
    state.exam = ctx.exam;
    state.selected = new Set();
  }

  const preset = ctx.params?.chapter;
  if (preset) {
    const [subject, ...rest] = preset.split(":");
    const name = rest.join(":");
    if (subject && name) state.selected.add(`${subject}::${name}`);
  }

  let index = null;
  try {
    index = await getIndex();
  } catch {
    index = null;
  }

  const subjects = SUBJECT_ORDER.map((key) => ({
    key,
    data: index?.exams?.[ctx.exam]?.subjects?.find((subject) => subject.key === key),
  })).filter((subject) => subject.data);

  const available = subjects.reduce((sum, subject) => sum + subject.data.chapters.length, 0);
  const chosen = subjects.flatMap((subject) =>
    subject.data.chapters
      .filter((chapter) => state.selected.has(`${subject.key}::${chapter.name}`))
      .map((chapter) => ({ subject: subject.key, name: chapter.name, file: chapter.file })),
  );

  return `
  <div class="page">
    <div class="section-head" style="align-items:flex-start;margin-bottom:10px">
      <div>
        <div class="eyebrow">Practice</div>
        <h1 class="display" style="font-size:clamp(26px,3.6vw,36px);margin-top:12px">Take a chapter apart.</h1>
        <p class="lede" style="margin-top:12px;font-size:14.5px">
          Build a short untimed set from any chapters. Each question reveals its answer and worked
          solution straight away, and every set ends in the same full analysis.
        </p>
      </div>
      ${examSwitch(ctx)}
    </div>

    ${
      index
        ? `<div class="setup-grid">
            <div class="chapter-groups">
              ${subjects
                .map((subject) => {
                  const chapters = subject.data.chapters;
                  const selectedHere = chapters.filter((chapter) =>
                    state.selected.has(`${subject.key}::${chapter.name}`),
                  ).length;
                  return `<section class="chapter-group">
                    <div class="chapter-group-head">
                      <span class="subject-dot" style="width:7px;height:7px;border-radius:50%;background:var(--${subject.key});display:inline-block"></span>
                      <span class="subject-name">${SUBJECT_LABEL[subject.key]}</span>
                      <span class="chip plain">${chapters.length} chapters</span>
                      <span class="spacer"></span>
                      <span class="faint" style="font-size:11.5px">${selectedHere} selected</span>
                      <button class="btn tiny ghost" type="button" data-action="toggle-subject" data-subject="${subject.key}">
                        ${selectedHere === chapters.length ? "Clear" : "All"}
                      </button>
                    </div>
                    <div class="chapter-items">
                      ${chapters
                        .map((chapter) => {
                          const id = `${subject.key}::${chapter.name}`;
                          const checked = state.selected.has(id);
                          return `<label class="chapter-item ${checked ? "is-checked" : ""}">
                            <input type="checkbox" data-chapter="${escapeHtml(id)}" ${checked ? "checked" : ""} />
                            <span>${escapeHtml(chapter.name)}</span>
                            <span class="count">${chapter.count}</span>
                          </label>`;
                        })
                        .join("")}
                    </div>
                  </section>`;
                })
                .join("")}
            </div>

            <div class="selection-panel">
              <div class="card">
                <h3 style="font-family:var(--serif);font-size:19px;margin-bottom:4px">Your set</h3>
                <div class="summary-meta">${examLabel(ctx.exam)} · ${available} chapters available</div>

                <div class="split-list" style="margin:14px 0">
                  ${SUBJECT_ORDER.filter((key) => subjects.some((subject) => subject.key === key))
                    .map((key) => {
                      const total = chosen.filter((chapter) => chapter.subject === key).length;
                      return `<div class="split-item">
                        <span class="name">${SUBJECT_LABEL[key]}</span>
                        <span class="bar"><span style="width:${total ? Math.min(100, total * 12) : 0}%;background:var(--${key})"></span></span>
                        <span class="count">${total}</span>
                      </div>`;
                    })
                    .join("")}
                </div>

                <div class="grid" style="gap:12px">
                  <div class="field">
                    <label for="practice-count">Questions</label>
                    <select id="practice-count" data-role="count">
                      ${[10, 15, 20, 30, 45]
                        .map(
                          (value) =>
                            `<option value="${value}" ${state.count === value ? "selected" : ""}>${value} questions</option>`,
                        )
                        .join("")}
                    </select>
                  </div>
                  <div class="field">
                    <label for="practice-difficulty">Difficulty</label>
                    <select id="practice-difficulty" data-role="difficulty">
                      <option value="all" ${state.difficulty === "all" ? "selected" : ""}>Mixed</option>
                      <option value="1" ${state.difficulty === "1" ? "selected" : ""}>Easy only</option>
                      <option value="2" ${state.difficulty === "2" ? "selected" : ""}>Medium only</option>
                      <option value="3" ${state.difficulty === "3" ? "selected" : ""}>Hard only</option>
                    </select>
                  </div>
                </div>

                ${state.error ? `<div class="notice bad" role="alert" style="margin-top:14px">${escapeHtml(state.error)}</div>` : ""}

                <div class="actions" style="margin-top:16px">
                  <button class="btn primary block" type="button" data-action="start-practice" ${state.busy || !chosen.length ? "disabled" : ""}>
                    ${state.busy ? `<span class="spin"></span> Preparing…` : chosen.length ? `Start ${state.count}-question set` : "Select a chapter to begin"}
                  </button>
                </div>
                <p class="progress-note" style="text-align:left">
                  ${chosen.length
                    ? `${chosen.length} chapter${chosen.length === 1 ? "" : "s"} · untimed · solutions shown after each answer`
                    : "Questions you have not seen yet are preferred."}
                </p>
              </div>
            </div>
          </div>`
        : emptyState({
            title: "Chapter list unavailable",
            body: "The bundled chapter index could not be read in this browser.",
            action: `<a class="btn" href="#/papers">Use an exact paper instead</a>`,
          })
    }
  </div>`;
}

export function mount(root, ctx) {
  bindExamSwitch(root, ctx);

  root.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-chapter]");
    if (checkbox) {
      const id = checkbox.dataset.chapter;
      if (checkbox.checked) state.selected.add(id);
      else state.selected.delete(id);
      ctx.rerender();
      return;
    }
    if (event.target.matches('[data-role="count"]')) {
      state.count = Number(event.target.value) || 20;
      ctx.rerender();
    }
    if (event.target.matches('[data-role="difficulty"]')) {
      state.difficulty = event.target.value;
      ctx.rerender();
    }
  });

  root.addEventListener("click", async (event) => {
    const toggle = event.target.closest('[data-action="toggle-subject"]');
    if (toggle) {
      const subject = toggle.dataset.subject;
      const index = await getIndex();
      const chapters =
        index?.exams?.[ctx.exam]?.subjects?.find((entry) => entry.key === subject)?.chapters || [];
      const ids = chapters.map((chapter) => `${subject}::${chapter.name}`);
      const allSelected = ids.every((id) => state.selected.has(id));
      for (const id of ids) {
        if (allSelected) state.selected.delete(id);
        else state.selected.add(id);
      }
      ctx.rerender();
      return;
    }

    const start = event.target.closest('[data-action="start-practice"]');
    if (!start || state.busy) return;

    const index = await getIndex();
    const chapters = SUBJECT_ORDER.flatMap((subjectKey) => {
      const subject = index?.exams?.[ctx.exam]?.subjects?.find((entry) => entry.key === subjectKey);
      return (subject?.chapters || [])
        .filter((chapter) => state.selected.has(`${subjectKey}::${chapter.name}`))
        .map((chapter) => ({ subject: subjectKey, name: chapter.name, file: chapter.file }));
    });

    if (!chapters.length) {
      state.error = "Select at least one chapter.";
      ctx.rerender();
      return;
    }

    state.busy = true;
    state.error = "";
    ctx.rerender();
    try {
      const label = chapters.length === 1 ? chapters[0].name : `${chapters.length} chapters`;
      await beginPractice(ctx, {
        exam: ctx.exam,
        chapters,
        count: state.count,
        difficulty: state.difficulty,
        title: `Practice · ${label}`,
      });
      state.busy = false;
    } catch (error) {
      state.busy = false;
      state.error = error?.message || "The practice set could not be prepared.";
      toast(state.error, "bad");
      ctx.rerender();
    }
  });
}
