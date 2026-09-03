"""解析 Test-N-ANS.pdf 的文字層。

⚠️ 括號裡的東西有兩種語意,不能混為一談:
      Pronormoblast (proerythroblast)     → 同義詞,全對
      Plasmoblast (Plasma cell 半對)      → 半對
   混進同一個桶子的話 Plasma cell 會拿滿分,而那正是答案卷刻意要扣的那半分。

⚠️ 逗號也有兩種語意,靠「在不在括號內」區分:
      MAHA (Hemolysis, DIC)  → 括號內,是兩個同義詞
      AML, M4                → 括號外,是同一個答案的一部分
"""
import re
import sys

HALF_MARK = "半對"
LINE_RE = re.compile(r"^\s*(\d+)\s*[.、]\s*(.+?)\s*$")
OR_PREFIX_RE = re.compile(r"^\s*or\s+", re.IGNORECASE)

DECK_MAP = {
    "Test-1-ANS.pdf": "pre-test-A-2026.pdf",
    "Test-2-ANS.pdf": "pre-test-2.pdf",
    "Test-3-ANS.pdf": "wk-11-test.pdf",
    "Test-4-ANS.pdf": "week12.pdf",
}


def parse_answer_key(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        n, raw = int(m.group(1)), m.group(2).strip()
        main, alts, half = _split(raw)
        if raw.count("(") != raw.count(")"):
            print(f"⚠️  unbalanced parens in row {n}: {raw!r}", file=sys.stderr)
        rows.append({"n": n, "raw": raw, "main": main, "alts": alts, "half": half})
    return rows


def _split(raw: str) -> tuple[str, list[str], list[str]]:
    alts: list[str] = []
    half: list[str] = []

    def take(m: re.Match) -> str:
        inner = m.group(1).strip()
        for part in [p.strip() for p in inner.split(",") if p.strip()]:
            part = OR_PREFIX_RE.sub("", part).strip()
            if HALF_MARK in part:
                cleaned = part.replace(HALF_MARK, "").strip()
                if cleaned:
                    half.append(cleaned)
            else:
                alts.append(part)
        return ""

    main = re.sub(r"\(([^)]*)\)", take, raw).strip()
    main = re.sub(r"\s{2,}", " ", main).strip(" ,;")
    return main, alts, half
