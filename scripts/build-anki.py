#!/usr/bin/env python3
"""Export the D1 question bank to per-year Anki decks (血專-xxx年.apkg).

Front = 題幹 + 選項;Back = 正解 + 詳解(TipTap JSON → HTML, images bundled).
Output lands in ./anki-deck/ (gitignored). Intermediate exports go to a temp
dir that is discarded on exit.

Note type modes:
  default        A dedicated note type named "血專" (Front/Back). No name
                 collision with Anki's stock Basic, so it never becomes
                 "Basic+", keeps the scholarly CSS, and imports identically
                 for everyone. Correct for sharing the deck.
  --merge-basic  Match THIS machine's Anki "Basic" note type by its private
                 numeric id AND exact field shape, so import merges into your
                 real Basic (no "+"). Personal-only: the id is per-profile, so
                 a deck built this way still becomes "Basic+" on anyone else's
                 machine. Merged cards render with your Basic's own styling
                 (Anki keeps the destination note type's CSS on merge).

Why apkg can't universally land on everyone's Basic: Anki identifies note
types by a private 64-bit id minted at profile-creation time, not by name.
No distributable file can carry an id that matches every recipient's Basic.

Personal notes (--notes EMAIL):
  Appends that account's FIRST note per question (by sort_order, then slot) to
  the back, wrapped in a collapsed <details> accordion — one for the note, one
  per subsection heading inside it. Anki renders cards in a real browser engine
  on every platform, so <details> works; collapsing matters because these notes
  run 10-70 KB each and would otherwise bury the answer.
  A deck built this way carries private notes — don't share it.

Usage:
  uv run --with genanki scripts/build-anki.py                 # dedicated 血專 type
  uv run --with genanki scripts/build-anki.py --merge-basic   # merge into local Basic
  uv run --with genanki scripts/build-anki.py --local --years 113 114
  uv run --with genanki scripts/build-anki.py --notes me@example.com
"""

import argparse
import html
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from wrangler_json import d1_rows  # noqa: E402


import genanki

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "anki-deck"
ALL_YEARS = list(range(104, 115))  # 104..114

# Dedicated note type id (stable) for the default, shareable build.
DEDICATED_MODEL_ID = 1620251007
DECK_ID_BASE = 1620260700  # + year


def anki_base() -> Path | None:
    for p in (
        Path.home() / "Library/Application Support/Anki2",  # macOS
        Path.home() / ".local/share/Anki2",  # Linux
        Path(os.environ.get("APPDATA", "")) / "Anki2",  # Windows
    ):
        if p.is_dir():
            return p
    return None


def discover_local_basic(profile: str | None) -> dict | None:
    """Read the local Anki 'Basic' note type: its private id + ordered fields.

    Returns {profile, id, fields} or None. Opens the collection read-only and
    registers a stub for Anki's custom 'unicase' collation so queries run.
    """
    base = anki_base()
    if base is None:
        return None
    candidates = [d for d in base.iterdir() if (d / "collection.anki2").is_file()]
    if profile:
        candidates = [d for d in candidates if d.name == profile]
    for d in candidates:
        con = sqlite3.connect(
            f"file:{d / 'collection.anki2'}?mode=ro&immutable=1", uri=True
        )
        con.create_collation("unicase", lambda a, b: (a > b) - (a < b))
        try:
            tables = {
                r[0]
                for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if "notetypes" in tables:  # modern schema (>= 18)
                row = con.execute(
                    "SELECT id FROM notetypes WHERE name='Basic'"
                ).fetchone()
                if not row:
                    continue
                bid = row[0]
                fields = [
                    r[0]
                    for r in con.execute(
                        "SELECT name FROM fields WHERE ntid=? ORDER BY ord", (bid,)
                    )
                ]
            else:  # legacy: models JSON in col table
                models = json.loads(con.execute("SELECT models FROM col").fetchone()[0])
                hit = next(
                    (
                        (int(mid), m)
                        for mid, m in models.items()
                        if m["name"] == "Basic"
                    ),
                    None,
                )
                if not hit:
                    continue
                bid, m = hit
                fields = [f["name"] for f in sorted(m["flds"], key=lambda x: x["ord"])]
            return {"profile": d.name, "id": bid, "fields": fields}
        finally:
            con.close()
    return None


QFMT = """
<main class="anki-note anki-note--front">
  <div class="field field-front">
    {{Front}}
  </div>
</main>
"""

AFMT = """
<main class="anki-note anki-note--back">
  <section class="field field-front field-front--review">
    {{Front}}
  </section>

  <section id="answer" class="field field-back">
    {{Back}}
  </section>
</main>
"""

CSS = """
.card {
  --ctp-rosewater: #dc8a78;
  --ctp-flamingo: #dd7878;
  --ctp-pink: #ea76cb;
  --ctp-mauve: #8839ef;
  --ctp-red: #d20f39;
  --ctp-maroon: #e64553;
  --ctp-peach: #fe640b;
  --ctp-yellow: #df8e1d;
  --ctp-green: #40a02b;
  --ctp-teal: #179299;
  --ctp-sky: #04a5e5;
  --ctp-sapphire: #209fb5;
  --ctp-blue: #1e66f5;
  --ctp-lavender: #7287fd;
  --ctp-text: #4c4f69;
  --ctp-subtext1: #5c5f77;
  --ctp-subtext0: #6c6f85;
  --ctp-surface1: #bcc0cc;
  --ctp-surface0: #ccd0da;
  --ctp-base: #eff1f5;
  --ctp-mantle: #e6e9ef;
  --ctp-crust: #dce0e8;

  margin: 0;
  padding: 0;
  color: var(--ctp-text);
  background: var(--ctp-base);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, "Noto Sans CJK TC", sans-serif;
  /* 全卡唯一的字級。層級一律靠粗細與顏色表達,不靠大小 —— 舊版題幹 24px
     配選項 12px,選項只有題幹的一半,讀起來像註腳。改這一行就能整體縮放。
     例外只有四處,都不是內文:.qid(標籤)、▶ 標記(字符)、code(等寬在同
     px 下看起來較大)、table(欄位要塞進手機寬度)。 */
  font-size: 18px;
  line-height: 1.3;
  text-align: left;
}

.card.nightMode {
  --ctp-rosewater: #f5e0dc;
  --ctp-flamingo: #f2cdcd;
  --ctp-pink: #f5c2e7;
  --ctp-mauve: #cba6f7;
  --ctp-red: #f38ba8;
  --ctp-maroon: #eba0ac;
  --ctp-peach: #fab387;
  --ctp-yellow: #f9e2af;
  --ctp-green: #a6e3a1;
  --ctp-teal: #94e2d5;
  --ctp-sky: #89dceb;
  --ctp-sapphire: #74c7ec;
  --ctp-blue: #89b4fa;
  --ctp-lavender: #b4befe;
  --ctp-text: #cdd6f4;
  --ctp-subtext1: #bac2de;
  --ctp-subtext0: #a6adc8;
  --ctp-surface1: #45475a;
  --ctp-surface0: #313244;
  --ctp-base: #1e1e2e;
  --ctp-mantle: #181825;
  --ctp-crust: #11111b;
}

.anki-note {
  box-sizing: border-box;
  min-height: 100vh;
  width: min(860px, 100%);
  margin: 0 auto;
  padding: clamp(24px, 5vh, 48px) clamp(18px, 4vw, 32px);
}

.field {
  overflow-wrap: anywhere;
  word-break: normal;
}

.field-front {
  color: var(--ctp-text);
  font-weight: 650;
  line-height: 1.3;
}

.field-front--review {
  margin-bottom: 20px;
  padding-bottom: 18px;
  color: var(--ctp-subtext1);
  font-weight: 550;
  border-bottom: 1px solid var(--ctp-surface0);
}

.field-back {
  color: var(--ctp-text);
  font-weight: 500;
  line-height: 1.3;
}

.qid {
  margin: 0 0 1rem;
  color: var(--ctp-subtext0);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0;
}

.stem {
  margin: 0 0 1.05em;
  color: var(--ctp-text);
  font-weight: 650;
  line-height: 1.3;
  white-space: pre-wrap;
}

.options {
  margin: 0;
  padding: 0;
  color: var(--ctp-text);
  font-weight: 450;
  line-height: 1.3;
  list-style: none;
}

.options li {
  position: relative;
  margin: 0;
  padding: 0.78em 0 0.78em 2.35em;
  border-top: 1px solid var(--ctp-surface0);
}

.options li:last-child {
  border-bottom: 1px solid var(--ctp-surface0);
}

.optkey {
  position: absolute;
  top: 0.78em;
  left: 0;
  color: var(--ctp-blue);
  font-weight: 750;
}

.field-front--review .qid {
  margin-bottom: 0.65rem;
}

.field-front--review .stem {
  margin-bottom: 0.8em;
  color: var(--ctp-subtext1);
  font-weight: 600;
}

.field-front--review .options {
  color: var(--ctp-subtext1);
  line-height: 1.3;
}

.field-front--review .options li {
  padding-top: 0.55em;
  padding-bottom: 0.55em;
}

.field-front--review .optkey {
  top: 0.55em;
}

.answer {
  margin: 0 0 1.05em;
  color: var(--ctp-green);
  font-weight: 700;
  line-height: 1.3;
}

.expl {
  color: var(--ctp-text);
  line-height: 1.3;
}

.expl h1,
.expl h2,
.expl h3,
.expl h4,
.expl h5,
.expl h6 {
  margin: 1.25em 0 0.45em;
  color: var(--ctp-mauve);
  font-weight: 750;
  line-height: 1.3;
}

.expl h1:first-child,
.expl h2:first-child,
.expl h3:first-child {
  margin-top: 0;
}

.expl p {
  margin: 0.65em 0;
}

.expl ul,
.expl ol {
  margin: 0.6em 0 0.8em;
  padding-left: 1.35em;
}

.expl li + li,
li + li {
  margin-top: 0.35em;
}

.expl blockquote {
  margin: 0.9em 0;
  padding-left: 0.9em;
  color: var(--ctp-subtext1);
  border-left: 3px solid var(--ctp-surface1);
}

.field-back > :first-child,
.field-front > :first-child {
  margin-top: 0;
}

.field-back > :last-child,
.field-front > :last-child {
  margin-bottom: 0;
}

b,
strong {
  color: var(--ctp-mauve);
  font-weight: 700;
}

i,
em {
  color: var(--ctp-teal);
}

a {
  color: var(--ctp-blue);
  text-decoration-color: var(--ctp-surface1);
  text-underline-offset: 0.18em;
}

code {
  padding: 0.1em 0.3em;
  color: var(--ctp-maroon);
  background: var(--ctp-mantle);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}

pre {
  max-width: 100%;
  margin: 14px 0 0;
  padding: 14px 16px;
  overflow: auto;
  color: var(--ctp-text);
  background: var(--ctp-mantle);
  border-radius: 6px;
}

pre code {
  padding: 0;
  color: inherit;
  background: transparent;
}

hr {
  height: 1px;
  margin: 20px 0;
  background: var(--ctp-surface0);
  border: 0;
}

ul,
ol {
  margin: 0.65em 0 0;
  padding-left: 1.25em;
}

table {
  width: 100%;
  margin-top: 14px;
  border-collapse: collapse;
  font-size: 0.85em;
}

th,
td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--ctp-surface0);
}

th {
  color: var(--ctp-subtext1);
  font-weight: 650;
}

img {
  display: block;
  max-width: 100% !important;
  max-height: 52vh !important;
  width: auto;
  height: auto;
  margin: 18px auto 0;
}

/* 卡背兩個平行摺疊區(共筆詳解 / 個人筆記),預設都收起。正解留在外面。
   單則筆記可達 70 KB、詳解也不短,任一個預設攤開都會把另一個推到看不見。 */
.fold {
  margin-top: 0.9em;
  padding-top: 0.35em;
  border-top: 1px solid var(--ctp-surface0);
  line-height: 1.3;
}

.fold summary,
.nsec summary {
  position: relative;
  /* 手機(尤其 AnkiDroid)的翻牌手勢會跟 summary 搶點擊,給夠大的可點區域。 */
  padding: 0.62em 0.2em 0.62em 1.5em;
  cursor: pointer;
  list-style: none;
  -webkit-tap-highlight-color: transparent;
}

.fold summary::-webkit-details-marker,
.nsec summary::-webkit-details-marker {
  display: none;
}

.fold summary::before,
.nsec summary::before {
  content: "▶";
  position: absolute;
  top: 0.62em;
  left: 0.15em;
  color: var(--ctp-surface1);
  font-size: 0.8em;
}

.fold[open] > summary::before,
.nsec[open] > summary::before {
  content: "▼";
}

.fold > summary {
  font-weight: 750;
}

/* 兩區用不同顏色,收起來時一眼分得出哪個是誰的話。 */
.fold-expl > summary {
  color: var(--ctp-mauve);
}

.fold-note > summary {
  color: var(--ctp-peach);
}

.fold-body {
  padding-left: 0.2em;
}

.nsec {
  margin: 0.2em 0;
  border-left: 1px solid var(--ctp-surface0);
}

.nsec > summary {
  color: var(--ctp-subtext1);
  font-weight: 700;
}

/* 每深一層縮排一次、顏色再淡一階,才看得出自己在第幾層。 */
.nsec-d0 > summary {
  color: var(--ctp-blue);
}

.nsec-d1 > summary {
  color: var(--ctp-teal);
}

.nsec-d2 > summary {
  color: var(--ctp-subtext0);
  font-weight: 650;
}

.nsec-body {
  padding: 0 0 0.6em 1.5em;
}

.fold-body > :first-child,
.nsec-body > :first-child {
  margin-top: 0;
}

.fold-body p,
.nsec-body p {
  margin: 0.55em 0;
}

.fold-body ul,
.fold-body ol,
.nsec-body ul,
.nsec-body ol {
  margin: 0.5em 0 0.7em;
  padding-left: 1.35em;
}

.fold mark {
  padding: 0 0.15em;
  color: var(--ctp-text);
  background: var(--ctp-surface0);
  border-radius: 3px;
}

.replay-button svg {
  width: 24px;
  height: 24px;
}

.replay-button svg circle {
  fill: var(--ctp-mantle);
}

.replay-button svg path {
  stroke: var(--ctp-blue);
  fill: var(--ctp-blue);
}

.mobile .anki-note {
  width: 100%;
  padding: 22px 16px;
}


@media (max-width: 520px) {
  .anki-note {
    width: 100%;
    padding: 22px 16px;
  }

}
"""


def make_model(basic: dict | None) -> tuple[genanki.Model, list[str]]:
    """Return (model, ordered field names).

    basic is None  -> dedicated "血專" note type (shareable, keeps CSS).
    basic is a dict -> replicate the local Basic's id + fields so import
                       merges into it (no "Basic+"). On merge Anki keeps the
                       destination note type's own CSS, so ours is ignored.
    """
    if basic is None:
        fields = ["Front", "Back"]
        model = genanki.Model(
            DEDICATED_MODEL_ID,
            "血專",
            fields=[{"name": f} for f in fields],
            templates=[{"name": "Card 1", "qfmt": QFMT, "afmt": AFMT}],
            css=CSS,
        )
        return model, fields
    fields = basic["fields"]
    model = genanki.Model(
        basic["id"],
        "Basic",
        fields=[{"name": f} for f in fields],
        templates=[{"name": "Card 1", "qfmt": QFMT, "afmt": AFMT}],
        css=CSS,
    )
    return model, fields


def field_values(field_names: list[str], front: str, back: str) -> list[str]:
    """Place Front/Back into the model's fields by name; leave extras (e.g.
    a customised Basic's 'Disease' field) empty. Positional fallback if the
    note type lacks literal Front/Back names."""
    if "Front" in field_names or "Back" in field_names:
        return [
            front if n == "Front" else back if n == "Back" else "" for n in field_names
        ]
    vals = [""] * len(field_names)
    if field_names:
        vals[0] = front
    if len(field_names) > 1:
        vals[1] = back
    return vals


def db_name() -> str:
    cfg = tomllib.load(open(REPO / "config.toml", "rb"))
    return cfg["project"]["d1_db"]


def export_year(db: str, year: int, remote: bool) -> list[dict]:
    """Query one year from D1 via wrangler, return the result rows."""
    scope = "--remote" if remote else "--local"
    sql = (
        'SELECT q.id, q.year, q.number, q."group", q.stem, q.options_json, '
        "q.answer, COALESCE(e.content_json,'') expl "
        "FROM questions q LEFT JOIN explanations e ON e.question_id=q.id "
        f"WHERE q.year={year} ORDER BY q.number"
    )
    proc = subprocess.run(
        [
            "pnpm",
            "exec",
            "wrangler",
            "d1",
            "execute",
            db,
            scope,
            "--json",
            "--command",
            sql,
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"wrangler export failed for {year}:\n{proc.stderr}")
    # wrangler prints a banner before the JSON; slice from the first '['/'{'
    return d1_rows(proc.stdout, f"build-anki 讀 {year} 年題目")


def media_name(src: str) -> str:
    return "hema-" + src.removeprefix("/img/").replace("/", "-")


def local_path(src: str) -> Path | None:
    m = re.match(r"^/img/years/(\d+)/([^/]+)$", src)
    if m:
        p = REPO / "years" / m.group(1) / "images" / m.group(2)
        if p.exists():
            return p
    p = REPO / src.removeprefix("/img/")
    return p if p.exists() else None


missing_images: set[str] = set()


def tiptap_to_html(node, media: dict[str, Path]) -> str:
    t = node.get("type")
    children = "".join(tiptap_to_html(c, media) for c in node.get("content", []))
    if t == "doc":
        return children
    if t == "text":
        text = html.escape(node.get("text", ""))
        for mark in node.get("marks", []):
            mt = mark.get("type")
            if mt == "bold":
                text = f"<b>{text}</b>"
            elif mt == "italic":
                text = f"<i>{text}</i>"
            elif mt == "code":
                text = f"<code>{text}</code>"
            elif mt == "highlight":
                text = f"<mark>{text}</mark>"
            elif mt == "link":
                href = html.escape(mark.get("attrs", {}).get("href", ""), quote=True)
                text = f'<a href="{href}">{text}</a>'
        return text
    if t == "paragraph":
        return f"<p>{children}</p>"
    if t == "heading":
        lvl = min(int(node.get("attrs", {}).get("level", 3)), 6)
        return f"<h{lvl}>{children}</h{lvl}>"
    if t in ("bulletList", "bullet_list"):
        return f"<ul>{children}</ul>"
    if t in ("orderedList", "ordered_list"):
        return f"<ol>{children}</ol>"
    if t in ("listItem", "list_item"):
        return f"<li>{children}</li>"
    if t == "blockquote":
        return f"<blockquote>{children}</blockquote>"
    if t == "hardBreak":
        return "<br>"
    if t == "horizontalRule":
        return "<hr>"
    if t == "table":
        return f"<table>{children}</table>"
    if t == "tableRow":
        return f"<tr>{children}</tr>"
    if t in ("tableHeader", "tableCell"):
        # Falling through to `children` would flatten every row into one run of
        # text — silently, and only in notes (exactly 1 explanation has a table).
        tag = "th" if t == "tableHeader" else "td"
        attrs = node.get("attrs") or {}
        span = "".join(
            f' {a}="{int(attrs[a])}"'
            for a in ("colspan", "rowspan")
            if isinstance(attrs.get(a), int) and attrs[a] > 1
        )
        return f"<{tag}{span}>{children}</{tag}>"
    if t == "image":
        src = node.get("attrs", {}).get("src", "")
        if src.startswith(("http://", "https://")):
            return f'<img src="{html.escape(src, quote=True)}">'
        p = local_path(src)
        if p is None:
            missing_images.add(src)
            return ""
        name = media_name(src)
        media[name] = p
        return f'<img src="{html.escape(name, quote=True)}">'
    return children


def node_text(node) -> str:
    if node.get("type") == "text":
        return node.get("text", "")
    return "".join(node_text(c) for c in node.get("content", []))


def heading_level(node) -> int | None:
    if node.get("type") != "heading":
        return None
    return int(node.get("attrs", {}).get("level", 3))


def sections_to_html(nodes: list, media: dict[str, Path], depth: int = 0) -> str:
    """Turn a flat node list into nested <details>, one nesting level per
    heading level actually used. Most notes are H2 大節 + H3 小節, so the card
    ends up three layers deep: 筆記 → 大節 → 小節.

    Splits on the SHALLOWEST heading level present rather than on a fixed
    level — notes vary (some start at H1, one starts at H3), and keying off
    absolute levels would flatten those into a single layer.
    """
    levels = [lv for lv in (heading_level(n) for n in nodes) if lv is not None]
    if not levels:
        return "".join(tiptap_to_html(n, media) for n in nodes).strip()

    top = min(levels)
    groups: list[tuple[dict | None, list]] = [(None, [])]
    for n in nodes:
        if heading_level(n) == top:
            groups.append((n, []))
        else:
            groups[-1][1].append(n)

    parts = []
    for head, body_nodes in groups:
        # Content before the first top-level heading are siblings of the
        # sections that follow, not children — some notes put their body at H3
        # and only 參考文獻 at H2, and depth+1 here drew the body one level
        # deeper than the reference list that comes after it.
        inner = sections_to_html(body_nodes, media, depth + (head is not None))
        if head is None:
            if inner:
                parts.append(inner)
            continue
        label = html.escape(node_text(head).strip())
        parts.append(
            f'<details class="nsec nsec-d{min(depth, 2)}">'
            f"<summary>{label}</summary>"
            f'<div class="nsec-body">{inner}</div></details>'
        )
    return "".join(parts)


def details_block(
    title: str, nodes: list, media: dict[str, Path], cls: str, body_cls: str = ""
) -> str:
    """One collapsed top-level section on the back of a card."""
    body = sections_to_html(nodes, media)
    if not body:
        return ""
    body_class = f"fold-body {body_cls}".strip()
    return (
        f'<details class="fold {cls}"><summary>{html.escape(title)}</summary>'
        f'<div class="{body_class}">{body}</div></details>'
    )


def note_to_html(doc, media: dict[str, Path]) -> str:
    """Render one personal note as a collapsed <details> accordion.

    Outer summary = the note's own leading heading (in practice
    「高頻考點:…」). Inside, every heading at the shallowest level found gets
    its own nested <details>, so a 70 KB note opens one section at a time
    instead of unrolling the whole thing under the answer.
    """
    content = list(doc.get("content", []))
    title = "個人筆記"
    if content and content[0].get("type") == "heading":
        title = node_text(content[0]).strip() or title
        content = content[1:]
    elif content and content[0].get("type") == "paragraph":
        # 39/100 of 114's notes open with a bare paragraph that IS the title
        # (「素材綜整：…」). Only treat it as one when it's short and real
        # headings follow — otherwise a note's opening sentence would vanish
        # from the body into the summary.
        head = node_text(content[0]).strip()
        if 0 < len(head) <= 80 and any(heading_level(n) for n in content[1:]):
            title = head
            content = content[1:]

    return details_block(title, content, media, "fold-note")


def export_notes(db: str, year: int, remote: bool, email: str) -> dict[str, str]:
    """First personal note per question for one year: {question_id: content_json}."""
    scope = "--remote" if remote else "--local"
    esc = email.replace("'", "''")
    sql = (
        "WITH firsts AS ("
        "SELECT p.question_id qid, p.content_json cj, "
        "ROW_NUMBER() OVER (PARTITION BY p.question_id "
        "ORDER BY p.sort_order, p.slot) rn "
        "FROM personal_notes p JOIN questions q ON q.id=p.question_id "
        f"WHERE p.user_email='{esc}' AND q.year={year}) "
        "SELECT qid, cj FROM firsts WHERE rn=1"
    )
    proc = subprocess.run(
        ["pnpm", "exec", "wrangler", "d1", "execute", db, scope, "--json", "--command", sql],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"wrangler note export failed for {year}:\n{proc.stderr}")
    rows = d1_rows(proc.stdout, f"build-anki 讀 {year} 年個人筆記")
    return {r["qid"]: r["cj"] for r in rows}


def build_year(
    rows: list[dict],
    year: int,
    stage_root: Path,
    model: genanki.Model,
    field_names: list[str],
    notes: dict[str, str] | None = None,
) -> tuple[Path, int, int, int]:
    deck = genanki.Deck(DECK_ID_BASE + year, f"血專::{year}年")
    media: dict[str, Path] = {}
    n_expl = 0
    n_note = 0
    for r in rows:
        stem = html.escape(r["stem"]).strip()
        opts = json.loads(r["options_json"])
        opts_html = "".join(
            f'<li><span class="optkey">{html.escape(o["key"])}.</span>'
            f"{html.escape(o['text'])}</li>"
            for o in opts
        )
        front = (
            f'<div class="qid">{html.escape(r["id"])}</div>'
            f'<div class="stem">{stem}</div><ul class="options">{opts_html}</ul>'
        )

        ans = r["answer"]
        ans_text = next((o["text"] for o in opts if o["key"] == ans), "")
        back = f'<div class="answer">正解:{html.escape(ans)}. {html.escape(ans_text)}</div>'
        if r["expl"]:
            expl_doc = json.loads(r["expl"])
            expl_html = details_block(
                "共筆詳解", expl_doc.get("content", []), media, "fold-expl", "expl"
            )
            if expl_html:
                n_expl += 1
                back += expl_html

        note_json = (notes or {}).get(r["id"])
        if note_json:
            note_html = note_to_html(json.loads(note_json), media)
            if note_html:
                n_note += 1
                back += note_html

        deck.add_note(
            genanki.Note(
                model=model,
                fields=field_values(field_names, front, back),
                guid=genanki.guid_for("hema-2026", r["id"]),
            )
        )

    out = OUT_DIR / f"血專-{year}年.apkg"
    pkg = genanki.Package(deck)
    # genanki keys media by basename; our refs use flattened names, so stage copies.
    staged = stage_root / str(year)
    staged.mkdir(parents=True, exist_ok=True)
    staged_files = []
    for name, p in media.items():
        dst = staged / name
        dst.write_bytes(p.read_bytes())
        staged_files.append(str(dst))
    pkg.media_files = staged_files
    pkg.write_to_file(str(out))
    return out, len(rows), n_expl, n_note


def main():
    ap = argparse.ArgumentParser(description="Build per-year 血專 Anki decks from D1")
    ap.add_argument(
        "--local", action="store_true", help="query local D1 instead of --remote"
    )
    ap.add_argument(
        "--years", nargs="+", type=int, default=ALL_YEARS, help="years (民國) to build"
    )
    ap.add_argument(
        "--merge-basic",
        action="store_true",
        help="match local Anki 'Basic' (id+fields) so import merges into it (personal-only)",
    )
    ap.add_argument(
        "--profile",
        help="Anki profile name (default: auto-detect the one with a 'Basic' type)",
    )
    ap.add_argument(
        "--notes",
        metavar="EMAIL",
        help="附上該帳號每題排序第一則個人筆記(摺疊)。牌組會含私人內容,不要分享",
    )
    args = ap.parse_args()

    basic = None
    if args.merge_basic:
        basic = discover_local_basic(args.profile)
        if basic is None:
            sys.exit(
                "--merge-basic: no local Anki 'Basic' note type found "
                "(checked ~/Library/Application Support/Anki2). Run without the flag for the 血專 type."
            )
        model, field_names = make_model(basic)
        print(
            f"note type: 併入本機 Basic  profile={basic['profile']}  "
            f"id={basic['id']}  fields={field_names}"
        )
        print(
            "  提醒:匯入前請先刪除舊的 'Basic+' note type,否則同 guid 的卡會卡在 Basic+。"
        )
    else:
        model, field_names = make_model(None)
        print("note type: 血專(專屬型別,可分享、不產生 Basic+)")

    if args.notes:
        print(f"個人筆記: 每題排序第一則, 帳號 {args.notes}")
        print("  ⚠ 產出的牌組含私人筆記,請勿分享。")

    OUT_DIR.mkdir(exist_ok=True)
    db = db_name()
    remote = not args.local
    with tempfile.TemporaryDirectory(prefix="anki-media-") as tmp:
        stage_root = Path(tmp)
        for y in args.years:
            rows = export_year(db, y, remote)
            notes = export_notes(db, y, remote, args.notes) if args.notes else None
            out, n, n_expl, n_note = build_year(
                rows, y, stage_root, model, field_names, notes
            )
            extra = f", {n_note} 有筆記" if args.notes else ""
            print(
                f"{out.name}: {n} 張卡, {n_expl} 有詳解{extra}, "
                f"{out.stat().st_size / 1e6:.1f} MB"
            )
    if missing_images:
        print(f"\n找不到本地檔的圖片 {len(missing_images)} 張:", file=sys.stderr)
        for s in sorted(missing_images):
            print(f"  {s}", file=sys.stderr)


if __name__ == "__main__":
    main()
