import { analyzeTest } from "./experience.mjs";

const SUBJECT_NAMES = {
  physics: "Physics",
  chemistry: "Chemistry",
  math: "Mathematics",
};

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  if (value < 60) return `${value}s`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return secs > 0
    ? `${minutes}m ${String(secs).padStart(2, "0")}s`
    : `${minutes}m`;
}

function levelLabel(level) {
  if (level === 1) return "Easy · L1";
  if (level === 2) return "Medium · L2";
  if (level === 3) return "Hard · L3";
  return "Unrated";
}

function typeLabel(type) {
  if (type === "numerical") return "Numerical";
  if (type === "multipleCorrect") return "Multi-correct";
  return "MCQ";
}

function answerDisplay(question, answer) {
  if (
    answer === undefined ||
    answer === null ||
    answer === "" ||
    (Array.isArray(answer) && !answer.length)
  ) {
    return "Skipped";
  }
  if (question.type === "numerical") return String(answer);
  const answers = Array.isArray(answer) ? answer : [answer];
  return answers
    .map((id) => {
      const idx = (question.options || []).findIndex(
        (item) => String(item.id) === String(id),
      );
      const option = idx >= 0 ? question.options[idx] : null;
      const letter = idx >= 0 ? String.fromCharCode(65 + idx) : String(id);
      if (option && option.text) {
        return `(${letter}) ${option.text}`;
      }
      return `Option ${letter}`;
    })
    .join(" · ");
}

/**
 * Dedicated fullscreen, mobile-compatible post-test analysis screen.
 * Works with existing completed test records without changing storage format.
 */
export function TestAnalysisScreen({
  React,
  test,
  onReview,
  onBack,
  backLabel = "Back to tests",
  RichText,
  SubjectIcon,
}) {
  const h = React.createElement;
  const report = React.useMemo(() => analyzeTest(test), [test]);
  const [activeTab, setActiveTab] = React.useState("overview");
  const [subjectFilter, setSubjectFilter] = React.useState("all");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [difficultyFilter, setDifficultyFilter] = React.useState("all");
  const [expandedUid, setExpandedUid] = React.useState(null);

  React.useEffect(() => {
    setActiveTab("overview");
    setSubjectFilter("all");
    setStatusFilter("all");
    setTypeFilter("all");
    setDifficultyFilter("all");
    setExpandedUid(null);
  }, [test?.id]);

  if (!test) return null;

  const renderRich = (text, className = "") =>
    RichText
      ? h(RichText, { text: text || "", className })
      : h("div", { className: `rich ${className}`.trim() }, text || "");

  const renderSubjectBadge = (subjectKey, color = "mint") =>
    h(
      "span",
      { className: `analysis-subject-badge ${color}` },
      SubjectIcon
        ? h(SubjectIcon, { name: subjectKey, size: 18, strokeWidth: 1.7 })
        : (SUBJECT_NAMES[subjectKey] || subjectKey || "S")[0].toUpperCase(),
    );

  const examTitle =
    test.exam === "JEE_Advanced"
      ? "JEE Advanced"
      : test.exam === "JEE_Main"
        ? "JEE Main"
        : "Practice Mock";

  const dateLabel = test.date
    ? new Date(test.date).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  const visibleQuestions = report.questions.filter((question) => {
    if (subjectFilter !== "all" && (question.subject || "") !== subjectFilter) {
      return false;
    }
    if (statusFilter !== "all" && question.status !== statusFilter) {
      return false;
    }
    if (typeFilter !== "all" && question.questionType !== typeFilter) {
      return false;
    }
    if (
      difficultyFilter !== "all" &&
      String(question.difficulty || "unrated") !== String(difficultyFilter)
    ) {
      return false;
    }
    return true;
  });

  const jumpToQuestion = (question) => {
    setActiveTab("questions");
    setSubjectFilter("all");
    setStatusFilter("all");
    setTypeFilter("all");
    setDifficultyFilter("all");
    setExpandedUid(question.uid);
    setTimeout(() => {
      const node = document.getElementById(`analysis-q-${question.index}`);
      if (node && typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 40);
  };

  const statusNames = {
    correct: "Correct",
    incorrect: "Incorrect",
    skipped: "Skipped",
    unscored: "Unscored",
  };

  const tabs = [
    ["overview", "Overview & Subjects"],
    ["breakdown", "Chapters & Pace"],
    ["questions", `Questions (${report.total})`],
  ];

  return h("div", { className: "analysis-screen" }, [
    // Sticky top header bar
    h("header", { className: "analysis-topbar", key: "topbar" }, [
      h("div", { className: "analysis-topbar-inner" }, [
        onBack &&
          h(
            "button",
            {
              type: "button",
              className: "analysis-back-btn",
              onClick: onBack,
            },
            [
              h("span", { "aria-hidden": "true", key: "arrow" }, "←"),
              h("span", { key: "text" }, backLabel),
            ],
          ),
        h("div", { className: "analysis-topbar-title", key: "title" }, [
          h("span", { className: "analysis-topbar-kicker", key: "kicker" }, `${examTitle} · Analysis`),
          h("strong", { key: "name" }, test.title || "Completed Test"),
        ]),
        onReview &&
          h(
            "button",
            {
              type: "button",
              className: "btn primary analysis-review-cta",
              onClick: () => onReview(test),
              key: "review",
            },
            "Review solutions →",
          ),
      ]),
    ]),

    // Main scrollable container
    h("div", { className: "analysis-body", key: "body" }, [
      // Hero Scorecard
      h("section", { className: "analysis-hero", key: "hero" }, [
        h("div", { className: "analysis-hero-main", key: "main" }, [
          h("div", { className: "analysis-eyebrow-row", key: "eyebrow" }, [
            h("span", { className: "analysis-chip", key: "exam" }, examTitle),
            dateLabel &&
              h("span", { className: "analysis-meta-text", key: "date" }, dateLabel),
            h(
              "span",
              { className: "analysis-meta-text", key: "qs" },
              `${report.total} Qs`,
            ),
            h(
              "span",
              { className: "analysis-meta-text", key: "dur" },
              test.minutes
                ? `${formatDuration(report.totalSeconds)} / ${test.minutes}m`
                : formatDuration(report.totalSeconds),
            ),
          ]),
          h("h1", { className: "analysis-title", key: "h1" }, test.title || "Test Analysis"),
          h(
            "p",
            { className: "analysis-subtitle", key: "sub" },
            `+${report.positiveMarks} from ${report.correct} correct · −${report.negativeMarks} negative marks from ${report.incorrect} incorrect · ${report.skipped} skipped`,
          ),
          // Segmented distribution bar
          h("div", { className: "analysis-dist-wrap", key: "dist" }, [
            h(
              "div",
              {
                className: "analysis-dist-bar",
                role: "img",
                "aria-label": `${report.correct} correct, ${report.incorrect} incorrect, ${report.skipped} skipped`,
                key: "bar",
              },
              [
                report.correct > 0 &&
                  h("span", {
                    key: "c",
                    className: "seg-correct",
                    style: { flexGrow: report.correct },
                  }),
                report.incorrect > 0 &&
                  h("span", {
                    key: "w",
                    className: "seg-incorrect",
                    style: { flexGrow: report.incorrect },
                  }),
                report.unscored > 0 &&
                  h("span", {
                    key: "u",
                    className: "seg-unscored",
                    style: { flexGrow: report.unscored },
                  }),
                report.skipped > 0 &&
                  h("span", {
                    key: "s",
                    className: "seg-skipped",
                    style: { flexGrow: report.skipped },
                  }),
              ],
            ),
            h("div", { className: "analysis-dist-legend", key: "legend" }, [
              h("span", { key: "c" }, [
                h("i", { className: "dot-correct", key: "d" }),
                `Correct ${report.correct}`,
              ]),
              h("span", { key: "w" }, [
                h("i", { className: "dot-incorrect", key: "d" }),
                `Incorrect ${report.incorrect}`,
              ]),
              h("span", { key: "s" }, [
                h("i", { className: "dot-skipped", key: "d" }),
                `Skipped ${report.skipped}`,
              ]),
              report.unscored > 0 &&
                h("span", { key: "u" }, [
                  h("i", { className: "dot-unscored", key: "d" }),
                  `Unscored ${report.unscored}`,
                ]),
            ]),
          ]),
        ]),

        h("div", { className: "analysis-hero-scorecard", key: "scorecard" }, [
          h(
            "div",
            {
              className: "analysis-score-ring",
              style: { "--pct": `${Math.max(0, Math.min(100, report.scorePercent))}%` },
              key: "ring",
            },
            [
              h("div", { className: "analysis-score-ring-inner", key: "inner" }, [
                h("strong", { key: "val" }, report.score),
                h("span", { key: "max" }, `out of ${report.maxScore}`),
              ]),
            ],
          ),
          h("div", { className: "analysis-hero-pills", key: "pills" }, [
            h("div", { className: "analysis-mini-metric", key: "acc" }, [
              h("span", { key: "l" }, "Accuracy"),
              h("strong", { key: "v" }, `${report.accuracy}%`),
            ]),
            h("div", { className: "analysis-mini-metric", key: "att" }, [
              h("span", { key: "l" }, "Attempted"),
              h("strong", { key: "v" }, `${report.attempted}/${report.scoreableTotal}`),
            ]),
            h("div", { className: "analysis-mini-metric", key: "pace" }, [
              h("span", { key: "l" }, "Avg / Attempt"),
              h(
                "strong",
                { key: "v" },
                report.averageSecondsPerAttempt === null
                  ? "—"
                  : formatDuration(report.averageSecondsPerAttempt),
              ),
            ]),
          ]),
        ]),
      ]),

      // Quick KPI Strip
      h("section", { className: "analysis-kpi-strip", key: "kpis" }, [
        h("article", { className: "analysis-kpi correct", key: "pos" }, [
          h("span", { key: "l" }, "Positive Marks"),
          h("strong", { key: "v" }, `+${report.positiveMarks}`),
          h("small", { key: "s" }, `${report.correct} × +4 marks`),
        ]),
        h("article", { className: "analysis-kpi incorrect", key: "neg" }, [
          h("span", { key: "l" }, "Negative Marks"),
          h("strong", { key: "v" }, report.negativeMarks ? `−${report.negativeMarks}` : "0"),
          h("small", { key: "s" }, `${report.incorrect} × −1 mark`),
        ]),
        h("article", { className: "analysis-kpi neutral", key: "rate" }, [
          h("span", { key: "l" }, "Attempt Rate"),
          h("strong", { key: "v" }, `${report.attemptRate}%`),
          h("small", { key: "s" }, `${report.skipped} left unattempted`),
        ]),
        h("article", { className: "analysis-kpi time", key: "time" }, [
          h("span", { key: "l" }, "Time Taken"),
          h("strong", { key: "v" }, formatDuration(report.totalSeconds)),
          h(
            "small",
            { key: "s" },
            report.measuredQuestions
              ? `${report.measuredQuestions} questions timed`
              : "Overall test duration",
          ),
        ]),
      ]),

      // Mobile-friendly segmented navigation tabs
      h(
        "nav",
        {
          className: "analysis-tabs",
          "aria-label": "Test analysis sections",
          key: "tabs",
        },
        tabs.map(([id, label]) =>
          h(
            "button",
            {
              key: id,
              type: "button",
              className: `analysis-tab ${activeTab === id ? "active" : ""}`,
              onClick: () => setActiveTab(id),
            },
            label,
          ),
        ),
      ),

      // TAB 1: OVERVIEW & SUBJECTS
      activeTab === "overview" &&
        h("div", { className: "analysis-tab-panel", key: "panel-overview" }, [
          // Subject-wise Marks & Breakdown
          h("section", { className: "analysis-section", key: "subjects" }, [
            h("div", { className: "analysis-section-head", key: "head" }, [
              h("div", { key: "copy" }, [
                h("span", { className: "eyebrow", key: "e" }, "SUBJECT-WISE PERFORMANCE"),
                h("h2", { key: "h" }, "Marks & accuracy by subject"),
                h(
                  "p",
                  { key: "p" },
                  "Compare your marks, MCQ vs numerical split, and time spent across Physics, Chemistry, and Mathematics.",
                ),
              ]),
            ]),
            h(
              "div",
              {
                className: `analysis-subject-grid cols-${Math.min(3, Math.max(1, report.subjects.length))}`,
                key: "grid",
              },
              report.subjects.map((sub) => {
                const subPct =
                  sub.maxScore > 0
                    ? Math.max(0, Math.min(100, Math.round((sub.score / sub.maxScore) * 100)))
                    : 0;
                return h(
                  "article",
                  {
                    className: `analysis-subject-card ${sub.color}`,
                    key: sub.key,
                  },
                  [
                    h("div", { className: "analysis-subject-top", key: "top" }, [
                      h("div", { className: "analysis-subject-name", key: "name" }, [
                        renderSubjectBadge(sub.key, sub.color),
                        h("div", { key: "txt" }, [
                          h("h3", { key: "h3" }, sub.label),
                          h(
                            "small",
                            { key: "sm" },
                            `${sub.total} questions · ${sub.attempted} attempted`,
                          ),
                        ]),
                      ]),
                      h("div", { className: "analysis-subject-score", key: "sc" }, [
                        h("strong", { key: "st" }, [
                          sub.score,
                          h("small", { key: "mx" }, ` / ${sub.maxScore}`),
                        ]),
                        h("span", { key: "lbl" }, "marks"),
                      ]),
                    ]),

                    h("div", { className: "progress-track", key: "bar" }, [
                      h("i", { style: { width: `${subPct}%` }, key: "fill" }),
                    ]),

                    h("div", { className: "analysis-subject-metrics", key: "metrics" }, [
                      h("div", { key: "acc" }, [
                        h("span", { key: "l" }, "Accuracy"),
                        h("strong", { key: "v" }, `${sub.accuracy}%`),
                      ]),
                      h("div", { key: "c" }, [
                        h("span", { key: "l" }, "Correct"),
                        h("strong", { className: "tone-correct", key: "v" }, `${sub.correct} (+${sub.positiveMarks})`),
                      ]),
                      h("div", { key: "w" }, [
                        h("span", { key: "l" }, "Wrong"),
                        h(
                          "strong",
                          { className: "tone-incorrect", key: "v" },
                          sub.incorrect ? `${sub.incorrect} (−${sub.negativeMarks})` : "0",
                        ),
                      ]),
                      h("div", { key: "s" }, [
                        h("span", { key: "l" }, "Skipped"),
                        h("strong", { key: "v" }, sub.skipped),
                      ]),
                    ]),

                    // MCQ vs Numerical split inside subject
                    (sub.mcq.total > 0 && sub.numerical.total > 0) &&
                      h("div", { className: "analysis-subject-types", key: "types" }, [
                        h("div", { className: "analysis-subtype-pill", key: "mcq" }, [
                          h("span", { key: "l" }, `MCQ (${sub.mcq.total})`),
                          h(
                            "strong",
                            { key: "v" },
                            `${sub.mcq.score}/${sub.mcq.maxScore} marks · ${sub.mcq.correct}/${sub.mcq.attempted} right`,
                          ),
                        ]),
                        h("div", { className: "analysis-subtype-pill", key: "num" }, [
                          h("span", { key: "l" }, `Numerical (${sub.numerical.total})`),
                          h(
                            "strong",
                            { key: "v" },
                            `${sub.numerical.score}/${sub.numerical.maxScore} marks · ${sub.numerical.correct}/${sub.numerical.attempted} right`,
                          ),
                        ]),
                      ]),

                    h("div", { className: "analysis-subject-foot", key: "foot" }, [
                      h(
                        "span",
                        { key: "time" },
                        sub.seconds > 0
                          ? `Time: ${formatDuration(sub.seconds)}${
                              sub.averageSecondsPerAttempt
                                ? ` · ${formatDuration(sub.averageSecondsPerAttempt)}/attempt`
                                : ""
                            }`
                          : `${sub.unscored ? `${sub.unscored} unscored · ` : ""}+4 / −1 scheme`,
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: "text-button",
                          onClick: () => {
                            setSubjectFilter(sub.key);
                            setActiveTab("questions");
                          },
                          key: "inspect",
                        },
                        `View ${sub.label} Qs →`,
                      ),
                    ]),
                  ],
                );
              }),
            ),
          ]),

          // Question Type + Difficulty side-by-side / stacked
          h("div", { className: "analysis-two-col", key: "two-col" }, [
            // Question Type Breakdown (MCQ vs Numerical)
            h("section", { className: "analysis-section", key: "qtypes" }, [
              h("div", { className: "analysis-section-head", key: "head" }, [
                h("div", { key: "copy" }, [
                  h("span", { className: "eyebrow", key: "e" }, "SECTION FORMAT"),
                  h("h2", { key: "h" }, "MCQ vs Numerical performance"),
                ]),
              ]),
              h(
                "div",
                { className: "analysis-type-list", key: "list" },
                report.questionTypes.map((qt) =>
                  h("article", { className: "analysis-type-card", key: qt.type }, [
                    h("div", { className: "analysis-type-top", key: "top" }, [
                      h("div", { key: "info" }, [
                        h("strong", { key: "lbl" }, qt.label),
                        h(
                          "small",
                          { key: "sub" },
                          `${qt.total} questions · ${qt.attempted} attempted · ${qt.skipped} skipped`,
                        ),
                      ]),
                      h("div", { className: "analysis-type-score", key: "sc" }, [
                        h(
                          "strong",
                          { key: "v" },
                          qt.type === "multipleCorrect"
                            ? "Unscored"
                            : `${qt.score} / ${qt.maxScore}`,
                        ),
                        h("small", { key: "acc" }, `${qt.accuracy}% accuracy`),
                      ]),
                    ]),
                    h("div", { className: "progress-track", key: "bar" }, [
                      h("i", { style: { width: `${qt.accuracy}%` }, key: "f" }),
                    ]),
                    h("div", { className: "analysis-type-meta", key: "meta" }, [
                      h("span", { key: "c" }, `✓ ${qt.correct} correct`),
                      h("span", { key: "w" }, `✕ ${qt.incorrect} wrong`),
                      qt.seconds > 0 &&
                        h("span", { key: "t" }, `⏱ ${formatDuration(qt.seconds)}`),
                    ]),
                  ]),
                ),
              ),
            ]),

            // Difficulty Breakdown
            h("section", { className: "analysis-section", key: "diff" }, [
              h("div", { className: "analysis-section-head", key: "head" }, [
                h("div", { key: "copy" }, [
                  h("span", { className: "eyebrow", key: "e" }, "DIFFICULTY ANALYSIS"),
                  h("h2", { key: "h" }, "Where marks were won & lost"),
                ]),
              ]),
              h(
                "div",
                { className: "analysis-type-list", key: "list" },
                report.difficulty.map((group) =>
                  h(
                    "article",
                    {
                      className: `analysis-type-card diff-${group.level || "unrated"}`,
                      key: String(group.level),
                    },
                    [
                      h("div", { className: "analysis-type-top", key: "top" }, [
                        h("div", { key: "info" }, [
                          h("strong", { key: "lbl" }, group.label),
                          h(
                            "small",
                            { key: "sub" },
                            `${group.total} Qs · ${group.correct} right · ${group.incorrect} wrong · ${group.skipped} skipped`,
                          ),
                        ]),
                        h("div", { className: "analysis-type-score", key: "sc" }, [
                          h("strong", { key: "v" }, `${group.score} / ${group.maxScore}`),
                          h("small", { key: "acc" }, `${group.accuracy}% accuracy`),
                        ]),
                      ]),
                      h("div", { className: "progress-track", key: "bar" }, [
                        h("i", { style: { width: `${group.accuracy}%` }, key: "f" }),
                      ]),
                    ],
                  ),
                ),
              ),
            ]),
          ]),

          // Interactive Question Response Map (tap any number to inspect)
          h("section", { className: "analysis-section", key: "map" }, [
            h("div", { className: "analysis-section-head", key: "head" }, [
              h("div", { key: "copy" }, [
                h("span", { className: "eyebrow", key: "e" }, "QUESTION MAP"),
                h("h2", { key: "h" }, "Paper response grid"),
                h(
                  "p",
                  { key: "p" },
                  "Tap any question cell to jump straight to its worked solution and answer key.",
                ),
              ]),
            ]),
            h(
              "div",
              { className: "analysis-qmap-groups", key: "groups" },
              report.subjects.map((sub) => {
                const subQuestions = report.questions.filter(
                  (q) => (q.subject || "") === sub.key,
                );
                return h("div", { className: "analysis-qmap-subject", key: sub.key }, [
                  h("div", { className: "analysis-qmap-label", key: "lbl" }, [
                    h("strong", { key: "n" }, sub.label),
                    h(
                      "span",
                      { key: "m" },
                      `${sub.score}/${sub.maxScore} marks · ${sub.correct}✓ ${sub.incorrect}✕ ${sub.skipped}–`,
                    ),
                  ]),
                  h(
                    "div",
                    { className: "analysis-qmap-grid", key: "grid" },
                    subQuestions.map((q) =>
                      h(
                        "button",
                        {
                          key: q.uid,
                          type: "button",
                          className: `analysis-qmap-cell ${q.status} ${
                            q.questionType === "numerical" ? "is-num" : ""
                          }`,
                          title: `Q${q.index} · ${statusNames[q.status]} · ${typeLabel(
                            q.questionType,
                          )}`,
                          onClick: () => jumpToQuestion(q),
                        },
                        q.index,
                      ),
                    ),
                  ),
                ]);
              }),
            ),
          ]),
        ]),

      // TAB 2: CHAPTERS, TOPICS & PACE
      activeTab === "breakdown" &&
        h("div", { className: "analysis-tab-panel", key: "panel-breakdown" }, [
          // Time & Stamina Analysis
          h("section", { className: "analysis-section", key: "pace" }, [
            h("div", { className: "analysis-section-head", key: "head" }, [
              h("div", { key: "copy" }, [
                h("span", { className: "eyebrow", key: "e" }, "TIME & MOMENTUM"),
                h("h2", { key: "h" }, "Pacing & exam stamina"),
                h(
                  "p",
                  { key: "p" },
                  "See how your time split across outcomes and whether your accuracy held steady through the second half.",
                ),
              ]),
            ]),
            h("div", { className: "analysis-pace-grid", key: "pgrid" }, [
              h("article", { className: "analysis-pace-card", key: "h1" }, [
                h("span", { key: "l" }, "First half"),
                h("strong", { key: "v" }, `${report.halves.first.accuracy}%`),
                h(
                  "small",
                  { key: "s" },
                  `${report.halves.first.score} marks · ${report.halves.first.correct}/${report.halves.first.attempted} correct`,
                ),
              ]),
              h("article", { className: "analysis-pace-card", key: "h2" }, [
                h("span", { key: "l" }, "Second half"),
                h("strong", { key: "v" }, `${report.halves.second.accuracy}%`),
                h(
                  "small",
                  { key: "s" },
                  `${report.halves.second.score} marks · ${report.halves.second.correct}/${report.halves.second.attempted} correct`,
                ),
              ]),
              h(
                "article",
                {
                  className: `analysis-pace-card ${
                    report.halves.delta === null
                      ? ""
                      : report.halves.delta >= 0
                        ? "positive"
                        : "negative"
                  }`,
                  key: "delta",
                },
                [
                  h("span", { key: "l" }, "Stamina shift"),
                  h(
                    "strong",
                    { key: "v" },
                    report.halves.delta === null
                      ? "—"
                      : `${report.halves.delta > 0 ? "+" : ""}${report.halves.delta} pp`,
                  ),
                  h(
                    "small",
                    { key: "s" },
                    report.halves.delta === null
                      ? "Attempt both halves to compare"
                      : report.halves.delta >= 0
                        ? "Maintained or improved accuracy"
                        : "Accuracy dipped in second half",
                  ),
                ],
              ),
              h("article", { className: "analysis-pace-card", key: "tcorr" }, [
                h("span", { key: "l" }, "Time on Correct vs Wrong"),
                h(
                  "strong",
                  { key: "v" },
                  report.measuredQuestions
                    ? `${formatDuration(report.correctSeconds)} / ${formatDuration(
                        report.incorrectSeconds,
                      )}`
                    : "—",
                ),
                h(
                  "small",
                  { key: "s" },
                  report.measuredQuestions
                    ? `Skipped viewing time: ${formatDuration(report.skippedSeconds)}`
                    : "Per-question timing recorded on new tests",
                ),
              ]),
            ]),
          ]),

          // Chapter-wise Marks Table / Cards
          h("section", { className: "analysis-section", key: "chapters" }, [
            h("div", { className: "analysis-section-head", key: "head" }, [
              h("div", { key: "copy" }, [
                h("span", { className: "eyebrow", key: "e" }, "CHAPTER BREAKDOWN"),
                h("h2", { key: "h" }, "Marks by chapter"),
                h(
                  "p",
                  { key: "p" },
                  `${report.chapters.length} chapters appeared in this test.`,
                ),
              ]),
            ]),
            h(
              "div",
              { className: "analysis-chapter-list", key: "list" },
              report.chapters.map((ch) =>
                h(
                  "article",
                  {
                    className: "analysis-chapter-row",
                    key: `${ch.subject}:${ch.chapter}`,
                  },
                  [
                    h("div", { className: "analysis-chapter-info", key: "info" }, [
                      h("strong", { key: "c" }, ch.chapter),
                      h(
                        "small",
                        { key: "s" },
                        `${SUBJECT_NAMES[ch.subject] || ch.subject || "General"} · ${
                          ch.total
                        } Qs${ch.seconds > 0 ? ` · ${formatDuration(ch.seconds)}` : ""}`,
                      ),
                    ]),
                    h("div", { className: "analysis-chapter-stats", key: "st" }, [
                      h(
                        "span",
                        { className: "ch-counts", key: "cnt" },
                        `${ch.correct}✓ ${ch.incorrect}✕ ${ch.skipped}–`,
                      ),
                      h(
                        "strong",
                        {
                          className: `ch-score ${
                            ch.score > 0 ? "pos" : ch.score < 0 ? "neg" : ""
                          }`,
                          key: "sc",
                        },
                        `${ch.score} / ${ch.maxScore}`,
                      ),
                    ]),
                  ],
                ),
              ),
            ),
          ]),

          // Topic Breakdown
          h("section", { className: "analysis-section", key: "topics" }, [
            h("div", { className: "analysis-section-head", key: "head" }, [
              h("div", { key: "copy" }, [
                h("span", { className: "eyebrow", key: "e" }, "TOPIC ACCURACY"),
                h("h2", { key: "h" }, "Weakest to strongest topics"),
              ]),
            ]),
            report.topics.length
              ? h(
                  "div",
                  { className: "test-topic-list", key: "tlist" },
                  report.topics.map((topic) =>
                    h(
                      "article",
                      {
                        className: "test-topic-row",
                        key: `${topic.subject}:${topic.chapter}:${topic.topic}`,
                      },
                      [
                        h("div", { className: "test-topic-info", key: "info" }, [
                          h("strong", { key: "t" }, topic.topic),
                          h(
                            "small",
                            { key: "c" },
                            `${topic.chapter || ""}${
                              topic.subject
                                ? ` · ${SUBJECT_NAMES[topic.subject] || topic.subject}`
                                : ""
                            }`,
                          ),
                        ]),
                        h("div", { className: "test-topic-progress", key: "prog" }, [
                          h("div", { className: "progress-track", key: "tr" }, [
                            h("i", { style: { width: `${topic.accuracy}%` }, key: "f" }),
                          ]),
                        ]),
                        h("div", { className: "test-topic-value", key: "val" }, [
                          h("strong", { key: "a" }, `${topic.score}/${topic.maxScore} pts`),
                          h(
                            "small",
                            { key: "s" },
                            `${topic.accuracy}% · ${topic.correct}/${topic.attempted} right`,
                          ),
                        ]),
                      ],
                    ),
                  ),
                )
              : h(
                  "p",
                  { className: "report-empty", key: "empty" },
                  "Topic metadata is unavailable for this test.",
                ),
          ]),
        ]),

      // TAB 3: QUESTION-BY-QUESTION REVIEW
      activeTab === "questions" &&
        h("div", { className: "analysis-tab-panel", key: "panel-questions" }, [
          h("section", { className: "analysis-section", key: "qpanel" }, [
            h("div", { className: "analysis-section-head", key: "head" }, [
              h("div", { key: "copy" }, [
                h("span", { className: "eyebrow", key: "e" }, "QUESTION-BY-QUESTION"),
                h("h2", { key: "h" }, "Inspect every question & solution"),
                h(
                  "p",
                  { key: "p" },
                  `Showing ${visibleQuestions.length} of ${report.total} questions.`,
                ),
              ]),
            ]),

            // Subject quick filter pills
            report.subjects.length > 1 &&
              h("div", { className: "analysis-pill-filters", key: "sub-pills" }, [
                h(
                  "button",
                  {
                    key: "all",
                    type: "button",
                    className: subjectFilter === "all" ? "active" : "",
                    onClick: () => setSubjectFilter("all"),
                  },
                  `All (${report.total})`,
                ),
                ...report.subjects.map((sub) =>
                  h(
                    "button",
                    {
                      key: sub.key,
                      type: "button",
                      className: subjectFilter === sub.key ? "active" : "",
                      onClick: () => setSubjectFilter(sub.key),
                    },
                    `${sub.label} (${sub.total})`,
                  ),
                ),
              ]),

            // Dropdown filters
            h("div", { className: "analysis-filter-row", key: "filters" }, [
              h("label", { key: "status" }, [
                "Outcome",
                h(
                  "select",
                  {
                    value: statusFilter,
                    onChange: (e) => setStatusFilter(e.target.value),
                    key: "sel",
                  },
                  [
                    h("option", { value: "all", key: "all" }, "All outcomes"),
                    h("option", { value: "correct", key: "c" }, `Correct (${report.correct})`),
                    h("option", { value: "incorrect", key: "w" }, `Incorrect (${report.incorrect})`),
                    h("option", { value: "skipped", key: "s" }, `Skipped (${report.skipped})`),
                    report.unscored > 0 &&
                      h("option", { value: "unscored", key: "u" }, `Unscored (${report.unscored})`),
                  ],
                ),
              ]),
              h("label", { key: "type" }, [
                "Type",
                h(
                  "select",
                  {
                    value: typeFilter,
                    onChange: (e) => setTypeFilter(e.target.value),
                    key: "sel",
                  },
                  [
                    h("option", { value: "all", key: "all" }, "All types"),
                    h("option", { value: "singleCorrect", key: "mcq" }, "MCQ"),
                    h("option", { value: "numerical", key: "num" }, "Numerical"),
                    report.questionTypes.some((t) => t.type === "multipleCorrect") &&
                      h("option", { value: "multipleCorrect", key: "mc" }, "Multi-correct"),
                  ],
                ),
              ]),
              h("label", { key: "diff" }, [
                "Difficulty",
                h(
                  "select",
                  {
                    value: difficultyFilter,
                    onChange: (e) => setDifficultyFilter(e.target.value),
                    key: "sel",
                  },
                  [
                    h("option", { value: "all", key: "all" }, "All levels"),
                    h("option", { value: "1", key: "1" }, "Easy · L1"),
                    h("option", { value: "2", key: "2" }, "Medium · L2"),
                    h("option", { value: "3", key: "3" }, "Hard · L3"),
                  ],
                ),
              ]),
            ]),

            // Question list
            h(
              "div",
              { className: "question-report-list", key: "qlist" },
              visibleQuestions.length
                ? visibleQuestions.map((question) => {
                    const isOpen = expandedUid === question.uid;
                    const subName =
                      SUBJECT_NAMES[question.subject] || question.subject || "Subject";
                    return h(
                      "article",
                      {
                        id: `analysis-q-${question.index}`,
                        className: `test-question-report ${question.status}`,
                        key: question.uid,
                      },
                      [
                        h(
                          "button",
                          {
                            type: "button",
                            className: "test-question-summary",
                            onClick: () =>
                              setExpandedUid(isOpen ? null : question.uid),
                            "aria-expanded": isOpen,
                            key: "sum",
                          },
                          [
                            h(
                              "span",
                              { className: "question-report-number", key: "num" },
                              `Q${String(question.index).padStart(2, "0")}`,
                            ),
                            h("span", { className: "question-report-main", key: "main" }, [
                              h(
                                "strong",
                                { key: "t" },
                                `${subName} · ${question.chapter || question.topic || `Question ${question.index}`}`,
                              ),
                              h(
                                "small",
                                { key: "sm" },
                                [
                                  typeLabel(question.questionType),
                                  levelLabel(question.difficulty),
                                  question.topic ? question.topic : null,
                                  question.timeSpentSeconds
                                    ? formatDuration(question.timeSpentSeconds)
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · "),
                              ),
                            ]),
                            h(
                              "span",
                              { className: "question-status-pill", key: "st" },
                              statusNames[question.status],
                            ),
                            h(
                              "span",
                              { className: "question-score-pill", key: "sc" },
                              question.status === "correct"
                                ? "+4"
                                : question.status === "incorrect"
                                  ? "−1"
                                  : question.status === "unscored"
                                    ? "—"
                                    : "0",
                            ),
                            h(
                              "span",
                              {
                                className: `analysis-chevron ${isOpen ? "rotated" : ""}`,
                                "aria-hidden": "true",
                                key: "chev",
                              },
                              "▾",
                            ),
                          ],
                        ),

                        isOpen &&
                          h("div", { className: "test-question-detail", key: "det" }, [
                            renderRich(question.question_text, "question-text"),
                            question.question_image &&
                              h("img", {
                                key: "qimg",
                                className: "question-image",
                                src: question.question_image,
                                alt: "Question diagram",
                                loading: "lazy",
                                decoding: "async",
                              }),
                            h("div", { className: "test-answer-comparison", key: "cmp" }, [
                              h(
                                "div",
                                {
                                  className: `answer-comparison-cell ${
                                    question.status === "correct"
                                      ? "correct-answer"
                                      : "your-answer"
                                  }`,
                                  key: "yours",
                                },
                                [
                                  h("span", { key: "l" }, "Your response"),
                                  renderRich(answerDisplay(question, question.userAnswer)),
                                ],
                              ),
                              h(
                                "div",
                                {
                                  className: "answer-comparison-cell correct-answer",
                                  key: "key",
                                },
                                [
                                  h("span", { key: "l" }, "Correct answer"),
                                  renderRich(
                                    answerDisplay(question, question.correct_answer),
                                  ),
                                ],
                              ),
                            ]),
                            question.solution_text &&
                              h("div", { className: "report-solution", key: "sol" }, [
                                h("span", { className: "eyebrow", key: "e" }, "WORKED SOLUTION"),
                                renderRich(question.solution_text),
                                question.solution_image &&
                                  h("img", {
                                    key: "simg",
                                    className: "question-image",
                                    src: question.solution_image,
                                    alt: "Solution diagram",
                                    loading: "lazy",
                                    decoding: "async",
                                  }),
                              ]),
                          ]),
                      ],
                    );
                  })
                : h(
                    "div",
                    { className: "report-empty", key: "empty" },
                    "No questions match the selected filters.",
                  ),
            ),
          ]),
        ]),

      // Bottom Footer Action Bar
      h("footer", { className: "analysis-footer", key: "footer" }, [
        onBack &&
          h(
            "button",
            {
              type: "button",
              className: "btn outline",
              onClick: onBack,
              key: "back",
            },
            `← ${backLabel}`,
          ),
        onReview &&
          h(
            "button",
            {
              type: "button",
              className: "btn primary",
              onClick: () => onReview(test),
              key: "rev",
            },
            "Step-by-step answer review →",
          ),
      ]),
    ]),
  ]);
}
