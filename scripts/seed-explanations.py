#!/usr/bin/env python3
"""
Convert each question's `explanation_md` from years/<n>/batches/*.json into
TipTap ProseMirror JSON and bulk-update explanations.content_json in D1.

Usage:
  python3 scripts/seed-explanations.py --local
  python3 scripts/seed-explanations.py --remote

Supported markdown subset (matches the frontend tiptap extension set):
  - paragraphs (split by blank lines)
  - headings (# / ## / ###)
  - bold (**text** or __text__) and italic (*text* or _text_)
  - inline code (`code`)
  - links ([text](url))
  - images (![alt](url))  — block-level only, must be on their own line
  - bullet lists (-, *, +)
  - ordered lists (1., 2., ...)
  - hard breaks (two trailing spaces or trailing backslash)

Unsupported markdown is degraded to plain text rather than dropped.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
with (ROOT / "config.toml").open("rb") as _f:
    _CFG = tomllib.load(_f)
D1_DB = _CFG["project"]["d1_db"]
IMPORT_AUTHOR = f"import@{_CFG['project']['slug']}"
YEARS = list(range(104, 114))
CHUNK_SIZE = 50  # statements per wrangler call

# ---------- Markdown → TipTap converter --------------------------------------

RE_HEADING   = re.compile(r'^(#{1,3})\s+(.*)$')
RE_IMAGE     = re.compile(r'^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$')
RE_BULLET    = re.compile(r'^[-*+]\s+(.*)$')
RE_ORDERED   = re.compile(r'^(\d+)[.)]\s+(.*)$')

# inline marks — applied in order; non-greedy
RE_INLINE = [
    ('image_inline', re.compile(r'!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)')),
    ('link',         re.compile(r'\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)')),
    ('bold',         re.compile(r'\*\*([^*]+)\*\*')),
    ('bold2',        re.compile(r'__([^_]+)__')),
    ('italic',       re.compile(r'(?<!\*)\*([^*\n]+)\*(?!\*)')),
    ('italic2',      re.compile(r'(?<!_)_([^_\n]+)_(?!_)')),
    ('code',         re.compile(r'`([^`\n]+)`')),
]

def text_node(text: str) -> dict:
    return {"type": "text", "text": text}

def text_with_marks(text: str, marks: list[dict]) -> dict:
    return {"type": "text", "text": text, "marks": marks}

def parse_inline(text: str) -> list[dict]:
    """
    Turn a single line of markdown into a list of TipTap inline nodes.
    Inline images become {type:'image', attrs} sibling nodes inside the paragraph.
    """
    if not text:
        return []

    # Find ALL inline matches with their positions, choose non-overlapping greedy.
    matches: list[tuple[int, int, str, tuple]] = []
    for kind, rx in RE_INLINE:
        for m in rx.finditer(text):
            matches.append((m.start(), m.end(), kind, m.groups()))
    matches.sort(key=lambda x: (x[0], -x[1]))
    # Greedy non-overlap
    selected = []
    end = -1
    for m in matches:
        if m[0] >= end:
            selected.append(m)
            end = m[1]

    out: list[dict] = []
    cursor = 0
    for start, e, kind, groups in selected:
        if start > cursor:
            out.append(text_node(text[cursor:start]))
        if kind == 'image_inline':
            alt, src = groups
            # Image as inline sibling (TipTap allows this; renders as block here)
            out.append({"type": "image", "attrs": {"src": src, "alt": alt}})
        elif kind == 'link':
            label, url = groups
            out.append(text_with_marks(label, [{"type": "link", "attrs": {"href": url}}]))
        elif kind in ('bold', 'bold2'):
            out.append(text_with_marks(groups[0], [{"type": "bold"}]))
        elif kind in ('italic', 'italic2'):
            out.append(text_with_marks(groups[0], [{"type": "italic"}]))
        elif kind == 'code':
            out.append(text_with_marks(groups[0], [{"type": "code"}]))
        cursor = e
    if cursor < len(text):
        out.append(text_node(text[cursor:]))
    # Strip empty text nodes
    return [n for n in out if not (n["type"] == "text" and not n.get("text"))]

def make_paragraph(lines: list[str]) -> dict:
    """Combine lines into a single paragraph with hard-breaks between."""
    content: list[dict] = []
    for i, line in enumerate(lines):
        if i > 0:
            content.append({"type": "hardBreak"})
        content.extend(parse_inline(line))
    return {"type": "paragraph", "content": content} if content else {"type": "paragraph"}

def md_to_tiptap(md: str) -> dict:
    """Parse a markdown blob into a TipTap doc."""
    md = (md or "").strip()
    if not md:
        return {"type": "doc", "content": []}

    # Normalize line endings and split into raw lines.
    lines = md.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[dict] = []

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Blank line: paragraph separator
        if not stripped:
            i += 1
            continue

        # Block-level image (its own line)
        m = RE_IMAGE.match(stripped)
        if m:
            alt, src = m.group(1), m.group(2)
            blocks.append({"type": "image", "attrs": {"src": src, "alt": alt}})
            i += 1
            continue

        # Heading
        m = RE_HEADING.match(stripped)
        if m:
            level = len(m.group(1))
            content = parse_inline(m.group(2).strip())
            blocks.append({"type": "heading", "attrs": {"level": level}, "content": content})
            i += 1
            continue

        # Bullet list
        if RE_BULLET.match(stripped):
            items = []
            while i < len(lines):
                bm = RE_BULLET.match(lines[i].strip())
                if not bm: break
                items.append({"type": "listItem", "content": [
                    {"type": "paragraph", "content": parse_inline(bm.group(1))}
                ]})
                i += 1
            blocks.append({"type": "bulletList", "content": items})
            continue

        # Ordered list
        if RE_ORDERED.match(stripped):
            items = []
            while i < len(lines):
                om = RE_ORDERED.match(lines[i].strip())
                if not om: break
                items.append({"type": "listItem", "content": [
                    {"type": "paragraph", "content": parse_inline(om.group(2))}
                ]})
                i += 1
            blocks.append({"type": "orderedList", "content": items})
            continue

        # Regular paragraph: gather contiguous non-blank, non-list, non-heading lines
        para_lines = [stripped]
        i += 1
        while i < len(lines):
            nxt = lines[i].strip()
            if not nxt: break
            if RE_HEADING.match(nxt) or RE_BULLET.match(nxt) or RE_ORDERED.match(nxt) or RE_IMAGE.match(nxt):
                break
            para_lines.append(nxt)
            i += 1
        blocks.append(make_paragraph(para_lines))

    return {"type": "doc", "content": blocks}


# ---------- D1 update --------------------------------------------------------

def sql_escape(s: str) -> str:
    return s.replace("'", "''")

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--local", action="store_true")
    g.add_argument("--remote", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="Skip wrangler; just print stats and sample.")
    args = ap.parse_args()

    if not shutil.which("wrangler") and not args.dry_run:
        print("wrangler not on PATH", file=sys.stderr)
        sys.exit(1)

    stmts: list[str] = []
    counts = {"total": 0, "empty": 0, "with_image": 0}
    now_ms = int(time.time() * 1000)

    for year in YEARS:
        batch_dir = ROOT / "years" / str(year) / "batches"
        for f in sorted(batch_dir.glob("batch-*.json")):
            for q in json.loads(f.read_text(encoding="utf-8")):
                qid = f"{year}-{q['number']:03d}"
                doc = md_to_tiptap(q.get("explanation_md", ""))
                json_str = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
                counts["total"] += 1
                if not doc["content"]:
                    counts["empty"] += 1
                if "image" in json_str:
                    counts["with_image"] += 1
                # UPSERT-style: explanations row may already exist (created empty by the question importer).
                stmts.append(
                    f"INSERT INTO explanations (question_id, content_json, version, updated_by, updated_at) "
                    f"VALUES ('{qid}', '{sql_escape(json_str)}', 1, '{IMPORT_AUTHOR}', {now_ms}) "
                    f"ON CONFLICT(question_id) DO UPDATE SET "
                    f"content_json = excluded.content_json, "
                    f"version = explanations.version + 1, "
                    f"updated_by = '{IMPORT_AUTHOR}', "
                    f"updated_at = {now_ms};"
                )

    print(f"Built {counts['total']} UPDATE statements", file=sys.stderr)
    print(f"  - {counts['empty']} questions have empty explanation_md", file=sys.stderr)
    print(f"  - {counts['with_image']} explanations include image nodes", file=sys.stderr)

    if args.dry_run:
        print("--- sample (first statement) ---", file=sys.stderr)
        print(stmts[0][:500] + "...", file=sys.stderr)
        return

    flag = "--local" if args.local else "--remote"
    for i in range(0, len(stmts), CHUNK_SIZE):
        chunk = stmts[i:i + CHUNK_SIZE]
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as tf:
            tf.write("\n".join(chunk))
            tmp_path = tf.name
        print(f"  Updating {i+1}..{i+len(chunk)} ({flag})", file=sys.stderr)
        try:
            subprocess.run(
                ["wrangler", "d1", "execute", D1_DB, flag, "--file", tmp_path],
                check=True,
                stdout=subprocess.DEVNULL,  # suppress big JSON wrangler emits
                stderr=subprocess.PIPE,
            )
        except subprocess.CalledProcessError as e:
            print(f"❌ chunk failed: {e.stderr.decode('utf-8', errors='ignore')[:500]}", file=sys.stderr)
            raise
        finally:
            os.unlink(tmp_path)

    print(f"\n✅ Seeded {counts['total']} explanations into D1 ({flag})", file=sys.stderr)

if __name__ == "__main__":
    main()
