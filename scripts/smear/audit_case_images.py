"""跑台步驟圖的 OCR 稽核:圖上看得到答案的步驟,剔除。

設計:docs/plans/2026-09-09-smear-station-design.md §14

render_pages.py --strip-text 只遮得掉**文字層**。但投影片上還有兩種字是
**點陣圖**,文字層裡根本不存在:

  - 病理 / 染色體報告的截圖(`PATHOLOGICAL DIAGNOSIS: ... Acute promyelocytic
    leukemia`)—— 那一頁整張就是答案
  - 烙在圖片裡的標籤(`PB: Hemophagocytosis`)

所以 render 之後再 OCR 一次,判準是「圖上看得到這一案自己任何一個 accepted term、
或看得到 `Case N` 標題」。掃到就剔除那一步,並印出來。

⚠️ **這是網,不是保證。** tesseract 讀不好花俏字型(病人姓名寫在一張寶可夢風格的
   圖裡,OCR 一次都沒讀到),而三個字元以下的詞(APL、ALL)不拿來掃 —— 那會在任何
   一張圖的雜訊裡誤中。姓名那一層靠 render_pages 的 redaction,不靠這裡。

⚠️ **剔除步驟,不是剔除整案。** 報告截圖那一頁本來就不是抹片,拿掉它什麼都沒少。

用法:python3 audit_case_images.py <manifest.json>
  manifest 是 [{case_id, idx, file, dx_id}],輸出同形狀加上 leak 欄位。
"""
import io
import json
import re
import subprocess
import sys
import os

HERE = os.path.dirname(__file__)
TITLE = re.compile(r"\bcase\s*\d{1,2}\s*[:;.]", re.I)


def load_terms():
    terms = {}
    for d in json.load(open(os.path.join(HERE, "data", "dx.json"), encoding="utf-8")):
        ts = {t["text"].lower() for t in d.get("terms", [])} | {d["canonical_long"].lower()}
        terms[d["dx_id"]] = sorted(t for t in ts if len(t) > 3)
    return terms


def ocr(path):
    """OCR 一張圖。讀不了就 raise,**絕不回空字串**。

    ⚠️ 實際踩過:tesseract 讀不了 render 出來的 `.webp`(中文檔名 + webp,
       Leptonica 報 image file not found),stdout 是空的、exit code 非零,
       而第一版只看 stdout —— 於是 128 張「剔除 0 張」,整道閘靜靜變成放行。
       同一批素材手動跑時剔除 5 張。**讀失敗跟乾淨,在只看輸出的判準下長得一模一樣。**
       所以一律先用 PIL 轉 PNG 走 stdin,並且檢查 exit code。
    """
    from PIL import Image

    buf = io.BytesIO()
    Image.open(path).convert("RGB").save(buf, "PNG")
    proc = subprocess.run(
        ["tesseract", "stdin", "stdout", "--psm", "11"],
        input=buf.getvalue(), capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"tesseract 讀不了 {path}:{proc.stderr.decode('utf-8', 'replace')[:200]}")
    # 不能嚴格解碼:顯微鏡圖的雜訊會讓 tesseract 吐出不合法的 UTF-8(實測)。
    return re.sub(r"\s+", " ", proc.stdout.decode("utf-8", errors="replace")).lower()


def main():
    rows = json.load(open(sys.argv[1], encoding="utf-8"))
    terms = load_terms()
    dropped = 0
    for r in rows:
        txt = ocr(r["file"])
        r["_chars"] = len(txt.strip())
        hits = [t for t in terms.get(r["dx_id"], []) if t in txt]
        title = bool(TITLE.search(txt))
        r["leak"] = hits[:3] + (["標題 Case N"] if title else [])
        if r["leak"]:
            dropped += 1
            print(f"  ✂ {r['case_id']} #{r['idx']} 圖上看得到:{', '.join(r['leak'])}", file=sys.stderr)
    # 對照組:全批一個字都沒讀到,代表 OCR 沒在工作,不是圖很乾淨。
    #    步驟圖裡至少有圖說(`2022/08/01 PB smear`),正常情況一定讀得到東西。
    if rows and not any(r["_chars"] for r in rows):
        raise SystemExit("✖ OCR 對整批圖片一個字都沒讀到 —— 那是 OCR 壞了,不是圖乾淨")
    for r in rows:
        r.pop("_chars", None)
    json.dump(rows, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"OCR 稽核:{len(rows)} 張,剔除 {dropped} 張", file=sys.stderr)


if __name__ == "__main__":
    main()
