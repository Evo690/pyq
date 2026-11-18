#!/usr/bin/env python3
"""Build the lightweight exact-paper catalog from jee-main-papers-by-year.zip.

The year files in the source ZIP are large (they contain HTML questions,
MathJax SVG, answer keys, and worked solutions). The app only needs a small
metadata catalog to populate its selectors; it reads the selected year's
full JSON from the ZIP on demand.

Usage:
    python3 tools/generate_exact_paper_catalog.py
    python3 tools/generate_exact_paper_catalog.py --update-data-zip
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ZIP = ROOT / "jee-main-papers-by-year.zip"
CATALOG_JSON = ROOT / "data" / "exact-papers.json"
CATALOG_MODULE = ROOT / "assets" / "exact-paper-catalog.mjs"
DATA_ZIP = ROOT / "data.zip"
ARCHIVE_NAME = SOURCE_ZIP.name
EXAM = "JEE_Main"

SUBJECT_KEYS = {
    "physics": "physics",
    "chemistry": "chemistry",
    "mathematics": "math",
    "maths": "math",
    "math": "math",
}


def normalize_subject(value: str) -> str:
    return SUBJECT_KEYS.get(str(value or "").strip().lower(), "general")


def normalize_question_type(question: dict) -> str:
    if question.get("type") == "integer":
        return "numerical"
    tags = " ".join(str(tag) for tag in question.get("tags") or []).lower()
    if (
        question.get("type") == "mcqm"
        or len(question.get("correctOptions") or []) > 1
        or "more than one correct" in tags
        or "dropped" in tags
        or "bonus" in tags
    ):
        return "multipleCorrect"
    return "singleCorrect"


def session_label(title: str) -> tuple[str, int]:
    match = re.search(
        r"\)\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+)\s+(Morning|Evening)\s+(Shift|Slot)\s*$",
        title,
    )
    if match:
        date_part, session, kind = match.groups()
        return f"{date_part} · {session} {kind}", 1 if session == "Morning" else 2

    match = re.search(r"\)\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+)\s*$", title)
    if match:
        return f"{match.group(1)} · Online", 0

    if "(Offline)" in title:
        return "Offline paper", 0
    if title.startswith("AIEEE"):
        return "AIEEE paper", 0
    return title, 0


def iso_date(exam_date_label: str, exam_date: str) -> str:
    try:
        parsed = datetime.strptime(exam_date_label, "%a, %b %d, %Y %I:%M %p")
        return (
            parsed.replace(tzinfo=timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    except ValueError:
        return f"{exam_date}T00:00:00.000Z"


def build_catalog() -> dict:
    with ZipFile(SOURCE_ZIP) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        archive_files = []
        papers = []

        for file_info in manifest["files"]:
            name = file_info["name"]
            year_data = json.loads(archive.read(name))
            defs_present = bool(year_data.get("mathjaxDefs"))
            for source_paper in year_data.get("papers", []):
                questions = source_paper.get("questions") or []
                subject_counts = Counter(
                    normalize_subject(question.get("subject")) for question in questions
                )
                type_counts = Counter(
                    normalize_question_type(question) for question in questions
                )
                title = str(source_paper.get("title") or "").strip()
                slug = str(source_paper.get("slug") or "").strip()
                label, session_order = session_label(title)
                exam_date = str(source_paper.get("examDate") or "")
                exam_date_label = str(source_paper.get("examDateLabel") or "")

                papers.append(
                    {
                        "id": slug or title,
                        "slug": slug,
                        "title": title,
                        "year": int(source_paper.get("year") or 0),
                        "label": label,
                        "date": iso_date(exam_date_label, exam_date),
                        "examDate": exam_date,
                        "examDateLabel": exam_date_label,
                        "sessionOrder": session_order,
                        "questionCount": len(questions),
                        "answeredCount": int(source_paper.get("answeredCount") or 0),
                        "solutionCount": sum(
                            bool(question.get("solutionHtml")) for question in questions
                        ),
                        "subjects": {
                            "physics": subject_counts.get("physics", 0),
                            "chemistry": subject_counts.get("chemistry", 0),
                            "math": subject_counts.get("math", 0),
                        },
                        "types": {
                            "singleCorrect": type_counts.get("singleCorrect", 0),
                            "multipleCorrect": type_counts.get("multipleCorrect", 0),
                            "numerical": type_counts.get("numerical", 0),
                        },
                        "archiveFile": name,
                        "mathjaxDefs": defs_present,
                        "source": ARCHIVE_NAME,
                        "sourceUrl": str(source_paper.get("sourceUrl") or ""),
                        "status": str(source_paper.get("status") or ""),
                        "sources": [],
                    }
                )

            archive_files.append(
                {
                    "name": name,
                    "papers": int(file_info.get("papers") or 0),
                    "questions": int(file_info.get("questions") or 0),
                }
            )

    papers.sort(
        key=lambda paper: (
            -int(paper["year"]),
            paper["date"],
            paper["sessionOrder"],
            paper["label"],
        )
    )
    return {
        "generatedAt": manifest.get("generatedAt"),
        "source": ARCHIVE_NAME,
        "scope": "JEE Main exact papers, 2012–2026",
        "archiveFiles": archive_files,
        "exams": {
            EXAM: {
                "chapters": [],
                "papers": papers,
            }
        },
    }


def write_catalog(catalog: dict) -> None:
    CATALOG_JSON.parent.mkdir(parents=True, exist_ok=True)
    CATALOG_MODULE.parent.mkdir(parents=True, exist_ok=True)
    compact = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    CATALOG_JSON.write_text(compact + "\n", encoding="utf-8")
    CATALOG_MODULE.write_text(
        "// Generated by tools/generate_exact_paper_catalog.py. Do not edit by hand.\n"
        f"export const EXACT_PAPER_CATALOG = {json.dumps(catalog, ensure_ascii=False, indent=2)};\n",
        encoding="utf-8",
    )


def update_data_zip() -> None:
    """Keep the checked-in data.zip fallback in sync with the loose catalog."""
    target = "data/exact-papers.json"
    payload = CATALOG_JSON.read_bytes()
    temporary = DATA_ZIP.with_suffix(".zip.tmp")
    with ZipFile(DATA_ZIP, "r") as source, ZipFile(temporary, "w") as output:
        for info in source.infolist():
            if info.filename == target:
                continue
            output.writestr(info, source.read(info.filename))
        info = ZipInfo(target, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        output.writestr(info, payload)
    temporary.replace(DATA_ZIP)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--update-data-zip",
        action="store_true",
        help="also refresh data/exact-papers.json inside data.zip",
    )
    args = parser.parse_args()

    catalog = build_catalog()
    write_catalog(catalog)
    if args.update_data_zip:
        update_data_zip()

    paper_count = len(catalog["exams"][EXAM]["papers"])
    question_count = sum(
        paper["questionCount"] for paper in catalog["exams"][EXAM]["papers"]
    )
    print(
        f"Wrote {paper_count} papers / {question_count} questions to "
        f"{CATALOG_JSON.relative_to(ROOT)} and {CATALOG_MODULE.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
