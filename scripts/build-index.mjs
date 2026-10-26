/**
 * Rebuild data/index.json — the compact chapter catalog the app reads for the
 * practice browser and the overview — from data/manifest.json.
 *
 *   node scripts/build-index.mjs
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "data/manifest.json"), "utf8"));

const SUBJECT_ORDER = ["physics", "chemistry", "math"];
const output = { generatedFrom: "data/manifest.json", exams: {}, totals: {} };

for (const [exam, examData] of Object.entries(manifest.exams || {})) {
  const subjects = [];
  for (const key of SUBJECT_ORDER) {
    const subject = examData.subjects?.[key];
    if (!subject) continue;
    const chapters = Object.entries(subject.chapters || {})
      .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
      .map(([name, chapter]) => ({
        name,
        file: chapter.file,
        count: chapter.count,
        // Topics let the question bank be browsed chapter-wise and topic-wise.
        topics: (chapter.topics || [])
          .map((topic) => ({ name: topic.name, count: topic.count }))
          .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
      }));
    subjects.push({ key, name: subject.name, chapters });
  }
  output.exams[exam] = { subjects };
  output.totals[exam] = subjects.reduce(
    (sum, subject) => sum + subject.chapters.reduce((inner, chapter) => inner + chapter.count, 0),
    0,
  );
  output.topicCounts = output.topicCounts || {};
  output.topicCounts[exam] = subjects.reduce(
    (sum, subject) => sum + subject.chapters.reduce((inner, chapter) => inner + chapter.topics.length, 0),
    0,
  );
}

fs.writeFileSync(path.join(root, "data/index.json"), JSON.stringify(output));
console.log(
  "Wrote data/index.json ·",
  Object.entries(output.totals)
    .map(([exam, total]) => `${exam}: ${total} questions`)
    .join(", "),
);
