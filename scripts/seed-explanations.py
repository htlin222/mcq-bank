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
  - fenced code blocks (``` or ~~~, optional language tag)
  - tables (GitHub-flavored pipe tables, with or without a header row)
  - bullet lists (-, *, +)
  - ordered lists (1., 2., ...)
  - hard breaks (two trailing spaces or trailing backslash)
  - backslash escapes (\\* \\_ \\` \\| ... → the literal character)

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


def discover_years():
    """有 batches/ 的年份就算 —— 不要用硬編碼的清單。

    這裡原本寫死成 range(104, 114)（= 104..113），而 114 年早就存在 ——
    也就是說這支腳本從來沒有 seed 過 114 年的詳解，而且不會報錯，只是那一年
    靜靜地沒有被更新。同樣的清單在 batches-to-csv.ts 也各寫了一份、也漏掉 114。
    """
    root = ROOT / "years"
    if not root.is_dir():
        return []
    out = []
    for d in root.iterdir():
        if d.is_dir() and d.name.isdigit() and (d / "batches").is_dir():
            out.append(int(d.name))
    return sorted(out)


CHUNK_SIZE = 50  # statements per wrangler call

# ---------- Markdown → TipTap converter --------------------------------------

RE_FENCE = re.compile(r"^(```+|~~~+)[ \t]*([^\n`]*)$")
RE_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
RE_IMAGE = re.compile(r'^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$')
RE_BULLET = re.compile(r"^[-*+]\s+(.*)$")
RE_ORDERED = re.compile(r"^(\d+)[.)]\s+(.*)$")

# inline marks — applied in order; non-greedy
RE_INLINE = [
    ("image_inline", re.compile(r'!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)')),
    ("link", re.compile(r'\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)')),
    ("bold", re.compile(r"\*\*([^*]+)\*\*")),
    ("bold2", re.compile(r"__([^_]+)__")),
    ("italic", re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)")),
    ("italic2", re.compile(r"(?<!_)_([^_\n]+)_(?!_)")),
    ("code", re.compile(r"`([^`\n]+)`")),
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

    # Markdown 的跳脫字元:`\*` 要輸出成 `*`,而且**不能**被當成強調語法的起點。
    #
    # ⚠️ 沒有這一段之前,`MRI T2\*` 會壞成 `MRI T2\` —— 反斜線原樣留下,而那個
    # `*` 反倒被粗體解析吃掉。使用者看到的是一個突兀的反斜線,完全對不上原文。
    #
    # 作法是先把 `\x` 換成私用區的佔位字元,躲過底下所有標記的正則,最後再換回
    # 那個字元本身。這樣不必把每一條 inline 正則都改成「要考慮前面有沒有反斜線」。
    placeholders: dict[str, str] = {}

    def _stash(m: "re.Match[str]") -> str:
        ch = m.group(1)
        key = f"\ue000{len(placeholders)}\ue001"
        placeholders[key] = ch
        return key

    text = re.sub(r"\\([\\`*_{}\[\]()#+\-.!|~])", _stash, text)

    def _restore(t: str) -> str:
        for k, v in placeholders.items():
            t = t.replace(k, v)
        return t

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
        if kind == "image_inline":
            alt, src = groups
            # Image as inline sibling (TipTap allows this; renders as block here)
            out.append({"type": "image", "attrs": {"src": src, "alt": alt}})
        elif kind == "link":
            label, url = groups
            out.append(
                text_with_marks(label, [{"type": "link", "attrs": {"href": url}}])
            )
        elif kind in ("bold", "bold2"):
            out.append(text_with_marks(groups[0], [{"type": "bold"}]))
        elif kind in ("italic", "italic2"):
            out.append(text_with_marks(groups[0], [{"type": "italic"}]))
        elif kind == "code":
            out.append(text_with_marks(groups[0], [{"type": "code"}]))
        cursor = e
    if cursor < len(text):
        out.append(text_node(text[cursor:]))
    # 把佔位字元換回真正的字元(所有文字節點都要,含帶標記的)。
    if placeholders:
        for node in out:
            if node.get("type") == "text" and node.get("text"):
                node["text"] = _restore(node["text"])
    # Strip empty text nodes
    return [n for n in out if not (n["type"] == "text" and not n.get("text"))]


def make_paragraph(lines: list[str]) -> dict:
    """Combine lines into a single paragraph with hard-breaks between."""
    content: list[dict] = []
    for i, line in enumerate(lines):
        if i > 0:
            content.append({"type": "hardBreak"})
        content.extend(parse_inline(line))
    return (
        {"type": "paragraph", "content": content} if content else {"type": "paragraph"}
    )


def _split_row(line: str) -> list[str]:
    """`| a | b |` → ['a', 'b']。前後的分隔管線可有可無。"""
    t = line.strip()
    if t.startswith("|"):
        t = t[1:]
    if t.endswith("|"):
        t = t[:-1]
    return [c.strip() for c in t.split("|")]


def _is_delimiter_row(line: str) -> bool:
    """`| --- | :---: |` 這種分隔列。"""
    cells = _split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{1,}:?", c) for c in cells)


def _make_cell(kind: str, text: str) -> dict:
    """儲存格內是 block content —— TipTap 的表格儲存格一定要包一層 paragraph。"""
    return {
        "type": kind,
        "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
        "content": [make_paragraph([text])],
    }


def parse_table(lines: list[str], i: int) -> tuple[dict | None, int]:
    """從 lines[i] 開始試著吃下一個 pipe table。

    回傳 (table_node 或 None, 下一個要處理的索引)。

    ⚠️ **沒有這一段之前,表格會塌成一個段落** —— 所有 `|` 擠在同一行,完全讀不懂。
    原本的轉換器把「連續的非空行」一律當成一個段落,而表格正是連續非空行。
    「不支援就降級成純文字」在這裡不夠:降級之後連換行都沒了。

    節點名稱對齊前端(`lib/staticDoc.ts` 與 tiptap-extensions.ts):
    table › tableRow › tableHeader / tableCell。
    """
    if "|" not in lines[i]:
        return None, i
    rows = []
    j = i
    while j < len(lines) and lines[j].strip() and "|" in lines[j]:
        rows.append(lines[j])
        j += 1
    if len(rows) < 2:
        return None, i

    # 第二列是分隔列 → 第一列是表頭。否則整張表都是一般儲存格。
    has_header = _is_delimiter_row(rows[1])
    if has_header:
        body = [rows[0]] + rows[2:]
    else:
        # 沒有分隔列就不是表格(避免把含 `|` 的普通句子誤判)。
        return None, i

    width = max(len(_split_row(r)) for r in body)
    content = []
    for idx, raw in enumerate(body):
        cells = _split_row(raw)
        cells += [""] * (width - len(cells))  # 補齊,免得列長不一致
        kind = "tableHeader" if (has_header and idx == 0) else "tableCell"
        content.append(
            {"type": "tableRow", "content": [_make_cell(kind, c) for c in cells]}
        )
    if not content:
        return None, i
    return {"type": "table", "content": content}, j


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

        # 圍籬程式區塊(``` 或 ~~~)。
        #
        # ⚠️ 一定要排在**表格之前**:區塊裡畫的常是 ASCII 機轉圖,而那種圖很容易
        # 出現 `|` 當直線。先問表格的話,一張圖會被吃成一個爛掉的表。
        #
        # 沒有這一段時,圍籬只是普通文字 —— 兩行 ``` 會原樣顯示在畫面上,而且圖
        # 用內文的比例字體排,箭頭全部對不齊(103 年 24 篇詳解就是這樣進去的)。
        m = RE_FENCE.match(stripped)
        if m:
            lang = m.group(2).strip() or None
            marker = m.group(1)[0] * 3
            body: list[str] = []
            j = i + 1
            closed = False
            while j < len(lines):
                if (
                    lines[j].strip().startswith(marker)
                    and not lines[j].strip()[3:].strip()
                ):
                    closed = True
                    break
                body.append(lines[j])
                j += 1
            # 沒有收尾的圍籬就不當程式區塊 —— 落回原本的段落處理,寧可原樣顯示
            # 也不要把後面整篇詳解吞進一個灰底方塊裡(同本檔「降級成純文字」的原則)。
            if closed:
                text = "\n".join(body).rstrip()
                node: dict = {"type": "codeBlock", "attrs": {"language": lang}}
                if text:
                    node["content"] = [{"type": "text", "text": text}]
                blocks.append(node)
                i = j + 1
                continue

        # 表格(要排在段落之前 —— 段落會把連續非空行全部吃掉)
        if "|" in stripped:
            tbl, nxt = parse_table(lines, i)
            if tbl is not None:
                blocks.append(tbl)
                i = nxt
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
            blocks.append(
                {"type": "heading", "attrs": {"level": level}, "content": content}
            )
            i += 1
            continue

        # Bullet list
        if RE_BULLET.match(stripped):
            items = []
            while i < len(lines):
                bm = RE_BULLET.match(lines[i].strip())
                if not bm:
                    break
                items.append(
                    {
                        "type": "listItem",
                        "content": [
                            {"type": "paragraph", "content": parse_inline(bm.group(1))}
                        ],
                    }
                )
                i += 1
            blocks.append({"type": "bulletList", "content": items})
            continue

        # Ordered list
        if RE_ORDERED.match(stripped):
            items = []
            while i < len(lines):
                om = RE_ORDERED.match(lines[i].strip())
                if not om:
                    break
                items.append(
                    {
                        "type": "listItem",
                        "content": [
                            {"type": "paragraph", "content": parse_inline(om.group(2))}
                        ],
                    }
                )
                i += 1
            blocks.append({"type": "orderedList", "content": items})
            continue

        # Regular paragraph: gather contiguous non-blank, non-list, non-heading lines
        para_lines = [stripped]
        i += 1
        while i < len(lines):
            nxt = lines[i].strip()
            if not nxt:
                break
            if (
                RE_HEADING.match(nxt)
                or RE_BULLET.match(nxt)
                or RE_ORDERED.match(nxt)
                or RE_IMAGE.match(nxt)
            ):
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
    ap.add_argument(
        "--year",
        type=int,
        default=None,
        help=(
            "只 seed 這一年。⚠️ 加新年份時務必指定 —— 不給的話會用本機 batches "
            "覆寫「所有」年份的 content_json，把別人在網站上編輯過的共筆詳解蓋掉。"
        ),
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip wrangler; just print stats and sample.",
    )
    args = ap.parse_args()

    if not shutil.which("wrangler") and not args.dry_run:
        print("wrangler not on PATH", file=sys.stderr)
        sys.exit(1)

    stmts: list[str] = []
    counts = {"total": 0, "empty": 0, "with_image": 0}
    now_ms = int(time.time() * 1000)

    years = discover_years()
    if args.year is not None:
        if args.year not in years:
            print(
                f"找不到 years/{args.year}/batches/ —— 沒有東西可以 seed",
                file=sys.stderr,
            )
            return 1
        years = [args.year]
    else:
        print(
            f"⚠️  未指定 --year：將覆寫 {years} 全部年份的共筆詳解。",
            file=sys.stderr,
        )
    for year in years:
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
    print(
        f"  - {counts['with_image']} explanations include image nodes", file=sys.stderr
    )

    if args.dry_run:
        print("--- sample (first statement) ---", file=sys.stderr)
        print(stmts[0][:500] + "...", file=sys.stderr)
        return

    flag = "--local" if args.local else "--remote"
    for i in range(0, len(stmts), CHUNK_SIZE):
        chunk = stmts[i : i + CHUNK_SIZE]
        with tempfile.NamedTemporaryFile(
            "w", suffix=".sql", delete=False, encoding="utf-8"
        ) as tf:
            tf.write("\n".join(chunk))
            tmp_path = tf.name
        print(f"  Updating {i + 1}..{i + len(chunk)} ({flag})", file=sys.stderr)
        try:
            subprocess.run(
                ["wrangler", "d1", "execute", D1_DB, flag, "--file", tmp_path],
                check=True,
                stdout=subprocess.DEVNULL,  # suppress big JSON wrangler emits
                stderr=subprocess.PIPE,
            )
        except subprocess.CalledProcessError as e:
            print(
                f"❌ chunk failed: {e.stderr.decode('utf-8', errors='ignore')[:500]}",
                file=sys.stderr,
            )
            raise
        finally:
            os.unlink(tmp_path)

    print(
        f"\n✅ Seeded {counts['total']} explanations into D1 ({flag})", file=sys.stderr
    )


if __name__ == "__main__":
    main()
