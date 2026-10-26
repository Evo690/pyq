# PYQ Studio

A quiet, offline-first workspace for real JEE previous-year questions. Sit complete papers in
exam order, download them for a connection-free session, and read a full analysis of every attempt.

The whole site is static. Serve the repository root with any static file server and open the served
page:

```bash
python3 -m http.server 4173
# then open http://localhost:4173
```

No build step, no framework, no runtime dependencies. `sw.js` needs an `https://` origin or
`localhost`; on plain `http://` everything works except the offline app shell.

## What is here

| Path | Purpose |
| --- | --- |
| `index.html` | App shell: stylesheet, KaTeX, module entry point |
| `app/app.js` | Hash router, page shell, exam context |
| `app/core.js` | Pure logic — paper ordering, scoring, analysis summaries, chapter/topic progress (unit tested) |
| `app/data.js` | Question-bank access, offline resolution, paper downloads |
| `app/store.js` | localStorage persistence: downloads, attempts, session, preferences |
| `app/session.js` | Practice/test engine: answers, per-question timing, autosave, submission |
| `app/dom.js` | Safe HTML, KaTeX typesetting, toasts, dialogs |
| `app/views/` | Overview, exact papers, question bank, custom set, session, analysis, library |
| `data/` | The question bank, one JSON file per chapter, plus `index.json` and `papers.json` |
| `vendor/katex/` | KaTeX 0.16 with woff2 fonts, for math without a CDN |
| `sw.js` | Service worker: app shell, KaTeX fonts and diagram cache |
| `scripts/build-index.mjs` | Rebuilds `data/index.json` from `data/manifest.json` |
| `tests/core.test.mjs` | `node --test tests/core.test.mjs` |

## The interface

A deliberately plain dark theme: warm neutral greys, hairline rules, one muted accent, no gradients
and no decoration competing with the equation. Everything is responsive; dialogs become bottom
sheets and the question palette becomes a drawer on phones.

## Question bank — chapter-wise and topic-wise

`#/bank` is the chapter-wise / topic-wise PYQ browser:

- every chapter of the selected exam, grouped under Physics / Chemistry / Mathematics, with its PYQ
  count and how many topics it contains;
- open a chapter to list its topics with per-topic question counts;
- **Practise** starts a set from exactly that chapter or that single topic, sized by the
  "questions per set" control — the questions come straight from the chapter file and are filtered
  by topic field, so a topic set contains only that topic;
- search matches chapter *and* topic names, and the subject filter narrows to one subject;
- your accuracy on each chapter and topic appears as a chip, aggregated from every saved sitting;
- deep link `#/bank?exam=JEE_Main&chapter=physics:Thermodynamics` opens that chapter's topics, which
  is how the analysis page sends you to a weak chapter.

Each question also carries its chapter and topic in the session header and in the analysis review
rows, so a set is never anonymous.

`#/practice` (Custom set) remains the multi-chapter builder: tick several chapters, choose a size and
difficulty, and run one mixed untimed set.

## Exact papers load in exam order

Choosing a paper loads **every** question that belongs to that sitting, ordered by:

1. subject — Physics, then Chemistry, then Mathematics;
2. question type inside each subject — MCQ (single correct), then multiple correct, then numerical;
3. chapter, and source-file order within a chapter.

So a JEE Main paper reads: *20 Physics MCQs → 5 Physics numericals → 20 Chemistry MCQs → 5 Chemistry
numericals → 20 Mathematics MCQs → 5 Mathematics numericals*. The navigation palette mirrors those
sections, and the same order is frozen into an offline download.

The source data does not carry original question numbers, so the order above is the best faithful
reconstruction available.

## Download for offline

Any paper can be saved from **Exact papers → Download for offline** (or from an analysis page).

- The normalized question set — stems, options, keys, worked solutions and subject/chapter tags — is
  written to `localStorage` under `pyq.studio.v2.offline-papers` and is roughly a few hundred
  kilobytes per paper.
- Diagrams are warm-cached through the service worker so they replay without a connection.
- The app shell (JS, CSS, KaTeX and its fonts, the paper index) is precached by `sw.js`, so the site
  itself opens offline too.
- An offline copy is always preferred over the network, and the offline library shows what is stored
  plus storage used. Remove a paper to reclaim space; browser storage quota is handled with a clear
  message instead of a silent failure.

Offline is not a separate mode: with no connection the library still opens saved papers, the timer
still runs, and the analysis is still generated locally.

## Analysis

Every finished sitting opens a full page:

- **Score band** — score / maximum, accuracy, attempted, skipped, time on questions, average time per
  answer, marks lost to negative marking.
- **What this sitting says** — generated insights: strongest and weakest subject, cost of wrong
  answers, how much was left blank, chapters to revise, MCQ versus numerical accuracy, clock usage.
- **By subject**, **by question type**, **by difficulty** — accuracy bars with counts and marks.
- **Time distribution** — per-subject time, share of the clock used, the five slowest questions.
- **Chapter breakdown** — answered chapters weakest first, with marks and one-tap practice links.
- **Answer sheet** — every question as a coloured cell; click to open its review entry.
- **Question review** — filters for wrong / skipped / correct, each question with your answer, the
  correct answer, marks and the full worked solution (math typeset).

## Marking scheme

Practice-standard marking: **+4** correct, **−1** wrong MCQ or numerical. Multiple-correct questions
score +4 fully, +1 per correct option chosen when no wrong option is chosen, and −2 if any wrong
option is chosen. Some JEE Advanced source keys hold a single option, so those items behave as
single-answer questions.

## Keyboard shortcuts (during a sitting)

| Key | Action |
| --- | --- |
| `←` / `→` | Previous / next question |
| `1`–`4` | Select an option |
| `M` | Mark / unmark for review |
| `C` | Clear the current response |
| `Enter` | In a numerical field: lock the answer and advance |

## Data

`data/papers.json` indexes papers by year and shift, and points at the chapter files that contain
each paper's questions. `data/index.json` is a compact chapter catalog (names, files and counts)
used by the question bank, the custom-set builder and the overview. It also carries every chapter's
topic list with counts (525 topics for JEE Main, 449 for JEE Advanced); regenerate it with
`node scripts/build-index.mjs` if the chapter set changes. The older `data.zip` archive is kept in the repository but is no longer read by the app.

## Notes

- Progress, downloads and preferences live only in this browser. Clearing site data erases them.
- Attempts are capped at the 8 most recent to protect the storage quota; a full quota is reported
  instead of silently dropping a download.
- Diagrams that could not be cached offline show an inline note instead of a broken image.
