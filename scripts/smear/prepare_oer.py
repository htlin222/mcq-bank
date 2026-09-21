"""oer/*.jpg → view/full 兩份 WebP。

跟 render_pages.py 同一組尺寸與品質(view 1600 / full 2400 / q82),因為
前端的 SmearImage 對兩種來源一視同仁 —— 尺寸不一致的症狀是「某些圖點開
放大之後比較糊」,而那看起來像圖本身拍得不好。

⚠️ 不裁邊。render_pages 的 trim 是為了投影片的白邊;顯微鏡照片四周本來就
是視野,裁掉就是把資料裁掉。
"""
import argparse
import json
import os
import re

from PIL import Image

VIEW, FULL, Q = 1600, 2400, 82


def resize(img, long_edge):
    w, h = img.size
    if max(w, h) <= long_edge:
        return img
    return img.resize(
        (long_edge, round(h * long_edge / w)) if w >= h else (round(w * long_edge / h), long_edge),
        Image.LANCZOS,
    )


def audit(rows, dx_path):
    """檔名 vs 指派的 dx —— 對不上的標 needs_review。

    ⚠️ 這道閘是實際踩到才加的。章節頁上的圖不一定都在講這一章的主題:
    acanthocyte 那章夾了一張 `0273Agglutination`,bite cell 那章夾了一張
    `0297MAHA3` —— 用來對比的圖。整章一律掛同一個 dx 的話,那幾張就被貼上
    錯的診斷,而**一張圖掛錯診斷就是直接教錯東西**,比少幾張圖糟得多。

    幸好這本書的檔名自己寫著主題(`0275Acanthocyte…`),拿它當交叉檢查。
    判準保守:檔名命中**別的** dx 的詞、而且**沒有**命中自己的,才標記。
    兩者都命中(對比圖)或都沒命中(檔名沒資訊)都放行 —— 誤標比漏標難察覺。
    """
    dx = json.load(open(dx_path, encoding="utf-8"))
    def norm(t):
        return re.sub(r"[^a-z]", "", t.lower())
    kw = {}
    for d in dx:
        ts = {norm(t["text"]) for t in d.get("terms", [])} | {norm(d["canonical_long"])}
        kw[d["dx_id"]] = {t for t in ts if len(t) >= 7}
    # ⚠️ 自動檢查是網,不是保證。它靠「檔名寫著別的診斷的**詞表裡的詞**」,
    #    而詞表不見得收了那個字面(`cold_agglutination` 的詞表裡沒有單獨的
    #    `agglutination`)。下面這幾張是人眼看出來、自動檢查漏掉的:
    #    章節頁常放一兩張**對比用**的圖,它不是這一章的主題。
    #    再加素材時要自己看一遍,不要以為跑過 audit 就乾淨了。
    DENY = ("0273Agglutinat", "0297MAHA3")
    flagged = 0
    for r in rows:
        if any(k.lower() in os.path.basename(r["file"]).lower() for k in DENY):
            r["needs_review"] = True
            r["looks_like"] = ["人工排除:章節頁的對比圖,不是這一章的主題"]
            flagged += 1
            print(f"  ⚠ {r['dx_id']:<22} 人工排除:{os.path.basename(r['file'])[:52]}")
            continue
        # ⚠️ 只看真正的圖檔名,不要連章節 slug 一起看。檔名是
        # `<slug>--plain--<原始檔名>`,而 slug 本身就含這一章的主題 ——
        # 把它算進去的話 hits_own 恆真,整個檢查退化成永遠不報。
        # 反過來也會誤報:`bite-keratocyte-blister-helmet-cell` 裡的 helmet
        # 是 schistocyte 的俗名,於是那一章每張圖都被指成 schistocyte。
        base = norm(os.path.basename(r["file"]).split("--")[-1])
        own = kw.get(r["dx_id"], set())
        hits_own = any(t in base for t in own)
        other = sorted({o for o, ts in kw.items() if o != r["dx_id"] and any(t in base for t in ts)})
        if other and not hits_own:
            r["needs_review"] = True
            r["looks_like"] = other[:3]
            flagged += 1
            print(f"  ⚠ {r['dx_id']:<22} 檔名看起來是 {','.join(other[:3])}:{os.path.basename(r['file'])[:52]}")
        else:
            r["needs_review"] = False
    return flagged


def resolve(here, p):
    """清單裡存相對於 scripts/smear/ 的路徑 —— 絕對路徑會帶著使用者名稱,
    換一台機器就壞,而且不該進版控。"""
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(here, p))


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(__file__)
    ap.add_argument("--manifest", default=os.path.join(here, "data", "oer.json"))
    ap.add_argument("--out", default=os.path.join(here, "data", "oer-webp"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rows = json.load(open(a.manifest, encoding="utf-8"))
    n = 0
    for r in rows:
        src = resolve(here, r["file"])
        if not os.path.exists(src):
            continue
        img = Image.open(src).convert("RGB")
        for label, edge in (("view", VIEW), ("full", FULL)):
            dest = os.path.join(a.out, f"{r['id']}-{label}.webp")
            r[f"webp_{label}"] = os.path.relpath(dest, here)
            if not os.path.exists(dest):
                resize(img, edge).save(dest, "WEBP", quality=Q)
        n += 1
    flagged = audit(rows, os.path.join(here, "data", "dx.json"))
    json.dump(rows, open(a.manifest, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"✅ {n} 張 → {a.out}")
    if flagged:
        print(f"⚠️ {flagged} 張檔名跟指派的診斷對不上,已標 needs_review,import 會跳過。")


if __name__ == "__main__":
    main()
