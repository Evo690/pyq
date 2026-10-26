import { analyzeAttempt, formatDate, formatDuration } from "../core.js";
import { confirmDialog, escapeHtml, percent, scoreLabel, toast } from "../dom.js";
import { offlineLibrary } from "../data.js";
import {
  formatBytes,
  listAttempts,
  removeAttempt,
  removeOfflinePaper,
  storageEstimate,
} from "../store.js";
import { beginPaper, emptyState, examLabel, examSwitch, bindExamSwitch } from "./shared.js";

export async function render(ctx) {
  const downloaded = offlineLibrary();
  const attempts = listAttempts()
    .map((attempt) => ({ attempt, data: analyzeAttempt(attempt) }))
    .sort((left, right) => (right.attempt.finishedAt || 0) - (left.attempt.finishedAt || 0));

  const savedQuestions = downloaded.reduce((sum, entry) => sum + (entry.questionCount || 0), 0);
  const { papers: paperBytes, attempts: attemptBytes, total: totalBytes } = storageEstimate();

  return `
  <div class="page">
    <div class="section-head" style="align-items:flex-start;margin-bottom:10px">
      <div>
        <div class="eyebrow">Library</div>
        <h1 class="display" style="font-size:clamp(26px,3.6vw,36px);margin-top:12px">Everything kept in this browser.</h1>
        <p class="lede" style="margin-top:12px;font-size:14.5px">
          Downloaded papers, past analyses and storage use. Nothing here is uploaded anywhere — it
          lives in local storage and works with the network switched off.
        </p>
      </div>
      ${examSwitch(ctx)}
    </div>

    <div class="stat-row">
      <div class="stat">
        <div class="stat-label">Saved papers</div>
        <div class="stat-value">${downloaded.length}</div>
        <div class="stat-foot">${savedQuestions.toLocaleString()} questions offline</div>
      </div>
      <div class="stat">
        <div class="stat-label">Analyses</div>
        <div class="stat-value">${attempts.length}</div>
        <div class="stat-foot">most recent ${attempts[0] ? formatDate(attempts[0].attempt.finishedAt) : "—"}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Browser storage</div>
        <div class="stat-value">${formatBytes(totalBytes)}</div>
        <div class="stat-foot">papers ${formatBytes(paperBytes)} · analyses ${formatBytes(attemptBytes)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Connection</div>
        <div class="stat-value">${ctx.online ? "Online" : "Offline"}</div>
        <div class="stat-foot">${ctx.online ? "new papers can be downloaded" : "saved papers still open"}</div>
      </div>
    </div>

    <section style="margin-top:34px">
      <div class="section-head">
        <h2>Saved for offline</h2>
        <span class="hint">Questions, answers and solutions stored locally</span>
      </div>
      ${
        downloaded.length
          ? `<div class="paper-list">
              ${downloaded
                .map(
                  (entry) => `
                <div class="paper-row">
                  <div>
                    <div class="paper-name">${escapeHtml(entry.title)}</div>
                    <div class="paper-meta">
                      <span>${examLabel(entry.exam)}</span>
                      <span><b>${entry.questionCount}</b> questions</span>
                      <span>saved ${formatDate(entry.savedAt)}</span>
                      ${
                        entry.images?.total
                          ? `<span>${entry.images.cached}/${entry.images.total} diagrams cached</span>`
                          : ""
                      }
                    </div>
                  </div>
                  <span class="chip saved">Offline ready</span>
                  <div class="paper-row-actions">
                    <button class="btn small primary" type="button" data-action="start-offline" data-key="${escapeHtml(entry.key)}">Start</button>
                    <button class="btn small ghost" type="button" data-action="remove-paper" data-key="${escapeHtml(entry.key)}">Remove</button>
                  </div>
                </div>`,
                )
                .join("")}
            </div>`
          : emptyState({
              title: "No papers downloaded",
              body: "Open the exact-papers page, choose a sitting and press Download. The paper is then readable with no connection at all.",
              action: `<a class="btn primary" href="#/papers">Browse papers</a>`,
            })
      }
    </section>

    <section style="margin-top:34px">
      <div class="section-head">
        <h2>Past analyses</h2>
        <span class="hint">${attempts.length ? "Weakest sittings first in each analysis" : "No sittings yet"}</span>
      </div>
      ${
        attempts.length
          ? `<div class="paper-list">
              ${attempts
                .map(({ attempt, data }) => {
                  const accuracy = data.totals.attempted
                    ? (data.totals.correct + data.totals.partial * 0.5) / data.totals.attempted
                    : 0;
                  return `
                  <div class="paper-row">
                    <div>
                      <div class="paper-name">${escapeHtml(attempt.title || "Practice")}</div>
                      <div class="paper-meta">
                        <span>${formatDate(attempt.finishedAt)}</span>
                        <span>${attempt.mode === "paper" ? "Timed paper" : "Practice"}</span>
                        <span>${data.totals.attempted}/${data.totals.total} attempted</span>
                        <span>${percent(accuracy)} accuracy</span>
                        <span>${formatDuration(data.totalTime)}</span>
                        ${attempt.source === "offline" ? "<span>offline</span>" : ""}
                      </div>
                    </div>
                    <div class="paper-subjects mono">
                      ${scoreLabel(data.totals.score)}<span class="faint">/${scoreLabel(data.totals.max)}</span>
                    </div>
                    <div class="paper-row-actions">
                      <a class="btn small primary" href="#/attempt/${encodeURIComponent(attempt.id)}">Analysis</a>
                      <button class="btn small ghost" type="button" data-action="remove-attempt" data-id="${escapeHtml(attempt.id)}">Delete</button>
                    </div>
                  </div>`;
                })
                .join("")}
            </div>`
          : emptyState({
              title: "No analysis yet",
              body: "Finish a paper or a practice set and a complete breakdown appears here.",
              action: `<a class="btn" href="#/papers">Start a paper</a>`,
            })
      }
    </section>

    <section style="margin-top:34px">
      <div class="notice">
        <span>
          Downloading stores the paper's questions, answer keys and solutions as JSON in local storage —
          usually a few hundred kilobytes per paper. Diagrams are cached separately by the browser's
          service worker; if your browser blocks that, a diagram may need a connection while everything
          else still works. Deleting browser data for this site erases downloads and analyses.
        </span>
      </div>
    </section>
  </div>`;
}

export function mount(root, ctx) {
  bindExamSwitch(root, ctx);

  root.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    const button = event.target.closest("[data-action]");

    if (action === "start-offline") {
      const entry = offlineLibrary().find((item) => item.key === button.dataset.key);
      if (!entry) return;
      button.disabled = true;
      button.textContent = "Opening…";
      try {
        await beginPaper(ctx, {
          key: entry.key,
          exam: entry.exam,
          title: entry.title,
          label: entry.label || "Full paper",
          year: entry.year || "",
          questionCount: entry.questionCount,
        });
      } catch (error) {
        toast(error?.message || "The saved paper could not be opened.", "bad");
        button.disabled = false;
        button.textContent = "Start";
      }
      return;
    }

    if (action === "remove-paper") {
      const entry = offlineLibrary().find((item) => item.key === button.dataset.key);
      if (!entry) return;
      const ok = await confirmDialog({
        title: "Remove this download?",
        body: `“${entry.title}” will be deleted from this browser. Past analyses of it are kept.`,
        confirm: "Remove download",
        danger: true,
      });
      if (!ok) return;
      removeOfflinePaper(entry.key);
      toast("Download removed.");
      ctx.rerender();
      return;
    }

    if (action === "remove-attempt") {
      const ok = await confirmDialog({
        title: "Delete this analysis?",
        body: "The score, timings and question review for this sitting will be removed.",
        confirm: "Delete",
        danger: true,
      });
      if (!ok) return;
      removeAttempt(button.dataset.id);
      toast("Analysis deleted.");
      ctx.rerender();
    }
  });
}
