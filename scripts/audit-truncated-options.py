#!/usr/bin/env python3
"""選項被截斷 / 吞掉詳解的稽核腳本(見 GitHub issue #84)。

背景:`years/*/batches/*.json` 是題庫的匯入來源,而它本身就帶著上游 PDF/docx
抽取階段的兩種傷:

  1. **截斷** —— 多行的選項只留了第一行(112-099、113-076 都是這樣)。
  2. **吞掉詳解** —— 組合題(K 型)展平時,最後一個選項把整段詳解黏了進去
     (113-078:選項 E 有 477 字,含 "Reference: TOWER Study…")。

重新匯入救不回來,因為來源檔就是錯的。要修得逐題對官方文件補。

## 為什麼要對 docx / PDF,不能只看字串長相

第一版判準是「長度 >= 30 且結尾停在中文字或逗號」。在 113 年跑出 16 個嫌疑,
逐一對 docx 之後只有 **1 個**是真的 —— 其餘 15 個是「正常但沒寫句號」的中文
選項。純字串啟發式在這裡的偽陽性率超過 90%,不能拿來當修改依據。

可靠的判法是**用下一個選項當邊界**:把原始文件壓成單行,找到這個選項的文字,
看它後面接的是不是「下一個選項的開頭」。是 → 完整;不是 → 中間那段就是被切
掉的內容。這個方法對得上 docx 把選項排成連續行、沒有 (A)(B) 標記的排版。

第二版又抓出七個「截斷」,逐一對原文之後**七個全是偽陽性**,各有各的原因:

  * 後面接的是下一題的題號(「59.以下有關…」)或 PDF 頁首。
  * docx 與批次檔在中英交界的空白不一致 —— 「MPL突變者」vs「MPL 突變者」。
    所以比對前把空白全部拿掉(`squash`),不是只做正規化。
  * 選項太短又太通用 —— "All of the above"、"G6PD deficiency" 在整份文件裡
    出現在好幾題底下,`find()` 命中的位置根本不是這一題。所以短於
    `MIN_ANCHOR` 或在原文出現不只一次的選項一律不判。

現在的規則見 `find_truncated()`。**加嚴邊界規則很容易順手把真的截斷也濾掉**,
所以 `--self-test` 的 fixture 同時涵蓋兩邊:真截斷要抓得到,四種完整情境都不
能報。改動任何一條規則之後請先跑它。

## 用法

    python3 scripts/audit-truncated-options.py --self-test  # 釘住判斷邏輯
    python3 scripts/audit-truncated-options.py 113          # 對某一年
    python3 scripts/audit-truncated-options.py 113 --fix    # 印出可套用的 SQL

只有備有原始 docx/PDF 的年份能做邊界驗證;沒有的年份只會列出「吞掉詳解」那類
(那一類不必對照原文也能確定 —— 選項裡不會有 "Reference:")。

**印出來的 SQL 不是可以直接套的。** 逐題確認補回的內容再用 —— 這支工具的定位
是把一千題縮到幾題可以人工過目,不是替你改題庫。
"""

import argparse
import glob
import json
import os
import re
import statistics
import subprocess
import sys
import zipfile

SWALLOW = re.compile(r"(正確|錯誤|Reference:|參考:|詳解|Study:|N Engl J Med|Blood\.\s)")
KEYS = "ABCDE"
# 補回的內容超過這個長度,就是邊界沒抓到,不是題目被截斷。
MAX_MISSING = 200
# 短到這種程度的「缺漏」都是原始檔的雜訊 —— 答案字母、破折號、頁碼。
MIN_MISSING = 6
# 比這短的選項不做定位比對。"All of the above"、"G6PD deficiency"、
# "Dyserythropoiesis" 這種通用短語在整份文件裡會出現在好幾題底下,`find()`
# 命中的位置沒有意義 —— 七個誤報裡有三個是這樣來的。
MIN_ANCHOR = 25
# 原始檔的頁首/頁尾。它們夾在選項之間,會讓「後面接的不是下一個選項」成立。
PAGE_NOISE = re.compile(r"^\d{3}\s*年度")
# 選項後面接下一題的題號 —— 「59.以下有關…」—— 代表這個選項結束了。
NEXT_Q = re.compile(r"^\d{1,3}[.、]")
# 比對前先剝掉黏在前面的收尾標點,否則「。114年度…」這種會躲過頁首判斷。
LEAD_PUNCT = re.compile(r"^[。.,,、;;::)）\]】\s]+")
# 整段只有標點/單一字母 → 同樣是雜訊,不是被切掉的內容。
NOISE = re.compile(r"^[A-E\s\-—–·.、,,。()()]*$")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def squash(s: str) -> str:
    r"""把空白全部拿掉再比。docx 與批次檔在中英交界的空白不一致 ——
    「MPL突變者」vs「MPL 突變者」—— 只做 \s+ → 單一空白的正規化仍然對不上,
    七個誤報裡有一個是這樣來的。"""
    return re.sub(r"\s+", "", s or "")


def load_questions(year: str) -> dict:
    """number -> options dict,從該年度所有 batch 檔彙整。"""
    out = {}
    for f in sorted(glob.glob(f"years/{year}/batches/*.json")):
        for q in json.load(open(f)):
            if isinstance(q, dict) and isinstance(q.get("options"), dict):
                out[q["number"]] = q["options"]
    return out


def source_text(year: str) -> str:
    """把該年度的 docx / PDF 全部壓成一條單行字串,當作比對用的原文。"""
    parts = []
    for path in glob.glob(f"years/{year}/**/*.docx", recursive=True):
        try:
            with zipfile.ZipFile(path) as z:
                xml = z.read("word/document.xml").decode("utf8")
            xml = xml.replace("</w:p>", "\n")
            txt = re.sub(r"<[^>]+>", "", xml)
            parts.append(txt.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
        except Exception as e:  # 壞檔不該讓整份稽核停擺
            print(f"  ! 讀不了 {os.path.basename(path)}: {e}", file=sys.stderr)
    for path in glob.glob(f"years/{year}/**/*.pdf", recursive=True):
        try:
            parts.append(
                subprocess.run(
                    ["pdftotext", "-layout", path, "-"],
                    capture_output=True, text=True, check=True,
                ).stdout
            )
        except Exception as e:
            print(f"  ! 讀不了 {os.path.basename(path)}: {e}", file=sys.stderr)
    return re.sub(r"\s+", " ", "\n".join(parts))


def find_swallowed(qs: dict) -> list:
    """選項吞掉詳解。不必對照原文 —— 正常選項不會比同題中位數長三倍還帶
    "Reference:"。"""
    hits = []
    for n, opts in sorted(qs.items()):
        lens = [len(v or "") for v in opts.values()]
        if not lens:
            continue
        med = statistics.median(lens)
        for k, v in opts.items():
            v = (v or "").strip()
            if len(v) > 120 and med > 0 and len(v) > med * 3 and SWALLOW.search(v):
                hits.append((n, k, len(v), round(med)))
    return hits


def find_truncated(qs: dict, flat: str) -> list:
    """用下一個選項當邊界找截斷。回 (number, key, 目前文字, 補回後的全文)。"""
    hits = []
    sq_flat = squash(flat)
    for n, opts in sorted(qs.items()):
        for i, k in enumerate(KEYS):
            if k not in opts:
                continue
            cur = norm(opts[k])
            if len(cur) < MIN_ANCHOR:
                continue  # 太短,定位不可靠
            sq_cur = squash(cur)
            if sq_flat.count(sq_cur) != 1:
                continue  # 找不到、或不只一處 → 位置不可信,不猜
            at = sq_flat.find(sq_cur)
            after = sq_flat[at + len(sq_cur):]
            # 有些原始檔的選項帶 (B) / B. / B、 這種標記,有些沒有(選項直接
            # 排成連續行)。兩種都要能判,所以先把標記剝掉再比對內容 ——
            # 而標記本身出現就已經是「這個選項結束了」的證據。
            if re.match(r"^\(?[A-E][)\.、]", after):
                continue
            after = LEAD_PUNCT.sub("", after)
            if PAGE_NOISE.match(after) or NEXT_Q.match(after):
                continue  # 夾在選項之間的頁首,或已經是下一題了
            nk = KEYS[i + 1] if i + 1 < len(KEYS) else None
            nxt = squash(opts.get(nk, "")) if nk else ""
            if nxt and after.startswith(nxt[:20]):
                continue  # 後面就是下一個選項 → 完整
            if re.match(r"^(詳解|Ans|答案|-{5,}|參考|Reference|這段來自)", after):
                continue  # 後面是詳解 → 完整
            stop = len(after)
            for marker in ([nxt[:20]] if nxt else []) + ["詳解", "-----", "這段來自", "答案"]:
                p = after.find(marker) if marker else -1
                if p > 0:
                    stop = min(stop, p)
            missing = after[:stop].strip()
            if len(missing) < MIN_MISSING or NOISE.match(missing):
                continue
            # 找不到收尾邊界時,`missing` 會一路吃到文件末尾。真正的截斷補回來
            # 通常在兩百字以內;超過就是邊界沒抓到,不是題目有問題。這種情況要
            # 說「判不出來」,不能報成截斷 —— 這支工具存在的理由就是不讓人拿
            # 啟發式的猜測去改題庫。
            if len(missing) > MAX_MISSING:
                hits.append((n, k, cur, None))
            else:
                hits.append((n, k, cur, f"{cur} {missing}"))
    return hits


def self_test() -> int:
    """把這支工具的判斷邏輯釘住。

    它的價值完全建立在「不亂喊、也不漏喊」上,而這兩件事會朝相反方向壞掉:
    把邊界規則加嚴到誤報歸零,很容易順手把真的截斷也濾掉。第一版就差點這樣 ——
    調完之後四個年度全是 0,看起來很漂亮,但那可能只代表工具瞎了。下面的
    fixture 同時涵蓋兩邊。
    """
    cases = []

    def check(name, got, want):
        cases.append((name, got == want, f"got={got!r} want={want!r}"))

    # 真的截斷:原文比選項多一句,而且後面接的是下一個選項。
    qs = {1: {"A": "The patient developed severe hemolysis after the drug",
              "B": "Renal function remained stable throughout the course"}}
    src = ("The patient developed severe hemolysis after the drug and required "
           "urgent transfusion support. Renal function remained stable throughout "
           "the course 詳解")
    hits = find_truncated(qs, src)
    check("真截斷抓得到", [(h[0], h[1]) for h in hits], [(1, "A")])

    # 完整:後面直接接下一個選項。
    qs = {1: {"A": "The patient developed severe hemolysis after the drug",
              "B": "Renal function remained stable throughout the course"}}
    src = ("The patient developed severe hemolysis after the drug Renal function "
           "remained stable throughout the course 詳解")
    check("接下一個選項 → 不報", find_truncated(qs, src), [])

    # 完整:後面是頁首 / 下一題的題號。這兩種夾在選項之間過,誤報過。
    qs = {1: {"E": "Monocytosis is not uncommon at initial diagnosis here"}}
    check("接頁首 → 不報",
          find_truncated(qs, "Monocytosis is not uncommon at initial diagnosis here "
                              "114 年度血專筆試分科–內科"), [])
    check("接下一題題號 → 不報",
          find_truncated(qs, "Monocytosis is not uncommon at initial diagnosis here "
                              "59.以下有關 Activated protein C 的描述"), [])

    # 空白差異不該造成誤報:docx 的中英交界常常沒有空格。
    qs = {1: {"A": "CAL-R type I or MPL 突變者屬於 low risk 的處置建議如下",
              "B": "使用 ruxolitinib 時若脾臟變大是惡化的象徵"}}
    src = ("CAL-RtypeIorMPL突變者屬於lowrisk的處置建議如下使用ruxolitinib時若脾臟變大是惡化的象徵 詳解")
    check("中英交界空白不一致 → 不報", find_truncated(qs, src), [])

    # 通用短語不做定位:它在整份文件裡會出現好幾次,命中位置沒有意義。
    qs = {1: {"E": "All of the above"}}
    src = "All of the above are possible causes. 答案: E ... All of the above 詳解"
    check("通用短語不錨定", find_truncated(qs, src), [])

    # 吞掉詳解:不必對照原文。
    qs = {1: {"A": "2+3", "B": "2+4", "C": "3+4", "D": "2+3+4",
              "E": "1+2+3+4 正確 錯誤, half-life 約為 2-3 小時 "
                   "Reference: TOWER Study: Kantarjian H. N Engl J Med. 2017" + "x" * 60}}
    check("吞掉詳解抓得到", [(h[0], h[1]) for h in find_swallowed(qs)], [(1, "E")])
    qs = {1: {"A": "x" * 130, "B": "x" * 140, "C": "x" * 150}}
    check("每個選項都長 → 不報吞詳解", find_swallowed(qs), [])

    bad = [(n, d) for n, ok, d in cases if not ok]
    for n, ok, _ in cases:
        print(f"  {'✔' if ok else '✘'} {n}")
    if bad:
        print(f"\n{len(bad)} 項失敗:")
        for n, d in bad:
            print(f"  {n}: {d}")
        return 1
    print(f"\n{len(cases)} 項全過")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    if "--self-test" in sys.argv:
        return self_test()
    ap.add_argument("year")
    ap.add_argument("--fix", action="store_true", help="印出可套用的 UPDATE 語句")
    args = ap.parse_args()

    qs = load_questions(args.year)
    if not qs:
        print(f"years/{args.year}/batches/ 裡沒有題目")
        return 1
    print(f"{args.year} 年:{len(qs)} 題\n")

    swallowed = find_swallowed(qs)
    print(f"【選項吞掉詳解】{len(swallowed)} 個")
    for n, k, L, med in swallowed:
        print(f"  {args.year}-{n:03d} ({k}) 長度 {L},同題中位數 {med}")

    flat = source_text(args.year)
    if not flat.strip():
        print("\n【截斷】沒有 docx/PDF 可比對,略過(這一類一定要對原文才能判)")
        return 0

    truncated = [h for h in find_truncated(qs, flat) if h[3]]
    unknown = [h for h in find_truncated(qs, flat) if not h[3]]
    print(f"\n【截斷】{len(truncated)} 個")
    for n, k, cur, full in truncated:
        print(f"  {args.year}-{n:03d} ({k}) {len(cur)} → {len(full)} 字")
        print(f"      缺:…{full[len(cur):][:70]}")
    if unknown:
        print(f"\n【判不出來】{len(unknown)} 個(找不到收尾邊界,要人工看原文)")
        for n, k, _cur, _ in unknown:
            print(f"  {args.year}-{n:03d} ({k})")

    if args.fix and (truncated or swallowed):
        print("\n-- 套用前請逐題確認上面的補回內容 --")
        for n, k, _cur, full in truncated:
            opts = dict(qs[n])
            opts[k] = full
            body = json.dumps(
                [{"key": kk, "text": opts[kk]} for kk in KEYS if kk in opts],
                ensure_ascii=False,
            ).replace("'", "''")
            print(f"UPDATE questions SET options_json = '{body}' "
                  f"WHERE id = '{args.year}-{n:03d}';")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
