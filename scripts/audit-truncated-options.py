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

## 用法

    python3 scripts/audit-truncated-options.py 113        # 對某一年
    python3 scripts/audit-truncated-options.py 113 --fix  # 印出可套用的 SQL

只有備有原始 docx/PDF 的年份能做邊界驗證;沒有的年份只會列出「吞掉詳解」那類
(那一類不必對照原文也能確定 —— 選項裡不會有 "Reference:")。
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
# 整段只有標點/單一字母 → 同樣是雜訊,不是被切掉的內容。
NOISE = re.compile(r"^[A-E\s\-—–·.、,,。()()]*$")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


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
    for n, opts in sorted(qs.items()):
        for i, k in enumerate(KEYS):
            if k not in opts:
                continue
            cur = norm(opts[k])
            if len(cur) < 15:
                continue
            at = flat.find(cur)
            if at < 0:
                continue  # 原文找不到 → 無從判斷,不猜
            after = flat[at + len(cur):].lstrip()
            # 有些原始檔的選項帶 (B) / B. / B、 這種標記,有些沒有(選項直接
            # 排成連續行)。兩種都要能判,所以先把標記剝掉再比對內容 ——
            # 而標記本身出現就已經是「這個選項結束了」的證據。
            if re.match(r"^\(?[A-E][)\.、]", after):
                continue
            nk = KEYS[i + 1] if i + 1 < len(KEYS) else None
            nxt = norm(opts.get(nk, "")) if nk else ""
            if nxt and after.startswith(nxt[:20]):
                continue  # 後面就是下一個選項 → 完整
            if re.match(r"^(詳解|Ans|答案|-{5,}|參考|Reference|這段來自)", after):
                continue  # 後面是詳解 → 完整
            stop = len(after)
            for marker in ([nxt[:20]] if nxt else []) + ["詳解", "-----", "這段來自"]:
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


def main() -> int:
    ap = argparse.ArgumentParser()
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
