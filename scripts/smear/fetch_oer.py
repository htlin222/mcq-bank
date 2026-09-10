"""Alberta 開放教科書 → 單張抹片題素材。

來源:A Laboratory Guide to Clinical Hematology(Villatoro & To,Alberta OER)
https://pressbooks.openeducationalberta.ca/mlsci/  授權 CC BY-NC。

設計:docs/plans/2026-09-09-smear-station-design.md §2

⚠️ **這批補的是單張題,不是跑台。** 它是單細胞圖譜,不是病人案例。補的是
overview 說 PathologyOutlines 那條「對 RBC 形態幾乎沒覆蓋」的洞 —— 而現有
題庫的 rbc 主題只有 24 個 dx,是七個主題裡素材最薄的一塊。

⚠️ **圖不在 `<img>` 裡。** 章節頁把圖包在 H5P 的 ImageSlider 元件中,
`<img>` 只有網站 logo。要先抓 `admin-ajax.php?action=h5p_embed&id=<n>`,
從 `H5PIntegration` 的 `jsonContent` 讀出 `images/file-*.jpg`,再拼上
`H5PIntegration.url`(`/app/uploads/sites/3/h5p`)。直接爬 `<img>` 會得到
「這本書沒有圖」的錯誤結論。

⚠️ **CC BY-NC 要求標示出處。** attribution 與 source_url 兩個欄位都要填,
`smear_questions` 本來就有。站台非商業、內部 20 人,符合 NC。

⚠️ **溫和抓取。** 每個請求之間 sleep,失敗不重試到死。這是別人免費提供的
教材站,不是我們的 CDN。
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request

BASE = "https://pressbooks.openeducationalberta.ca/mlsci"
SITE = "https://pressbooks.openeducationalberta.ca"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ATTRIB = "A Laboratory Guide to Clinical Hematology — Villatoro & To (CC BY-NC)"
DELAY = 1.2  # 秒。溫和抓取。

# 章節 → 現有 smear_dx。只列對得起來的;對不上的寧可不收,
# 因為一張圖掛錯診斷就是直接教錯東西。
CHAPTERS = {
    # 紅血球形態 —— 這批是主要目的
    "abnormal-rbc-morphology-teardrop-cell-dacrocyte": "dacrocyte",
    "abnormal-rbc-morphology-target-cell-codocyte": "codocyte",
    "abnormal-rbc-morphology-acanthocyte": "acanthocytosis",
    "abnormal-rbc-morphology-echinocyte-burr-cell": "echinocyte",
    "abnormal-rbc-morphology-schistocyte": "schistocyte",
    "abnormal-rbc-morphology-elliptocyte-ovalocyte": "elliptocyte",
    "abnormal-rbc-morphology-spherocyte": "spherocyte",
    "abnormal-rbc-morphology-sickle-cell-drepanocyte": "sickle_cell",
    "abnormal-rbc-morphology-stomatocyte": "stomatocyte",
    "abnormal-rbc-morphology-rouleaux": "rouleau_formation",
    "abnormal-rbc-morphology-poikilocytosis": "poikilocytosis",
    "abnormal-rbc-morphology-bite-keratocyte-blister-helmet-cell": "bite_cell",
    "abnormal-rbc-morphology-agglutination": "cold_agglutination",
    # 紅血球內含物
    "abnormal-rbc-inclusions-basophilic-stippling": "basophilic_stippling",
    "abnormal-rbc-inclusions-cabot-rings": "cabot_ring",
    "abnormal-rbc-inclusions-howell-jolly-bodies": "howell_jolly_body",
    "abnormal-rbc-inclusions-pappenheimer-bodies-siderotic-granules": "pappenheimer_body",
    "abnormal-rbc-inclusions-heinz-bodies": "heinz_body",
    "abnormal-rbc-inclusions-hemoglobin-cc-crystals": "hemoglobin_c_crystal",
    "abnormal-rbc-inclusions-malaria": "malaria",
    # 白血球形態
    "neutrophil-hypersegmentation": "hypersegmented_neutrophil",
    "pelger-huet-anomaly": "pelger_huet_anomaly",
    "may-hegglin-anomaly": "may_hegglin_anomaly",
    # 疾病
    "hereditary-spherocytosis": "hereditary_spherocytosis",
    "hypochromic-microcytic-anemias-thalassemias": "thalassemia",
    "hypochromic-microcytic-anemias-sideroblastic-anemia": "ring_sideroblast",
    "extrinsic-defects-causing-hemolytic-anemia-microangiopathic-hemolytic-anemias-mahas": "maha",
    "dna-metabolism-abnormalities-bone-marrow-failure-aplastic-anemia": "aplastic_anemia",
    "paroxysmal-nocturnal-hemoglobinuria-pnh": "pnh",
    "acute-lymphoblastic-leukemia-all": "all",
    "acute-myelogenous-leukemia-aml": "aml_unspecified",
    "acute-promyelocytic-leukemia-apl": "apl",
    "chronic-lymphocytic-leukemia-cll": "cll",
    "chronic-myelogenous-leukemia-cml": "cml",
    "hairy-cell-leukemia-hcl": "hairy_cell_leukemia",
    "essential-thrombocythemia-et": "et",
    "polycythemia-vera-pv": "pv",
    "primary-myelofibrosis-mf": "leukoerythroblastosis",
    "plasma-cell-myeloma-multiple-myeloma": "mm",
    "waldenstrom-macroglobulinemia": "wm",
    "infectious-mononucleosis": "infectious_mononucleosis",
}


def get(url, referer=BASE + "/"):
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Referer": referer, "Accept-Language": "en-US,en;q=0.9"}
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read()


def h5p_ids(html_text):
    return sorted({int(x) for x in re.findall(r'data-content-id="(\d+)"', html_text)})


def slider_images(embed_html):
    """從 H5P embed 頁抽 (相對路徑, alt) 清單。回 (base_url, [(path, alt)])。"""
    m = re.search(r"H5PIntegration\s*=\s*(\{.*?\});", embed_html, re.S)
    if not m:
        return None, []
    integ = json.loads(m.group(1))
    base = integ.get("url") or ""
    out = []
    for cid, content in (integ.get("contents") or {}).items():
        n = re.match(r"cid-(\d+)", cid)
        if not n:
            continue
        try:
            j = json.loads(content.get("jsonContent") or "{}")
        except json.JSONDecodeError:
            continue
        for path, alt in walk(j):
            out.append((int(n.group(1)), path, alt))
    return base, out


def walk(node, alt=None):
    """遞迴找 {"path": "images/...", ...},順便撿最近的 alt。"""
    if isinstance(node, dict):
        if isinstance(node.get("path"), str) and node["path"].startswith("images/"):
            yield node["path"], (node.get("alt") or alt or "")
        cur = node.get("alt") if isinstance(node.get("alt"), str) else alt
        for v in node.values():
            yield from walk(v, cur)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v, alt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "data", "oer"))
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 章(除錯用)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    manifest, n_img, failed = [], 0, []
    items = list(CHAPTERS.items())
    if a.limit:
        items = items[: a.limit]

    for slug, dx_id in items:
        url = f"{BASE}/chapter/{slug}/"
        try:
            html_text = get(url).decode("utf-8", "replace")
        except Exception as e:
            failed.append((slug, f"chapter: {e}"))
            continue
        time.sleep(DELAY)

        ids = h5p_ids(html_text)
        if not ids:
            # 不是每一章都用 H5P。少數章節就是普通的 <img> 指向 /uploads/ ——
            # 沒有這條退路的話那幾章會被當成「抓不到」而靜靜漏掉,而漏掉的
            # 症狀是「這個形態怎麼都不出題」,不會有人回報得清楚。
            # ⚠️ WordPress 對同一張圖產好幾個尺寸變體(`-1024x768`、`-300x225`),
            #    而它們在頁面上都會出現。不正規化的話同一張圖會被當成好幾張,
            #    而且 id 撞在一起 —— 實測 95 列裡有 35 列是這樣被 UPSERT 蓋掉的,
            #    症狀是「匯入說 95 張,資料庫只有 60 張」。
            #    砍掉尺寸後綴就拿到原圖,順便去重。
            seen_plain, plain = set(), []
            for u in re.findall(r'<img[^>]+src="([^"]+)"', html_text):
                if "/uploads/" not in u or "logo" in u.lower() or "cropped-" in u:
                    continue
                full = re.sub(r"-\d{2,4}x\d{2,4}(?=\.[A-Za-z]{3,4}$)", "", u)
                if full in seen_plain:
                    continue
                seen_plain.add(full)
                plain.append(full)
            if not plain:
                failed.append((slug, "章節頁既沒有 H5P 也沒有內容圖"))
                continue
            for u in plain:
                src = u if u.startswith("http") else SITE + u
                fname = f"{slug}--plain--{os.path.basename(src.split('?')[0])}"
                dest = os.path.join(a.out, fname)
                if not os.path.exists(dest):
                    try:
                        with open(dest, "wb") as f:
                            f.write(get(src, referer=url))
                    except Exception as e:
                        failed.append((slug, f"image {u}: {e}"))
                        continue
                    time.sleep(DELAY)
                manifest.append({
                    "dx_id": dx_id, "file": os.path.relpath(dest, os.path.dirname(__file__)), "alt": "",
                    "source_url": url, "attribution": ATTRIB,
                    "id": f"oer-{slug[:34]}-p{len(manifest):03d}",
                })
                n_img += 1
            print(f"  {slug[:52]:<54} → {dx_id:<26} 累計 {n_img} 張(一般 img)", flush=True)
            continue

        for hid in ids:
            embed = f"{BASE}/wp-admin/admin-ajax.php?action=h5p_embed&id={hid}"
            try:
                eh = get(embed, referer=url).decode("utf-8", "replace")
            except Exception as e:
                failed.append((slug, f"h5p {hid}: {e}"))
                continue
            time.sleep(DELAY)
            base, imgs = slider_images(eh)
            if not imgs:
                continue
            for cid, path, alt in imgs:
                src = f"{SITE}{base}/content/{cid}/{path}"
                fname = f"{slug}--{cid}--{os.path.basename(path)}"
                dest = os.path.join(a.out, fname)
                if not os.path.exists(dest):
                    try:
                        data = get(src, referer=embed)
                    except Exception as e:
                        failed.append((slug, f"image {path}: {e}"))
                        continue
                    with open(dest, "wb") as f:
                        f.write(data)
                    time.sleep(DELAY)
                manifest.append(
                    {
                        "dx_id": dx_id,
                        "file": os.path.relpath(dest, os.path.dirname(__file__)),
                        "alt": alt,
                        "source_url": url,
                        "attribution": ATTRIB,
                        # 序號保證唯一。純靠檔名尾碼在 WordPress 尺寸變體上撞過。
                        "id": f"oer-{slug[:30]}-{cid}-{len(manifest):03d}",
                    }
                )
                n_img += 1
        print(f"  {slug[:52]:<54} → {dx_id:<26} 累計 {n_img} 張", flush=True)

    dest = os.path.join(os.path.dirname(__file__), "data", "oer.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f"\n✅ {len(items)} 章 / {n_img} 張圖 → {dest}")
    if failed:
        print(f"⚠️ {len(failed)} 章有問題:")
        for s, why in failed[:15]:
            print(f"   {s}: {why}")


if __name__ == "__main__":
    main()
