"""
官方考題 PDF → 題目物件。

## 為什麼不是 pdftotext

因為答案是**白色的字**。

對 114 年官方 PDF 做 span 分析會看到答案欄(頁面最右側)每題都有一個
`color=#ffffff` 的單字元 span:

    'B' color=#ffffff x=551.3 font=BookAntiqua   ← 白字白底,肉眼看不到
    'B' color=#d90000 x=551.3 font=Helvetica     ← 「答案顯示版」才有的紅字

也就是說**官方發的「題目版」PDF 本身就含有答案**,只是印出來看不見。這代表
不需要拿到答案顯示版就能建題庫;但也代表純文字管線(pdftotext)會把兩層都吐
出來,答案在文字裡出現兩次卻分不清哪個是哪個。要判讀就得看 span 的顏色,
所以這裡用 PyMuPDF 而不是 pdftotext。

## 信心值

每題都帶一個 0..1 的 confidence,規則見 detect_answer()。低信心與抓不到答案
的題目會被標記,推上去之後由人在網頁上逐題確認 —— 這個解析器不必做到完美,
它只需要誠實回報自己有多確定。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

import fitz

WHITE = 0xFFFFFF

# 題目開頭:「12.」「12．」。放寬到 3 位數以防未來題數變多。
RE_QSTART = re.compile(r"^\s*(\d{1,3})\s*[.．]\s*")
# 選項:「(A) …」「A. …」「(Ａ)…」
RE_OPTION = re.compile(r"^\s*[（(]?\s*([A-E])\s*[）).、．]\s*(.*)$")
RE_ANSWER_INLINE = re.compile(r"(?:答案|Ans|答)\s*[:：]?\s*([A-E])\b", re.IGNORECASE)
# 答案欄的字母有兩種寫法:單獨的「B」,以及連鎖題用的「(C)」。114 年內科卷
# 兩種都有 —— 只認單字元會漏掉整組連鎖題(實測漏 14/70)。
RE_ANSWER_CELL = re.compile(r"^[（(]?\s*([A-E])\s*[）)]?$")


def answer_letter(text: str) -> str | None:
    """
    答案欄的一格 → 字母,認不得就回 None。

    先做 NFKC:114 年內科卷至少有一題的答案是全形「Ｄ」(U+FF24),不正規化就
    整題漏掉。行層級的 _clean() 有做這件事,但答案是從原始 span 讀的,所以這裡
    要自己做一次。
    """
    m = RE_ANSWER_CELL.match(unicodedata.normalize("NFKC", text).strip())
    return m.group(1) if m else None

# 表頭與版面雜訊 —— Word/PDF 在每頁重複這些,不濾掉會混進題幹。
NOISE = {
    "題號", "題目", "答案", "題 目", "答 案", "單選題", "請選出一個最適切的答案",
    "·答", "·案", "題", "號", "答", "案",
}


@dataclass
class Span:
    text: str
    x0: float
    y0: float
    color: int
    page: int


@dataclass
class Line:
    text: str
    x0: float
    y0: float
    page: int
    spans: list[Span] = field(default_factory=list)

    @property
    def key(self) -> tuple[int, float]:
        """文件順序:先頁碼再 y。"""
        return (self.page, self.y0)


@dataclass
class ParsedQuestion:
    number: int
    stem: str
    options: dict[str, str]
    answer: str
    confidence: float
    explanation_md: str = ""


def _clean(s: str) -> str:
    """全形空白正規化 + 去掉零寬字元。"""
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("​", "").replace("\xa0", " ")
    return re.sub(r"[ \t]+", " ", s).strip()


def load_lines(path: str) -> list[Line]:
    """把整份 PDF 攤平成文件順序的行。"""
    doc = fitz.open(path)
    lines: list[Line] = []
    for pno, page in enumerate(doc):
        for block in page.get_text("dict")["blocks"]:
            for ln in block.get("lines", []):
                spans = [
                    Span(
                        text=s["text"],
                        x0=s["bbox"][0],
                        y0=s["bbox"][1],
                        color=s.get("color", 0),
                        page=pno,
                    )
                    for s in ln["spans"]
                    if s["text"].strip()
                ]
                if not spans:
                    continue
                text = _clean("".join(s.text for s in spans))
                if not text or text in NOISE:
                    continue
                lines.append(
                    Line(text=text, x0=min(s.x0 for s in spans), y0=ln["bbox"][1], page=pno, spans=spans)
                )
    doc.close()
    lines.sort(key=lambda l: l.key)
    return lines


def find_answer_column(lines: list[Line]) -> tuple[float, float] | None:
    """
    推導答案欄的 x 範圍,不寫死座標。

    做法:蒐集所有「整格就是一個 A–E 字母」的 span(含連鎖題的 `(C)` 寫法),
    依 x 分桶(10pt),再從桶裡挑出答案欄。

    不能只用「數量最多」—— 選項標記 `(A) …` 也是同一個形狀,而且每題有五個,
    數量是答案欄的五倍,直接壓過去(實測會選到左邊界 x≈68 的選項欄)。

    主判準改用**白字**:答案欄是白字白底藏起來的,選項標記永遠是可見的黑字。
    這個訊號乾淨且正是我們要利用的現象本身。沒有白字的 PDF(例如自製的詳解檔)
    退回「最右邊、數量夠多的那一欄」,因為答案欄在這種版型固定貼在右緣。

    回傳 None 表示這份 PDF 沒有答案欄,呼叫端退回文字規則。
    """
    buckets: dict[int, list[Span]] = {}
    for ln in lines:
        for s in ln.spans:
            if answer_letter(s.text):
                buckets.setdefault(int(s.x0 // 10), []).append(s)
    if not buckets:
        return None

    white = {b: sum(1 for s in spans if s.color == WHITE) for b, spans in buckets.items()}
    if max(white.values(), default=0) >= 5:
        best = max(white, key=lambda b: white[b])
    else:
        plausible = [b for b, spans in buckets.items() if len(spans) >= 10]
        if not plausible:
            return None
        best = max(plausible)  # 最右欄

    xs = [s.x0 for s in buckets[best]]
    return (min(xs) - 2, max(xs) + 12)


def split_questions(lines: list[Line], answer_col: tuple[float, float] | None) -> dict[int, list[Line]]:
    """
    切出每題的行區塊。

    題號必須出現在頁面左側 —— 否則選項裡的「(1) 2.5 mg」之類的東西會被誤判成
    新題目。左側門檻用所有題號候選的中位數推導,一樣不寫死。
    """
    candidates = [(ln, int(m.group(1))) for ln in lines if (m := RE_QSTART.match(ln.text))]
    if not candidates:
        return {}

    xs = sorted(ln.x0 for ln, _ in candidates)
    left_limit = xs[len(xs) // 2] + 15

    starts: list[tuple[int, Line]] = []
    expected = 1
    for ln, num in candidates:
        if ln.x0 > left_limit:
            continue
        # 題號必須遞增。重複或倒退的多半是頁尾/引文裡的數字。
        if num < expected:
            continue
        starts.append((num, ln))
        expected = num + 1

    blocks: dict[int, list[Line]] = {}
    for i, (num, start) in enumerate(starts):
        end_key = starts[i + 1][1].key if i + 1 < len(starts) else (10**9, 0.0)
        block = [ln for ln in lines if start.key <= ln.key < end_key]
        if answer_col:
            # 答案欄的字不屬於題幹,先抽掉(答案偵測另外從原始 spans 拿)。
            block = [ln for ln in block if not (answer_col[0] <= ln.x0 <= answer_col[1])]
        blocks[num] = block
    return blocks


def detect_answer(
    raw_block: list[Line],
    answer_col: tuple[float, float] | None,
) -> tuple[str, float]:
    """
    偵測鏈,逐級降信心,命中即停。回傳 ("", 0.0) 表示放棄,交給人判。
    """
    col_spans: list[tuple[Span, str]] = []
    if answer_col:
        for ln in raw_block:
            for s in ln.spans:
                letter = answer_letter(s.text)
                if letter and answer_col[0] <= s.x0 <= answer_col[1]:
                    col_spans.append((s, letter))

    # 1) 答案欄的白字 —— 官方 PDF 藏答案的地方
    for s, letter in col_spans:
        if s.color == WHITE:
            return letter, 1.0

    # 2) 答案欄的可見字(答案顯示版的紅字,或一般的黑字)
    if col_spans:
        return col_spans[0][1], 1.0

    # 3) 內文寫明「答案:X」
    for ln in raw_block:
        m = RE_ANSWER_INLINE.search(ln.text)
        if m:
            return m.group(1).upper(), 0.9

    return "", 0.0


def parse_block(num: int, block: list[Line], raw_block: list[Line], answer_col) -> ParsedQuestion:
    """把一題的行區塊拆成題幹 / 選項 / 詳解。"""
    stem_lines: list[str] = []
    options: dict[str, str] = {}
    explanation_lines: list[str] = []
    current: str | None = None
    in_explanation = False

    for i, ln in enumerate(block):
        text = ln.text
        if i == 0:
            text = RE_QSTART.sub("", text, count=1)
            if not text:
                continue

        if re.match(r"^\s*(詳解|解析|解答)\s*[:：]?", text):
            in_explanation = True
            rest = re.sub(r"^\s*(詳解|解析|解答)\s*[:：]?\s*", "", text)
            if rest:
                explanation_lines.append(rest)
            current = None
            continue

        if in_explanation:
            explanation_lines.append(text)
            continue

        m = RE_OPTION.match(text)
        if m:
            current = m.group(1)
            options[current] = m.group(2).strip()
            continue

        if current:
            # 選項換行的續行
            options[current] = (options[current] + " " + text).strip()
        else:
            stem_lines.append(text)

    answer, confidence = detect_answer(raw_block, answer_col)
    if answer and answer not in options:
        # 答案指向一個沒被解析出來的選項 —— 通常代表選項切壞了。保留答案但
        # 降信心,讓它進人工複核佇列。
        confidence = min(confidence, 0.4)

    return ParsedQuestion(
        number=num,
        stem=" ".join(stem_lines).strip(),
        options=options,
        answer=answer,
        confidence=confidence,
        explanation_md="\n\n".join(explanation_lines).strip(),
    )


def parse_pdf(path: str) -> list[ParsedQuestion]:
    lines = load_lines(path)
    answer_col = find_answer_column(lines)
    raw_blocks = split_questions(lines, answer_col=None)
    clean_blocks = split_questions(lines, answer_col=answer_col)

    out: list[ParsedQuestion] = []
    for num in sorted(clean_blocks):
        out.append(
            parse_block(num, clean_blocks[num], raw_blocks.get(num, []), answer_col)
        )
    return out
