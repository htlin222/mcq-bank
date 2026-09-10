"""ASH reference-cases → 跑台案例 JSON(和 parse_cases.py 同一個形狀)。

設計:docs/plans/2026-09-09-smear-station-design.md §2.1

只取設計裡點名的那 8 案 —— 它們補的是和信兩份沒有的病(MDS、HCL、MCL、CLL 第二版、
PV、ET、HbSD、AA+PNH),而這幾個在跑台常入題。

⚠️ **ASH 沒有逐張說明,只有整案敘述。** 這正是「中途一律不回饋」那個決定的來源:
兩種來源都改成寫完才揭曉,格式就一致了(設計 §3 第二條)。

⚠️ **每張圖的模態只能從 alt 文字猜。** ASH 的 metadata 只有檔名式的 alt
(`AML-with-t8-21--5`),沒有 PB/BM 標記。認得出來的就標,認不出來一律 `other`
—— **不要為了讓畫面好看而猜**,標錯 PB/BM 是直接教錯判讀順序。
順序用 metadata 的 image_ids 原順序,那是 ASH 頁面上的排列順序。
"""

import html
import json
import os
import re
import sys

BASE = os.path.expanduser("~/ash-image-bank/data")
CASES = {
    "138": "mds", "102": "hairy_cell_leukemia", "129": "mantle_cell_lymphoma",
    "142": "cll", "73": "pv", "16": "et", "144": "thalassemia", "11": "aplastic_anemia",
}
MOD = [("flow", r"flow[- ]?cytometr"), ("ihc", r"immunostain|immunohisto|IHC|CD\d"),
       ("bm", r"bone[- ]?marrow|marrow|aspirate|biops"), ("pb", r"peripheral|blood|smear")]
HIST = re.compile(r"[^.]*?\b\d{1,2}[- ]?(?:year|yr)[- ]?old\b[^.]*\.|[^.]*?\bpresent(?:ed|s|ing) with\b[^.]*\.", re.I)


def clean(pth):
    s = open(pth, encoding="utf-8", errors="replace").read()
    t = html.unescape(re.sub(r"<[^>]+>", "\n", re.sub(r"<script.*?</script>", "", s, flags=re.S)))
    bad = ("googletag", "javascript", "Images of peripheral", "Complete cases",
           "background-image", "document", "Please enable")
    return [x.strip() for x in t.split("\n")
            if len(x.strip()) > 80 and not any(b in x for b in bad)], s


def modality(alt):
    for k, pat in MOD:
        if re.search(pat, alt, re.I):
            return k
    return "other"


def main():
    idx = {}
    for line in open(os.path.join(BASE, "index.jsonl"), encoding="utf-8"):
        d = json.loads(line)
        if d.get("collection") == "reference-cases":
            idx[d["id"]] = d
    out = []
    for cid, dx in CASES.items():
        d = idx.get(cid)
        if not d:
            sys.exit(f"✖ ASH reference-case #{cid} 不在 index.jsonl")
        cdir = os.path.join(BASE, "reference-cases", cid)
        paras, raw = clean(os.path.join(cdir, "page.html"))
        alts = dict(re.findall(r'data-original="/getimagebyid/(\d+)[^"]*"\s+alt="([^"]*)"', raw))
        # ⚠️ 拿掉 WHO 分類路徑。它長得像敘述,但逐字寫著診斷名 ——
        #    `... > Low-grade B-cell lymphoma > Chronic Lymphocytic Leukemia`。
        #    當成病史送出去就是把答案印在題目上。
        #    用 metadata 裡的 category 原字串去砍,不要用 " > " 猜邊界:
        #    它常常跟後面的敘述黏在同一段裡,猜邊界會連病史第一句一起砍掉。
        cat = (d.get("category") or "").strip()
        body = " ".join(paras)
        if cat:
            body = body.replace(cat, " ")
        hist = " ".join(m.group(0).strip() for m in HIST.finditer(body))[:600]
        pages = []
        for i, iid in enumerate(d.get("image_ids") or []):
            f = os.path.join(cdir, "images", f"{iid}.jpg")
            if not os.path.exists(f):
                continue
            pages.append({"page": i, "image_file": f, "modality": [modality(alts.get(iid, ""))],
                          "captions": [], "reveal": []})
        if not pages:
            sys.exit(f"✖ ASH #{cid} 一張圖都找不到 —— 先確認 image bank 抓齊了")
        out.append({
            "id": f"ash-c{cid}", "deck": "ash", "source_ref": f"ASH reference-case #{cid}",
            "source_url": d.get("url"), "attribution": f"ASH Image Bank — {d.get('author','')}".strip(" —"),
            "dx_id": dx, "title_raw": d["title"], "history": [hist] if hist else [],
            "discussion": paras, "pages": pages, "redactions": [],
        })
    dest = os.path.join(os.path.dirname(__file__), "data", "cases-ash.json")
    json.dump(out, open(dest, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    npg = sum(len(c["pages"]) for c in out)
    nmod = sum(1 for c in out for p in c["pages"] if p["modality"] != ["other"])
    print(f"✅ {len(out)} 案 / {npg} 張圖 / 認得出模態 {nmod} 張 → {dest}")
    for c in out:
        print(f"   {c['id']:<9} {c['dx_id']:<22} {len(c['pages']):>2}張  病史{'有' if c['history'] else '無'}  {c['title_raw'][:38]}")


if __name__ == "__main__":
    main()
