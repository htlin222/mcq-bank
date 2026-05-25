#!/usr/bin/env python3
"""
Restore years/<n>/batches/*.json from the remote D1 explanations table.

Used to recover from the failed 2026-05-23 Haiku-polish incident: the polish
agents corrupted source markdown (and deleted year 104 batches entirely).
The remote D1 still holds the pre-polish content_json (TipTap), so we
reverse-convert TipTap → markdown and rebuild the batches.

For years 105–113 the batch files still exist; we only swap `explanation_md`.
For year 104 the batch files were deleted; we synthesize them from D1
(losing only `tags`, `confidence`, `oe_consulted` — not stored in D1).

Usage:
  python3 scripts/restore-from-d1.py            # restore all years
  python3 scripts/restore-from-d1.py --dry-run  # show what would change
"""

import argparse
import json
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
with (ROOT / "config.toml").open("rb") as _f:
    _CFG = tomllib.load(_f)
D1_DB = _CFG["project"]["d1_db"]
YEARS = list(range(104, 114))

# ---------- TipTap → Markdown converter --------------------------------------

def inline_to_md(node: dict) -> str:
    """Render a single inline TipTap node (text/hardBreak/image) to markdown."""
    t = node.get("type")
    if t == "text":
        text = node.get("text", "")
        marks = node.get("marks") or []
        # Apply marks in stable order so output round-trips deterministically.
        for m in marks:
            mt = m.get("type")
            if mt == "code":
                text = f"`{text}`"
            elif mt == "bold":
                text = f"**{text}**"
            elif mt == "italic":
                text = f"*{text}*"
            elif mt == "link":
                href = (m.get("attrs") or {}).get("href", "")
                text = f"[{text}]({href})"
        return text
    if t == "hardBreak":
        return "\n"
    if t == "image":
        attrs = node.get("attrs") or {}
        alt = attrs.get("alt") or ""
        src = attrs.get("src") or ""
        return f"![{alt}]({src})"
    return ""


def block_to_md(node: dict, list_kind: str | None = None, idx: int = 0) -> str:
    """Render a single block-level TipTap node to markdown."""
    t = node.get("type")
    children = node.get("content") or []

    if t == "paragraph":
        return "".join(inline_to_md(c) for c in children)

    if t == "heading":
        level = (node.get("attrs") or {}).get("level", 1)
        hashes = "#" * max(1, min(level, 6))
        inner = "".join(inline_to_md(c) for c in children)
        return f"{hashes} {inner}"

    if t == "image":
        return inline_to_md(node)

    if t == "bulletList":
        return "\n".join(block_to_md(c, "ul", i) for i, c in enumerate(children))

    if t == "orderedList":
        return "\n".join(block_to_md(c, "ol", i) for i, c in enumerate(children))

    if t == "listItem":
        # listItem holds paragraph(s); render the paragraph text only.
        inner_lines = []
        for c in children:
            inner_lines.append(block_to_md(c))
        inner = "\n".join(inner_lines)
        marker = "- " if list_kind == "ul" else f"{idx + 1}. "
        return marker + inner

    # Unknown block type — best-effort recurse through children.
    return "\n".join(block_to_md(c) for c in children)


def tiptap_to_md(doc: dict | str) -> str:
    """Convert a TipTap doc (JSON or string) to markdown."""
    if isinstance(doc, str):
        try:
            doc = json.loads(doc)
        except json.JSONDecodeError:
            return ""
    if not isinstance(doc, dict):
        return ""
    blocks = doc.get("content") or []
    rendered: list[str] = []
    for blk in blocks:
        text = block_to_md(blk)
        if text:
            rendered.append(text)
    # Block separator: blank line between paragraphs / headings / images.
    return "\n\n".join(rendered)


# ---------- D1 dump ----------------------------------------------------------

def wrangler_query(sql: str) -> list[dict]:
    """Run a SELECT against remote D1, return list of row dicts."""
    cmd = ["wrangler", "d1", "execute", D1_DB, "--remote", "--json", "--command", sql]
    out = subprocess.run(cmd, check=True, capture_output=True)
    payload = json.loads(out.stdout.decode("utf-8"))
    return payload[0]["results"]


def fetch_all_questions() -> dict[str, dict]:
    """Return {question_id: {stem, options, answer, content_json, year, number}}."""
    rows = wrangler_query(
        "SELECT q.id, q.year, q.number, q.stem, q.options_json, q.answer, "
        "e.content_json "
        "FROM questions q "
        "LEFT JOIN explanations e ON q.id = e.question_id "
        "WHERE q.year BETWEEN 104 AND 113"
    )
    return {r["id"]: r for r in rows}


# ---------- Rebuild batch files ---------------------------------------------

def group_for_number(num: int) -> str:
    return "內科" if num <= 70 else "共同"


def batch_index(num: int) -> int:
    return ((num - 1) // 10) + 1


def restore_year(year: int, db: dict[str, dict], dry_run: bool) -> dict:
    """Restore one year. Returns stats dict."""
    batches_dir = ROOT / "years" / str(year) / "batches"
    stats = {"year": year, "files": 0, "questions": 0, "year_104_rebuild": False, "kept_fields": 0}

    rebuild_from_scratch = not any(batches_dir.glob("batch-*.json"))
    stats["year_104_rebuild"] = rebuild_from_scratch
    if rebuild_from_scratch:
        batches_dir.mkdir(parents=True, exist_ok=True)

    # Gather this year's questions from D1.
    year_rows = [r for r in db.values() if r["year"] == year]
    year_rows.sort(key=lambda r: r["number"])

    # Group by batch (1..10)
    by_batch: dict[int, list[dict]] = {}
    for row in year_rows:
        bi = batch_index(row["number"])
        by_batch.setdefault(bi, []).append(row)

    for bi in sorted(by_batch.keys()):
        batch_path = batches_dir / f"batch-{bi:02d}.json"
        rows_for_batch = by_batch[bi]

        # Try to load existing batch file. If invalid JSON (corrupted by polish
        # agent) OR missing (year 104), fall back to D1 reconstruction.
        existing = None
        if not rebuild_from_scratch and batch_path.exists():
            try:
                existing = json.loads(batch_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                print(
                    f"  WARN: year {year} batch-{bi:02d} has corrupt JSON ({e}); "
                    f"rebuilding from D1 — tags/confidence/oe_consulted will be defaults.",
                    file=sys.stderr,
                )
                existing = None

        if existing is None:
            # Synthesize from D1 (year 104, or any batch with corrupt JSON).
            out_questions = []
            for r in rows_for_batch:
                expl_md = tiptap_to_md(r.get("content_json") or "")
                options = json.loads(r["options_json"])
                out_questions.append({
                    "number": r["number"],
                    "group": group_for_number(r["number"]),
                    "stem": r["stem"],
                    "options": options,
                    "answer": r["answer"],
                    "tags": [],
                    "explanation_md": expl_md,
                    "confidence": None,
                    "oe_consulted": False,
                })
        else:
            # Years 105-113 healthy file: swap only explanation_md.
            existing_by_num = {q["number"]: q for q in existing}
            for r in rows_for_batch:
                num = r["number"]
                if num not in existing_by_num:
                    print(f"  WARN: year {year} batch-{bi:02d} missing q#{num} in existing file", file=sys.stderr)
                    continue
                existing_by_num[num]["explanation_md"] = tiptap_to_md(r.get("content_json") or "")
                stats["kept_fields"] += 1
            out_questions = [existing_by_num[n] for n in sorted(existing_by_num)]

        stats["questions"] += len(out_questions)
        stats["files"] += 1

        if not dry_run:
            batch_path.write_text(
                json.dumps(out_questions, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        # Sanity: re-parse to confirm valid JSON.
        if not dry_run:
            json.loads(batch_path.read_text(encoding="utf-8"))

    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print("Fetching all questions+explanations from remote D1…", file=sys.stderr)
    db = fetch_all_questions()
    print(f"  Got {len(db)} questions from D1", file=sys.stderr)

    for year in YEARS:
        stats = restore_year(year, db, args.dry_run)
        marker = " [REBUILT FROM SCRATCH]" if stats["year_104_rebuild"] else ""
        print(
            f"  year {year}: {stats['files']} files, {stats['questions']} questions{marker}",
            file=sys.stderr,
        )

    print("\n✅ Restore complete." if not args.dry_run else "\n(dry run — no files written)", file=sys.stderr)


if __name__ == "__main__":
    main()
