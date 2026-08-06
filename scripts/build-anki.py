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

Usage:
  uv run --with genanki scripts/build-anki.py                 # dedicated 血專 type
  uv run --with genanki scripts/build-anki.py --merge-basic   # merge into local Basic
  uv run --with genanki scripts/build-anki.py --local --years 113 114
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
  font-size: 24px;
  font-weight: 650;
  line-height: 1.3;
}

.field-front--review {
  margin-bottom: 20px;
  padding-bottom: 18px;
  color: var(--ctp-subtext1);
  font-size: 18px;
  font-weight: 550;
  border-bottom: 1px solid var(--ctp-surface0);
}

.field-back {
  color: var(--ctp-text);
  font-size: 12px;
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
  font-size: 24px;
  font-weight: 650;
  line-height: 1.3;
  white-space: pre-wrap;
}

.options {
  margin: 0;
  padding: 0;
  color: var(--ctp-text);
  font-size: 12px;
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
  font-size: 18px;
  font-weight: 600;
}

.field-front--review .options {
  color: var(--ctp-subtext1);
  font-size: 12px;
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
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
}

.expl {
  margin-top: 1em;
  padding-top: 1em;
  color: var(--ctp-text);
  border-top: 1px solid var(--ctp-surface0);
  font-size: 12px;
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
  font-size: 1.05em;
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


def build_year(
    rows: list[dict],
    year: int,
    stage_root: Path,
    model: genanki.Model,
    field_names: list[str],
) -> tuple[Path, int, int]:
    deck = genanki.Deck(DECK_ID_BASE + year, f"血專::{year}年")
    media: dict[str, Path] = {}
    n_expl = 0
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
            expl_html = tiptap_to_html(json.loads(r["expl"]), media).strip()
            if expl_html:
                n_expl += 1
                back += f'<div class="expl">{expl_html}</div>'

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
    return out, len(rows), n_expl


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

    OUT_DIR.mkdir(exist_ok=True)
    db = db_name()
    remote = not args.local
    with tempfile.TemporaryDirectory(prefix="anki-media-") as tmp:
        stage_root = Path(tmp)
        for y in args.years:
            rows = export_year(db, y, remote)
            out, n, n_expl = build_year(rows, y, stage_root, model, field_names)
            print(
                f"{out.name}: {n} 張卡, {n_expl} 有詳解, {out.stat().st_size / 1e6:.1f} MB"
            )
    if missing_images:
        print(f"\n找不到本地檔的圖片 {len(missing_images)} 張:", file=sys.stderr)
        for s in sorted(missing_images):
            print(f"  {s}", file=sys.stderr)


if __name__ == "__main__":
    main()
