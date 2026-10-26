import { analyzeAttempt, formatDate, formatDuration, recentAttempts } from "../core.js";
import { escapeHtml, percent, scoreLabel } from "../dom.js";
import { getIndex, getPaperCatalog, offlineLibrary } from "../data.js";
import { getSession, listAttempts } from "../store.js";
import { endSession, restoreSession } from "../session.js";
import { emptyState, examLabel, examSwitch, bindExamSwitch } from "./shared.js";

export async function render(ctx) {
  const [index, catalog] = await Promise.all([
    getIndex().catch(() => null),
    getPaperCatalog(ctx.exam).catch(() => []),
  ]);

  const attempts = listAttempts();
  const summaries = attempts.map((attempt) => analyzeAttempt(attempt));
  const totals = summaries.reduce(
    (acc, item) => {
      acc.questions += item.totals.total;
      acc.attempted += item.totals.attempted;
      acc.correct += item.totals.correct;
      acc.score += item.totals.score;
      acc.max += item.totals.max;
      acc.time += item.totals.time;
      return acc;
    },
    { questions: 0, attempted: 0, correct: 0, score: 0, max: 0, time: 0 },
  );
  const accuracy = totals.attempted ? totals.correct / totals.attempted : 0;

  const examTotals = index?.totals?.[ctx.exam] || 0;
  const downloaded = offlineLibrary();
  const paused = getSession();
  const newestPapers = catalog.slice(0, 3);
  const recent = recentAttempts(summaries, 4);

  return `
  <div class="page">
    <section class="hero">
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div class="eyebrow">Previous year questions</div>
          ${examSwitch(ctx)}
        </div>
        <h1 class="display">Sit the real paper.<br />Then read <em>what it says</em>.</h1>
        <p class="lede">
          Every question here comes from an actual JEE sitting — no synthetic items.
          Choose a year and shift to take the whole paper on a three-hour clock, then
          work through a full analysis of where the marks went.
        </p>
        <div class="hero-actions">
          <a class="btn primary" href="#/papers">Choose an exact paper</a>
          <a class="btn" href="#/bank">Browse chapter by chapter</a>
        </div>
      </div>
      <aside class="hero-aside">
        <div class="hero-note">
          <p><strong>${examTotals.toLocaleString()} questions</strong> in the ${examLabel(ctx.exam)} bank, grouped into ${catalog.length} complete papers.</p>
          <p style="margin-top:12px">Download a paper and it stays in this browser, diagrams included, so a weak connection is never the reason to skip a sitting.</p>
          <div class="chip-row" style="margin-top:16px">
            <span class="chip">${downloaded.length} saved offline</span>
            <span class="chip">${attempts.length} attempt${attempts.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      </aside>
    </section>

    <div class="stat-row">
      <div class="stat">
        <div class="stat-label">Question bank</div>
        <div class="stat-value">${examTotals.toLocaleString()}</div>
        <div class="stat-foot">${catalog.length} complete papers</div>
      </div>
      <div class="stat">
        <div class="stat-label">Questions attempted</div>
        <div class="stat-value">${totals.attempted}<small>/ ${totals.questions || 0}</small></div>
        <div class="stat-foot">across ${attempts.length} session${attempts.length === 1 ? "" : "s"}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Accuracy</div>
        <div class="stat-value">${totals.attempted ? percent(accuracy) : "—"}</div>
        <div class="stat-foot">${totals.correct} correct of ${totals.attempted} attempted</div>
      </div>
      <div class="stat">
        <div class="stat-label">Marks earned</div>
        <div class="stat-value">${scoreLabel(totals.score)}<small>/ ${scoreLabel(totals.max)}</small></div>
        <div class="stat-foot">${formatDuration(totals.time)} on questions</div>
      </div>
    </div>

    ${
      paused
        ? `<section class="card" style="margin-top:20px">
            <div class="section-head" style="margin-bottom:10px">
              <h2>A sitting is still open</h2>
              <span class="hint">${escapeHtml(paused.title || "Practice session")}</span>
            </div>
            <p class="muted" style="font-size:13.5px">
              You have ${Object.keys(paused.answers || {}).length} of ${paused.questions?.length || 0} answers recorded.
              ${paused.allowedSeconds ? "The clock is absolute — resuming continues from the time already spent." : "This practice set is untimed."}
            </p>
            <div class="actions" style="margin-top:16px">
              <a class="btn primary" href="#/session">Resume sitting</a>
              <button class="btn ghost" type="button" data-action="discard-session">Discard</button>
            </div>
          </section>`
        : ""
    }

    <section style="margin-top:36px">
      <div class="section-head">
        <h2>Recent sittings</h2>
        <span class="hint">${attempts.length ? "Open any sitting for the full analysis" : "Nothing scored yet"}</span>
      </div>
      ${
        recent.length
          ? `<div class="paper-list">${recent
              .map(
                (item) => `
              <div class="paper-row">
                <div>
                  <div class="paper-name">${escapeHtml(item.attempt.title || "Practice")}</div>
                  <div class="paper-meta">
                    <span>${formatDate(item.attempt.finishedAt)}</span>
                    <span>${item.attempt.mode === "paper" ? "Timed paper" : "Practice"}</span>
                    <span>${item.totals.attempted}/${item.totals.total} attempted</span>
                    <span>${formatDuration(item.totalTime)}</span>
                  </div>
                </div>
                <div class="paper-subjects mono">
                  ${scoreLabel(item.totals.score)}<span class="faint">/${scoreLabel(item.totals.max)}</span>
                </div>
                <div class="paper-row-actions">
                  <a class="btn small" href="#/attempt/${encodeURIComponent(item.attempt.id)}">Analysis</a>
                </div>
              </div>`,
              )
              .join("")}</div>`
          : emptyState({
              title: "No analysis yet",
              body: "Take a paper or a short practice set and the numbers will start telling you where to spend the next hour.",
              action: `<a class="btn primary" href="#/papers">Start with a paper</a>`,
            })
      }
    </section>

    <section style="margin-top:36px">
      <div class="section-head">
        <h2>Latest papers</h2>
        <a class="hint" href="#/papers">All papers →</a>
      </div>
      ${
        newestPapers.length
          ? `<div class="paper-list">${newestPapers
              .map(
                (paper) => `
              <div class="paper-row">
                <div>
                  <div class="paper-name">${escapeHtml(paper.title)}</div>
                  <div class="paper-meta">
                    <span><b>${paper.questionCount}</b> questions</span>
                    <span>${paper.year}</span>
                  </div>
                </div>
                <div class="paper-subjects">
                  <span class="s-physics">PHY <b class="mono">${paper.subjects.physics}</b></span>
                  <span class="s-chemistry">CHE <b class="mono">${paper.subjects.chemistry}</b></span>
                  <span class="s-math">MAT <b class="mono">${paper.subjects.math}</b></span>
                </div>
                <div class="paper-row-actions">
                  <a class="btn small" href="#/papers?exam=${ctx.exam}&paper=${encodeURIComponent(paper.title)}">Open</a>
                </div>
              </div>`,
              )
              .join("")}</div>`
          : emptyState({
              title: ctx.online ? "Paper list unavailable" : "You are offline",
              body: ctx.online
                ? "The bundled paper index could not be read."
                : "Paper titles load from the workspace bundle. Downloaded papers are always available in the library.",
              action: `<a class="btn" href="#/library">Open library</a>`,
            })
      }
    </section>

    <section style="margin-top:36px">
      <div class="section-head">
        <h2>Saved for offline</h2>
        <span class="hint">${downloaded.length} paper${downloaded.length === 1 ? "" : "s"} in this browser</span>
      </div>
      ${
        downloaded.length
          ? `<div class="paper-list">${downloaded
              .slice(0, 4)
              .map(
                (entry) => `
              <div class="paper-row">
                <div>
                  <div class="paper-name">${escapeHtml(entry.title)}</div>
                  <div class="paper-meta">
                    <span>${entry.questionCount} questions</span>
                    <span>saved ${formatDate(entry.savedAt)}</span>
                  </div>
                </div>
                <span class="chip saved">Offline ready</span>
                <div class="paper-row-actions"><a class="btn small" href="#/library">Open</a></div>
              </div>`,
              )
              .join("")}</div>`
          : emptyState({
              title: "Nothing downloaded yet",
              body: "On the exact-papers page, use Download to keep a paper — with its diagrams — inside this browser for offline sitting and analysis.",
              action: `<a class="btn" href="#/papers">Browse papers</a>`,
            })
      }
    </section>
  </div>`;
}

export function mount(root, ctx) {
  bindExamSwitch(root, ctx);
  root.addEventListener("click", async (event) => {
    const discard = event.target.closest('[data-action="discard-session"]');
    if (!discard) return;
    restoreSession();
    endSession();
    ctx.rerender();
  });
}

