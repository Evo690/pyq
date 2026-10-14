import { dataJson, requestExamFullscreen } from "./experience.mjs";

const SUBJECT_ORDER = { physics: 0, chemistry: 1, math: 2 };

/** Return a normalized, stable catalog for the paper selector. */
export function normalizePaperCatalog(source = []) {
  const papers = Array.isArray(source) ? source : source?.papers || [];
  const sourceCatalog = Array.isArray(source?.chapters) ? source.chapters : [];
  return (Array.isArray(papers) ? papers : [])
    .filter(
      (paper) => paper && typeof paper.title === "string" && paper.title.trim(),
    )
    .map((paper) => {
      const title = paper.title.trim();
      const yearMatch = title.match(/(?:19|20)\d{2}/);
      const labelMatch = title.match(/\d{4}\s*\(([^)]+)\)/);
      const questionCount = Number(paper.questionCount ?? paper.count);

      return {
        ...paper,
        id: String(paper.id || title),
        title,
        year: String(paper.year || yearMatch?.[0] || ""),
        label: String(paper.label || labelMatch?.[1] || "Full paper"),
        questionCount: Number.isFinite(questionCount) ? questionCount : 0,
        sources: Array.isArray(paper.sources)
          ? paper.sources
              .map((sourceIndex) =>
                Number.isInteger(sourceIndex)
                  ? sourceCatalog[sourceIndex]
                  : sourceIndex,
              )
              .filter(Boolean)
          : [],
      };
    })
    .filter((paper) => paper.year && paper.questionCount > 0);
}

/** Available years, newest first, for an exam's exact-paper selector. */
export function availablePaperYears(papers = []) {
  return [
    ...new Set(normalizePaperCatalog(papers).map((paper) => paper.year)),
  ].sort((left, right) => Number(right) - Number(left));
}

/** Papers for one year, ordered by exam date and then by their display label. */
export function papersForYear(papers = [], year) {
  return normalizePaperCatalog(papers)
    .filter((paper) => paper.year === String(year))
    .sort(
      (left, right) =>
        String(left.date || "").localeCompare(String(right.date || "")) ||
        left.label.localeCompare(right.label),
    );
}

/**
 * Build a complete paper from its source chapter files. The dataset has no
 * original question-number field, so questions are kept in a stable subject,
 * chapter, and source-file order rather than shuffled or sampled.
 */
export function buildExactPaperQuestions(groups, exam, paper) {
  if (!paper?.title) return [];

  const seen = new Set();
  const orderedGroups = [...(Array.isArray(groups) ? groups : [])].sort(
    (left, right) => {
      const leftSubject = SUBJECT_ORDER[left.subject] ?? 99;
      const rightSubject = SUBJECT_ORDER[right.subject] ?? 99;
      return (
        leftSubject - rightSubject ||
        String(left.chapter?.name || left.chapter || "").localeCompare(
          String(right.chapter?.name || right.chapter || ""),
        )
      );
    },
  );
  const selected = [];

  for (const group of orderedGroups) {
    const chapterName =
      typeof group.chapter === "string" ? group.chapter : group.chapter?.name;
    for (const question of group.questions || []) {
      if (question?.paper_year_title !== paper.title) continue;
      const questionId = question.question_id || question.uid;
      if (!questionId) continue;

      const uid = question.uid || `${exam}:${questionId}`;
      if (seen.has(uid)) continue;
      seen.add(uid);
      selected.push({
        ...question,
        uid,
        exam,
        subject: group.subject,
        chapter: chapterName || question.chapter || "",
      });
    }
  }

  return selected;
}

/** Load only the chapter files that contain questions for the selected paper. */
export async function loadExactPaperQuestions(exam, paper) {
  const sources = [...(paper?.sources || [])].sort((left, right) => {
    const leftSubject = SUBJECT_ORDER[left.subject] ?? 99;
    const rightSubject = SUBJECT_ORDER[right.subject] ?? 99;
    return (
      leftSubject - rightSubject ||
      String(left.chapter || "").localeCompare(String(right.chapter || ""))
    );
  });

  const groups = await Promise.all(
    sources.map(async (source) => ({
      subject: source.subject,
      chapter: source.chapter,
      questions: await dataJson(`${exam}/${source.file}`),
    })),
  );

  return buildExactPaperQuestions(groups, exam, paper);
}

function PaperSelect({ React, label, value, disabled, onChange, children }) {
  const h = React.createElement;
  return h("label", { className: "exact-paper-field" }, [
    h("span", { key: "label" }, label),
    h(
      "select",
      {
        key: "select",
        value,
        disabled,
        onChange: (event) => onChange(event.target.value),
      },
      children,
    ),
  ]);
}

/**
 * Test Studio's exact-paper picker. React is passed by the built application so
 * this source module can stay independent of the bundled React runtime.
 */
export function ExactPaperPicker({ React, exam, start }) {
  const h = React.createElement;
  const [catalog, setCatalog] = React.useState([]);
  const [catalogExam, setCatalogExam] = React.useState("");
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [catalogError, setCatalogError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const [year, setYear] = React.useState("");
  const [paperId, setPaperId] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let current = true;
    setCatalogLoading(true);
    setCatalogError("");
    setCatalogExam("");
    dataJson("papers.json")
      .then((index) => {
        if (!current) return;
        const papers = normalizePaperCatalog(index?.exams?.[exam]);
        const years = availablePaperYears(papers);
        const firstYear = years[0] || "";
        setCatalog(papers);
        setCatalogExam(exam);
        setYear(firstYear);
        setPaperId(papersForYear(papers, firstYear)[0]?.id || "");
      })
      .catch((loadError) => {
        if (current)
          setCatalogError(
            loadError?.message || "The paper list could not be loaded.",
          );
      })
      .finally(() => {
        if (current) setCatalogLoading(false);
      });
    return () => {
      current = false;
    };
  }, [exam, retry]);

  const papers = catalogExam === exam ? catalog : [];
  const years = availablePaperYears(papers);
  const yearPapers = papersForYear(papers, year);
  const selected =
    yearPapers.find((paper) => paper.id === paperId) || yearPapers[0] || null;
  const examName = exam === "JEE_Main" ? "JEE Main" : "JEE Advanced";

  const beginMock = async () => {
    if (!selected || starting) return;
    setStarting(true);
    setError("");
    requestExamFullscreen();
    try {
      const questions = await loadExactPaperQuestions(exam, selected);
      if (!questions.length) {
        throw new Error(
          "No questions were found for this paper in the question bank.",
        );
      }
      if (questions.length !== selected.questionCount) {
        throw new Error(
          `The source returned ${questions.length} of ${selected.questionCount} questions. The mock was not started so you won't get a partial paper.`,
        );
      }
      start(questions, selected.title, "test", 180, true);
    } catch (loadError) {
      setError(
        loadError?.message || "The selected paper could not be prepared.",
      );
    } finally {
      setStarting(false);
    }
  };

  const yearOptions = years.map((availableYear) =>
    h("option", { key: availableYear, value: availableYear }, availableYear),
  );
  const paperOptions = yearPapers.map((paper) =>
    h(
      "option",
      { key: paper.id, value: paper.id },
      `${paper.label} · ${paper.questionCount} questions`,
    ),
  );
  const count = selected?.questionCount || 0;
  const subjectSummary = selected
    ? [
        ["physics", "Physics"],
        ["chemistry", "Chemistry"],
        ["math", "Mathematics"],
      ]
        .filter(([key]) => Number(selected.subjects?.[key]) > 0)
        .map(([key, label]) => `${label} ${selected.subjects[key]}`)
        .join(" · ")
    : "";

  return h(
    "section",
    { className: "exact-paper-card", "aria-labelledby": "exact-paper-heading" },
    [
      h("div", { className: "exact-paper-copy", key: "copy" }, [
        h("div", { className: "exact-paper-eyebrow", key: "eyebrow" }, [
          h(
            "span",
            {
              className: "exact-paper-mark",
              "aria-hidden": "true",
              key: "mark",
            },
            "✦",
          ),
          " ORIGINAL PAPER · TIMED MOCK",
        ]),
        h("h2", { id: "exact-paper-heading", key: "heading" }, [
          "The exact PYQ paper",
          h("span", { className: "exact-paper-period", key: "period" }, "."),
        ]),
        h(
          "p",
          { className: "exact-paper-description", key: "description" },
          "Choose a year and shift to sit a complete paper from the question bank. Every matching question is included; source files omit original question numbers, so items are grouped by subject and chapter.",
        ),
        h("div", { className: "exact-paper-facts", key: "facts" }, [
          h(
            "span",
            { key: "count" },
            count ? `${count} original questions` : "Full original paper",
          ),
          h(
            "span",
            {
              className: "exact-paper-fact-divider",
              "aria-hidden": "true",
              key: "dot",
            },
            "·",
          ),
          h("span", { key: "duration" }, "3-hour timer"),
        ]),
        h(
          "p",
          { className: "exact-paper-note", key: "note" },
          exam === "JEE_Advanced"
            ? "Choose Paper 1 or Paper 2. This practice mock uses +4 / −1 scoring; multi-correct responses are included but left unscored when source keys are incomplete."
            : "Three-hour timed mock using the practice +4 / −1 scoring scheme.",
        ),
      ]),
      h("div", { className: "exact-paper-setup", key: "setup" }, [
        h("div", { className: "exact-paper-selectors", key: "selectors" }, [
          h(PaperSelect, {
            React,
            key: "year-select",
            label: "Year",
            value: year,
            disabled: catalogLoading || !years.length,
            onChange: (nextYear) => {
              setYear(nextYear);
              setPaperId(papersForYear(papers, nextYear)[0]?.id || "");
              setError("");
            },
            children: yearOptions,
          }),
          h(PaperSelect, {
            React,
            key: "paper-select",
            label: exam === "JEE_Main" ? "Shift / session" : "Paper",
            value: selected?.id || "",
            disabled: catalogLoading || !yearPapers.length,
            onChange: (nextPaper) => {
              setPaperId(nextPaper);
              setError("");
            },
            children: paperOptions,
          }),
        ]),
        selected &&
          h("div", { className: "exact-paper-selection", key: "selection" }, [
            h("strong", { key: "title" }, selected.title),
            subjectSummary && h("span", { key: "subjects" }, subjectSummary),
          ]),
        catalogError
          ? h(
              "div",
              {
                className: "exact-paper-error",
                role: "alert",
                key: "catalog-error",
              },
              [
                h("span", { key: "message" }, catalogError),
                h(
                  "button",
                  {
                    type: "button",
                    className: "exact-paper-retry",
                    onClick: () => setRetry((value) => value + 1),
                    key: "retry",
                  },
                  "Try again",
                ),
              ],
            )
          : error &&
            h(
              "p",
              { className: "exact-paper-error", role: "alert", key: "error" },
              error,
            ),
        h(
          "button",
          {
            type: "button",
            className: "btn primary exact-paper-start",
            disabled:
              catalogLoading ||
              starting ||
              !selected ||
              typeof start !== "function",
            onClick: beginMock,
            key: "start",
          },
          starting
            ? "Preparing the original paper…"
            : catalogLoading
              ? "Loading available papers…"
              : "Start exact mock",
        ),
        h(
          "span",
          { className: "exact-paper-start-hint", key: "hint" },
          catalogLoading
            ? "Getting the paper list ready"
            : selected
              ? `${examName} · ${selected.year} · ${selected.label}`
              : "No papers available for this exam",
        ),
      ]),
    ],
  );
}
