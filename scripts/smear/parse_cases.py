"""和信教學片 → 跑台案例 JSON。

設計:docs/plans/2026-09-09-smear-station-design.md §7

輸入是 `~/Dropbox/血專大補丁/抹片考訊/2025*_血液_Smear-{1,5}.pdf`,
和信醫院徐千富醫師「Hema Learning Hub」的 Lesson 1 與 Lesson 5。
輸出是 `scripts/smear/data/cases.json`,一案一個物件,交給 import.ts 灌進
`smear_cases` / `smear_case_items`。

四個踩過的地方,每一個都是實際跑過才知道的:

⚠️ **一頁屬於哪一案,看它自己掛什麼標題,不要往下沿用。** 第一版是「遇到
`Case N:` 就切,之後每頁都算那一案」,結果最後一案一路吃到投影片結尾 ——
實測 Smear-1 的 Case 8 被算成 17 頁,其中 4 頁是收尾。
而這批投影片**每一張都重複帶著 `Case N:` 的標題**,所以正確的規則是逐頁問
「這一頁掛的是哪一案」,連結束錨點都不需要。Outline 頁(它也含 `Case N:`)
要排除,而它在的時候順便當交叉檢查:切出來的案數對不上就吵。
⚠️ **Smear-1 沒有 Outline 頁**,所以那個檢查是可選的,不能當成硬性前提 ——
第一版把它寫成 SystemExit,於是整份 Smear-1 一案都出不來。

⚠️ **模態有兩套寫法。** `PB smear` / `BM smear` 與 `Peripheral blood` /
`Bone marrow`。只認長寫法的話,Smear-5 的 APL 那案全用短寫法,會整案標不到
模態,而症狀看起來像那案剛好沒有骨髓片。

⚠️ **圖說的冒號右半是判讀,要切掉。** 原文 `2022/08/03 BM smear: suspect AML`
—— 61 個帶日期的圖說裡有 24 個(39%)長這樣。左半是線索,右半是答案。
右半進 `reveal_note`,不進 `caption`。

⚠️ **圖說行開頭常有項目符號,判斷日期之前要先剝掉。** 第一版先問
`^\d{4}/`,而投影片上寫的是 `• 2022/08/03 BM smear: suspect AML` ——
於是整行落進 history,而 **history 是作答前就顯示的**。也就是說那個 39%
的判讀全部被印在題目上。這不是排版問題,是把答案送給使用者。
症狀在畫面上完全看不出來:病史本來就該有日期跟檢驗。

⚠️ **投影片上有病人識別資訊。** `Mr.林 41`、`Ms.RO 50` 這種。整頁 render 會把
它畫進圖裡。這支腳本把偵測到的位置吐進 `redactions`,由 `render_pages.py`
的 `--redact` 塗掉。**沒有 redaction 清單就不要 render** —— 漏一頁的症狀是
一個真實病人的姓氏出現在一個 20 人看得到的網站上,而且沒有人會注意到。
"""

import argparse
import json
import os
import re
import sys

DECKS = {
    "kfs-l1": "20250313_血液_Smear-1.pdf",
    "kfs-l5": "20250702_血液_Smear-5.pdf",
}

# 兩套模態寫法。順序有意義:先長後短,否則 'Bone marrow' 會先被 'BM' 之外的
# 分支吃掉。值是存進 smear_case_items.modality 的代碼。
MODALITIES = [
    ("pb", r"Peripheral blood|PB smear"),
    ("bm", r"Bone marrow|BM smear|Marrow aspirate"),
    ("effusion", r"Pleural effusion|Ascites|effusion"),
    ("aspiration", r"Mass aspiration|FNA|aspiration"),
    ("csf", r"\bCSF\b"),
]
MOD_RE = re.compile("|".join(f"(?P<{k}>{v})" for k, v in MODALITIES), re.I)

CASE_HEAD = re.compile(r"Case\s+(\d+)\s*[::]\s*(.*)")
OUTLINE_CASE = re.compile(r"Case\s+(\d+)\s*[::]")
DATE = r"\d{4}/\d{1,2}(?:/\d{1,2})?"
CAPTION = re.compile(rf"({DATE})\s*([^\n:：]*?)\s*(?:\(([^)]*)\))?\s*(?:[:：]\s*(.*))?$")
# 病人識別:Mr./Ms./Mrs. 後面接姓氏或代號,常後接年齡。
PII = re.compile(r"\b(?:Mr|Ms|Mrs|Miss)\.?\s*[A-Za-z一-鿿]{1,12}\s*\d{0,3}")


def page_texts(path):
    import fitz

    doc = fitz.open(path)
    try:
        return [doc[i].get_text() for i in range(doc.page_count)], doc
    except Exception:
        doc.close()
        raise


def outline_case_count(pages):
    """Outline 頁列出的案數 —— 案界的上界。找不到就回 None,呼叫端要吵。"""
    best = 0
    for text in pages[:8]:
        if "Outline" not in text and "outline" not in text:
            continue
        nums = {int(m.group(1)) for m in OUTLINE_CASE.finditer(text)}
        if nums:
            best = max(best, max(nums))
    return best or None


def detect_modalities(text):
    found = []
    for m in MOD_RE.finditer(text):
        for k, _ in MODALITIES:
            if m.group(k):
                if k not in found:
                    found.append(k)
                break
    return found


def split_caption(line):
    """一行圖說 → (caption, reveal)。冒號右半是判讀,切掉。"""
    m = CAPTION.match(line.strip())
    if not m:
        return line.strip(), None
    date, what, site, verdict = m.groups()
    left = f"{date} {(what or '').strip()}".strip()
    if site:
        left += f" ({site.strip()})"
    return left, (verdict or "").strip() or None


def parse_deck(deck_id, path):
    pages, doc = page_texts(path)
    try:
        max_case = outline_case_count(pages)  # 可選的交叉檢查,Smear-1 沒有

        cases = {}
        for pno, text in enumerate(pages, 1):
            first_line = text.split("\n")[0] if text else ""
            if "Outline" in first_line:
                continue
            head = CASE_HEAD.search(text)
            if not head:
                continue  # 這一頁沒掛案號 —— 開場、收尾、通用說明,都不屬於任何一案
            num = int(head.group(1))
            cases.setdefault(
                num,
                {"num": num, "pages": [], "title_lines": [], "history": [], "redactions": []},
            )
            c = cases[num]
            tl = head.group(2).strip()
            if tl and tl not in c["title_lines"]:
                c["title_lines"].append(tl)
            lines = [x.strip() for x in text.split("\n") if x.strip()]
            caps, reveals = [], []
            for ln in lines:
                if CASE_HEAD.match(ln):
                    continue
                if PII.search(ln):
                    c["redactions"].append({"page": pno, "text": PII.search(ln).group(0)})
                bare = ln.lstrip("•· \t")
                if re.match(rf"^{DATE}", bare):
                    left, rev = split_caption(bare)
                    if detect_modalities(bare):
                        caps.append(left)
                        if rev:
                            reveals.append(f"{left}:{rev}")
                    else:
                        c["history"].append(bare)
                elif ln.startswith(("•", "·")):
                    c["history"].append(ln.lstrip("•· "))
            c["pages"].append(
                {
                    "page": pno,
                    "modality": detect_modalities(text) or ["other"],
                    "captions": caps,
                    "reveal": reveals,
                }
            )
        if max_case and max_case != len(cases):
            print(
                f"⚠️ {os.path.basename(path)}:Outline 說有 {max_case} 案,"
                f"實際切出 {len(cases)} 案 —— 兩者對不上,人工看一下。",
                file=sys.stderr,
            )
        return [cases[k] for k in sorted(cases)]
    finally:
        doc.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.expanduser("~/Dropbox/血專大補丁/抹片考訊"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "data", "cases.json"))
    a = ap.parse_args()

    out = []
    for deck_id, fname in DECKS.items():
        path = os.path.join(a.src, fname)
        if not os.path.exists(path):
            raise SystemExit(f"✖ 找不到 {path}")
        for c in parse_deck(deck_id, path):
            out.append(
                {
                    "id": f"{deck_id}-c{c['num']}",
                    "deck": deck_id,
                    "source_ref": f"{fname}#Case{c['num']}",
                    "title_raw": " ".join(c["title_lines"]),
                    "history": c["history"],
                    "pages": c["pages"],
                    "redactions": c["redactions"],
                }
            )

    n_pages = sum(len(c["pages"]) for c in out)
    n_red = sum(len(c["redactions"]) for c in out)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"✅ {len(out)} 案 / {n_pages} 頁 / {n_red} 處待遮蔽 → {a.out}")
    if n_red == 0:
        print("⚠️ 一處病人識別資訊都沒偵測到。這批投影片實測是有的 —— 先確認偵測沒壞掉。")


if __name__ == "__main__":
    main()
