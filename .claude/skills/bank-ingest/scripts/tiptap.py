"""
Markdown → TipTap ProseMirror JSON。

為什麼詳解要在本機轉、而不是推 markdown 上去讓 Worker 轉:`explanations`
表存的就是 TipTap JSON(見 CLAUDE.md「Storage: TipTap JSON, not HTML」),
在這裡轉完,Worker 端只要驗結構,不必把一份 markdown parser 塞進 edge runtime。

本檔案是 scripts/seed-explanations.py 裡那份轉換器的複製 —— 因為 .skill 是
獨立發佈的包,沒辦法 import 回 repo。兩邊行為要一致;改動請同步。
"""

from __future__ import annotations

import re

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
