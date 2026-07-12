#!/usr/bin/env python3
"""HTML → TipTap JSON for the /mcq skill's note import (--html / --oe-url).

Two entry points, both standard-library only:

  • html_to_doc(html)        — generic HTML → TipTap doc (headings, lists,
    tables, blockquote, code, images, bold/italic/code/strike/highlight/link).
    Node set mirrors the web editor's extensions; the Worker re-sanitizes and
    sideloads external images to R2, so this only has to be *reasonable*.
  • parse_oe_conversation(html) — a *public* OpenEvidence /ask/<id> page →
    its Q&A turns. Python port of frontend/src/lib/oe-import.ts (same anchors:
    <article>, [data-testid="ask--query-bar"], [data-answer-end], the
    references container) — keep the two in sync if OE redesigns.
"""
from __future__ import annotations

import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

# --- tiny DOM ---------------------------------------------------------------

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}
RAW_SKIP = {"script", "style", "template"}


class El:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag: str, attrs=None, parent=None):
        self.tag = tag
        self.attrs = dict(attrs or {})
        self.children: list = []  # El | str
        self.parent = parent

    def classes(self) -> list[str]:
        return (self.attrs.get("class") or "").split()


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = El("#root")
        self.stack = [self.root]
        self._raw_skip: str | None = None

    def handle_starttag(self, tag, attrs):
        if self._raw_skip:
            return
        if tag in RAW_SKIP:
            self._raw_skip = tag
            return
        el = El(tag, {k: (v if v is not None else "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(el)
        if tag not in VOID_TAGS:
            self.stack.append(el)

    def handle_startendtag(self, tag, attrs):
        if self._raw_skip or tag in RAW_SKIP:
            return
        el = El(tag, {k: (v if v is not None else "") for k, v in attrs}, self.stack[-1])
        self.stack[-1].children.append(el)

    def handle_endtag(self, tag):
        if self._raw_skip:
            if tag == self._raw_skip:
                self._raw_skip = None
            return
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return
        # Unmatched close tag — ignore (tolerant parsing).

    def handle_data(self, data):
        if self._raw_skip or not data:
            return
        self.stack[-1].children.append(data)


def parse_html(html: str) -> El:
    tb = TreeBuilder()
    tb.feed(html)
    tb.close()
    return tb.root


def walk(el: El):
    """DFS over element nodes, document order (self first)."""
    yield el
    for child in list(el.children):
        if isinstance(child, El):
            yield from walk(child)


def attached(el: El, root: El) -> bool:
    """el is still inside root's subtree (root itself counts)."""
    node = el
    while node is not None:
        if node is root:
            return True
        node = node.parent
    return False


def detach(el: El):
    if el.parent and el in el.parent.children:
        el.parent.children.remove(el)
    el.parent = None


def text_of(el: El) -> str:
    parts: list[str] = []

    def rec(node):
        for c in node.children:
            if isinstance(c, str):
                parts.append(c)
            else:
                rec(c)

    rec(el)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def raw_text_of(el: El) -> str:
    parts: list[str] = []

    def rec(node):
        for c in node.children:
            if isinstance(c, str):
                parts.append(c)
            else:
                rec(c)

    rec(el)
    return "".join(parts)


# --- HTML → TipTap blocks ----------------------------------------------------

BLOCK_TAGS = {
    "address", "article", "aside", "blockquote", "details", "dd", "div", "dl",
    "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
    "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p",
    "pre", "section", "table", "tbody", "tfoot", "thead", "tr", "ul",
}
MARK_BY_TAG = {
    "strong": {"type": "bold"},
    "b": {"type": "bold"},
    "em": {"type": "italic"},
    "i": {"type": "italic"},
    "code": {"type": "code"},
    "s": {"type": "strike"},
    "strike": {"type": "strike"},
    "del": {"type": "strike"},
    "mark": {"type": "highlight"},
}
SKIP_TAGS = {"noscript", "head", "title", "iframe", "object", "video", "audio", "canvas", "svg"}


def html_to_doc(html: str) -> dict:
    root = parse_html(html)
    body = next((el for el in walk(root) if el.tag == "body"), root)
    return {"type": "doc", "content": container_blocks(body)}


def container_blocks(el: El) -> list[dict]:
    """Children of a block container → TipTap blocks (stray inline text is
    gathered into paragraphs; images split out as block nodes)."""
    blocks: list[dict] = []
    inline: list[dict] = []

    def flush():
        nonlocal inline
        para = make_paragraph(inline)
        if para:
            blocks.append(para)
        inline = []

    def emit(items):
        for kind, node in items:
            if kind == "inline":
                inline.append(node)
            else:  # standalone block discovered inside inline flow (an <img>)
                flush()
                blocks.append(node)

    for child in el.children:
        if isinstance(child, str):
            emit(inline_items_text(child, []))
        elif child.tag in SKIP_TAGS:
            continue
        elif child.tag in BLOCK_TAGS or child.tag == "img":
            flush()
            blocks.extend(convert_block(child))
        else:
            emit(inline_items(child, []))
    flush()
    return blocks


def make_paragraph(inline: list[dict]) -> dict | None:
    # Trim leading/trailing whitespace-only text; drop empty result.
    while inline and inline[0].get("type") == "text" and not inline[0]["text"].strip():
        inline.pop(0)
    while inline and inline[-1].get("type") == "text" and not inline[-1]["text"].strip():
        inline.pop()
    if inline and inline[0].get("type") == "text":
        inline[0] = {**inline[0], "text": inline[0]["text"].lstrip()}
    if inline and inline[-1].get("type") == "text":
        inline[-1] = {**inline[-1], "text": inline[-1]["text"].rstrip()}
    inline = [n for n in inline if n.get("type") != "text" or n["text"]]
    if not inline or all(n.get("type") == "hardBreak" for n in inline):
        return None
    return {"type": "paragraph", "content": inline}


def convert_block(el: El) -> list[dict]:
    tag = el.tag
    if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
        level = min(int(tag[1]), 3)
        items = collect_inline(el)
        para = make_paragraph([n for k, n in items if k == "inline"])
        blocks = []
        if para:
            blocks.append({"type": "heading", "attrs": {"level": level}, "content": para["content"]})
        blocks.extend(n for k, n in items if k == "block")
        return blocks
    if tag == "p":
        items = collect_inline(el)
        blocks = []
        para = make_paragraph([n for k, n in items if k == "inline"])
        if para:
            blocks.append(para)
        blocks.extend(n for k, n in items if k == "block")
        return blocks
    if tag == "hr":
        return [{"type": "horizontalRule"}]
    if tag == "pre":
        text = raw_text_of(el).strip("\n")
        return [{
            "type": "codeBlock",
            "content": [{"type": "text", "text": text}] if text else [],
        }]
    if tag == "img":
        img = image_block(el)
        return [img] if img else []
    if tag in ("ul", "ol"):
        items = []
        for child in el.children:
            if isinstance(child, El) and child.tag == "li":
                inner = container_blocks(child)
                if inner:
                    items.append({"type": "listItem", "content": inner})
        if not items:
            return []
        return [{"type": "bulletList" if tag == "ul" else "orderedList", "content": items}]
    if tag == "blockquote":
        inner = container_blocks(el)
        return [{"type": "blockquote", "content": inner}] if inner else []
    if tag == "table":
        rows = []
        for tr in (d for d in walk(el) if d.tag == "tr"):
            cells = []
            for cell in tr.children:
                if isinstance(cell, El) and cell.tag in ("td", "th"):
                    inner = container_blocks(cell) or [{"type": "paragraph", "content": []}]
                    cells.append({
                        "type": "tableHeader" if cell.tag == "th" else "tableCell",
                        "content": inner,
                    })
            if cells:
                rows.append({"type": "tableRow", "content": cells})
        return [{"type": "table", "content": rows}] if rows else []
    # Generic container (div/section/figure/…) — recurse.
    return container_blocks(el)


def collect_inline(el: El) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for child in el.children:
        if isinstance(child, str):
            out.extend(inline_items_text(child, []))
        else:
            out.extend(inline_items(child, []))
    return out


def inline_items_text(text: str, marks: list[dict]) -> list[tuple[str, dict]]:
    collapsed = re.sub(r"\s+", " ", text)
    if not collapsed:
        return []
    node: dict = {"type": "text", "text": collapsed}
    if marks:
        node["marks"] = marks
    return [("inline", node)]


def inline_items(el: El, marks: list[dict]) -> list[tuple[str, dict]]:
    """Flatten an inline element into text/hardBreak items ("inline") and
    embedded images ("block" — TipTap images are block-level)."""
    tag = el.tag
    if tag in SKIP_TAGS:
        return []
    if tag == "br":
        return [("inline", {"type": "hardBreak"})]
    if tag == "img":
        img = image_block(el)
        return [("block", img)] if img else []

    next_marks = marks
    if tag in MARK_BY_TAG:
        m = MARK_BY_TAG[tag]
        if all(x["type"] != m["type"] for x in marks):
            next_marks = marks + [m]
    elif tag == "a":
        href = (el.attrs.get("href") or "").strip()
        if re.match(r"^(https?://|mailto:)", href, re.I) and all(
            x["type"] != "link" for x in marks
        ):
            next_marks = marks + [{"type": "link", "attrs": {"href": href}}]

    out: list[tuple[str, dict]] = []
    for child in el.children:
        if isinstance(child, str):
            out.extend(inline_items_text(child, next_marks))
        elif isinstance(child, El) and (child.tag in BLOCK_TAGS):
            # Block inside inline flow (invalid but tolerated) — flatten text.
            t = text_of(child)
            out.extend(inline_items_text(" " + t + " ", next_marks))
        else:
            out.extend(inline_items(child, next_marks))
    return out


def image_block(el: El) -> dict | None:
    src = (el.attrs.get("src") or "").strip()
    if not src or src.startswith("data:") or src.startswith("blob:"):
        return None
    if "favicons" in src:  # decorative source favicons, not real figures
        return None
    src = resolve_next_image(src)  # unwrap Next.js /_next/image proxy → real URL
    attrs: dict = {"src": src}
    if el.attrs.get("alt"):
        attrs["alt"] = el.attrs["alt"]
    if el.attrs.get("title"):
        attrs["title"] = el.attrs["title"]
    return {"type": "image", "attrs": attrs}


# --- OpenEvidence conversation parsing ---------------------------------------

OE_HOSTS = {"www.openevidence.com", "openevidence.com"}
MAX_OE_HTML = 3 * 1024 * 1024

STATUS_TEXTS = {
    "Analyzed query, searched for evidence",
    "Analyzed query",
    "Searched published medical literature, guidelines, FDA, CDC, and more",
    "Done",
}
CHROME_TAGS = {"button", "svg", "textarea", "input", "form"}
CHROME_CLASSES = {"MuiStepper-root", "MuiStep-root", "MuiStepButton-root", "MuiStepLabel-root"}


def fetch_oe_html(url: str) -> tuple[str, str]:
    """Fetch a public OE conversation page directly. Returns (html, final_url)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in OE_HOSTS:
        sys.exit(f"不是 openevidence.com 的網址:{url}")
    if not parsed.path.startswith("/ask/"):
        sys.exit("OpenEvidence 網址需為 /ask/<id> 公開對話連結")
    req = urllib.request.Request(
        f"https://www.openevidence.com{parsed.path}",
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            ),
            "Accept": "text/html",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            final_url = resp.geturl()
            html = resp.read(MAX_OE_HTML + 1).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        sys.exit(f"OpenEvidence 回應 {e.code} — 確認對話已設為公開(Make public)")
    except urllib.error.URLError as e:
        sys.exit(f"連線 OpenEvidence 失敗:{e.reason}")
    if len(html) > MAX_OE_HTML:
        sys.exit("OpenEvidence 頁面過大,放棄解析")
    if "/ask/" not in urllib.parse.urlparse(final_url).path:
        sys.exit("這個對話不是公開的 — 到 OpenEvidence 按 Share → Make public 後再試")
    return html, final_url


def is_content_img(src: str) -> bool:
    if not src or "favicons" in src:
        return False
    return bool(re.match(r"^https?://", src, re.I)) or src.startswith("/_next/image")


def resolve_next_image(src: str) -> str:
    if not src.startswith("/_next/image"):
        return src
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(src).query)
    return (qs.get("url") or [src])[0]


def is_chrome_el(el: El) -> bool:
    if el.tag in CHROME_TAGS:
        return True
    role = el.attrs.get("role", "")
    if role in ("button", "progressbar"):
        return True
    if CHROME_CLASSES.intersection(el.classes()):
        return True
    testid = el.attrs.get("data-testid", "")
    if testid.endswith("Icon") or testid.startswith("ask--query-bar"):
        return True
    return False


def is_refs_el(el: El) -> bool:
    cls = el.attrs.get("class") or ""
    return "references_container" in cls or "brandable--references" in cls.split()


def strip_chrome(root: El):
    # 1) Unwrap figure buttons/links so their content <img> survives step 2.
    for el in list(walk(root)):
        if el is root or not attached(el, root):
            continue
        if el.tag in ("button", "a") or el.attrs.get("role") == "button":
            imgs = [d for d in walk(el) if d.tag == "img" and is_content_img(d.attrs.get("src", ""))]
            if imgs:
                parent = el.parent
                idx = parent.children.index(el)
                for im in imgs:
                    im.parent = parent
                parent.children[idx:idx + 1] = imgs
                el.parent = None
    # 2) Remove interactive controls and the status stepper.
    for el in list(walk(root)):
        if el is not root and attached(el, root) and is_chrome_el(el):
            detach(el)
    # 3) Remove leftover status text ("Analyzed query…", "Done").
    for el in list(walk(root)):
        if el is root or not attached(el, root) or el.tag not in ("p", "span", "div", "li"):
            continue
        t = text_of(el)
        if t in STATUS_TEXTS or (t.startswith("Analyzed query") and len(t) < 80):
            detach(el)
    # 4) Images: drop favicons, resolve the Next.js proxy → real URL.
    for el in list(walk(root)):
        if el.tag != "img" or not attached(el, root):
            continue
        src = el.attrs.get("src", "")
        if not is_content_img(src):
            detach(el)
        else:
            el.attrs["src"] = resolve_next_image(src)
            el.attrs.pop("srcset", None)


def cut_after(article: El, sentinel: El):
    """Delete everything after `sentinel` (document order) inside `article`."""
    node = sentinel
    while node is not article and node.parent is not None:
        parent = node.parent
        idx = parent.children.index(node)
        del parent.children[idx + 1:]
        node = parent
    detach(sentinel)


def extract_references(refs: El) -> list[dict]:
    detach(refs)  # take it out of the article before any cutting/stripping
    heading = next((d for d in walk(refs) if d.tag in ("h1", "h2", "h3", "h4", "h5", "h6")), None)
    label = "References"
    if heading is not None:
        t = re.sub(r"\s*\d+\s*$", "", text_of(heading)).strip()
        if t:
            label = t
        detach(heading)
    strip_chrome(refs)
    inner = container_blocks(refs)
    if not inner:
        return []
    return [{"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": label}]}] + inner


def drop_follow_ups(root: El):
    for el in list(walk(root)):
        if el is root or not attached(el, root):
            continue
        if text_of(el) == "Follow-Up Questions":
            target = el
            node = el
            while node is not root and node.parent is not None:
                if any("follow-up" in c for c in node.classes()):
                    target = node
                    break
                node = node.parent
            if target is el and el.parent is not root:
                target = el.parent
            detach(target)
            return


def parse_oe_conversation(html: str) -> dict:
    """→ {"title": str, "turns": [{"question": str, "blocks": [...]}]}"""
    root = parse_html(html)

    title_el = next((el for el in walk(root) if el.tag == "title"), None)
    title = re.sub(r"\s*\|\s*OpenEvidence\s*$", "", text_of(title_el) if title_el else "", flags=re.I).strip()

    order = {id(el): i for i, el in enumerate(walk(root))}
    articles = [el for el in walk(root) if el.tag == "article"]
    query_bars = [el for el in walk(root) if el.attrs.get("data-testid") == "ask--query-bar"]

    if not articles:
        if not any("data-answer-end" in el.attrs for el in walk(root)):
            return {"title": title, "turns": []}
        body = next((el for el in walk(root) if el.tag == "body"), root)
        strip_chrome(body)
        blocks = container_blocks(body)
        return {
            "title": title,
            "turns": [{"question": title or "整段內容", "blocks": blocks}] if blocks else [],
        }

    # Questions must be resolved before any tree mutation (uses document order).
    questions = []
    for article in articles:
        best = ""
        for bar in query_bars:
            if order[id(bar)] < order[id(article)]:
                best = text_of(bar)
            else:
                break
        questions.append(best or "（無法擷取問題）")

    turns = []
    for article, question in zip(articles, questions):
        refs = next((d for d in walk(article) if is_refs_el(d)), None)
        refs_blocks = extract_references(refs) if refs is not None else []

        sentinel = next((d for d in walk(article) if "data-answer-end" in d.attrs), None)
        if sentinel is not None:
            cut_after(article, sentinel)
        else:
            drop_follow_ups(article)
        for d in list(walk(article)):
            if d is not article and attached(d, article) and is_refs_el(d):
                detach(d)
        strip_chrome(article)

        blocks = container_blocks(article) + refs_blocks
        if blocks:
            turns.append({"question": question, "blocks": blocks})

    if not title or title.lower() == "openevidence":
        title = turns[0]["question"] if turns else ""

    return {"title": title, "turns": turns}


def oe_conversation_to_doc(convo: dict, source_url: str, turn: int | None = None) -> dict:
    """Assemble picked turn(s) into one TipTap doc: question heading + answer."""
    turns = convo["turns"]
    if turn is not None:
        if turn < 1 or turn > len(turns):
            sys.exit(f"--turn 超出範圍:共 {len(turns)} 輪對話")
        turns = [turns[turn - 1]]
    blocks: list[dict] = []
    for t in turns:
        blocks.append({
            "type": "heading",
            "attrs": {"level": 2},
            "content": [{"type": "text", "text": t["question"]}],
        })
        blocks.extend(t["blocks"])
    blocks.append({
        "type": "paragraph",
        "content": [
            {"type": "text", "text": "來源:"},
            {
                "type": "text",
                "text": "OpenEvidence 對話",
                "marks": [{"type": "link", "attrs": {"href": source_url}}],
            },
        ],
    })
    return {"type": "doc", "content": blocks}
