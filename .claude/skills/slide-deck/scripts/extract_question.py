#!/usr/bin/env python3
"""抽出某一題的原始資料 → slides/{YEAR}/{NNN}/raw/，並印出題目內容供作答講義用。

用法:
    python3 extract_question.py 114-001          # 也接受 114-1
    python3 extract_question.py 114-001 --root /path/to/hema-2026

資料來源(相對 repo 根目錄):
    years/{YEAR}/batches/*.json   題幹/選項/答案/tags/explanation_md
    years/{YEAR}/enrich/*.json    共筆詳解 content_json / oe_article_id / figures

產物:
    slides/{YEAR}/{NNN}/raw/question.json   原始題目(batch 內該題物件)
    slides/{YEAR}/{NNN}/raw/enrich.json     OE 整理後的詳解(若存在)
    slides/{YEAR}/{NNN}/raw/figure-*.{ext}  enrich.figures 內的圖(若有,下載為灰階用素材)
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path


def find_repo_root(start: Path) -> Path:
    """從 start 往上找含 years/ 的目錄當 repo 根。找不到就用 cwd。"""
    for p in [start, *start.parents]:
        if (p / "years").is_dir():
            return p
    return Path.cwd()


def parse_qid(qid: str):
    m = re.match(r"^(\d{2,3})[-_ ]?(\d{1,3})$", qid.strip())
    if not m:
        sys.exit(f"無法解析題號: {qid!r}（格式應為 114-001 或 114-1）")
    year = m.group(1)
    num = int(m.group(2))
    return year, num


def load_all(json_dir: Path):
    items = []
    if not json_dir.is_dir():
        return items
    for f in sorted(json_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, list):
            items.extend(data)
        elif isinstance(data, dict):
            items.append(data)
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("qid")
    ap.add_argument("--root", default=None, help="repo 根目錄(預設自動往上找 years/)")
    args = ap.parse_args()

    year, num = parse_qid(args.qid)
    nnn = f"{num:03d}"
    root = Path(args.root).resolve() if args.root else find_repo_root(Path(__file__).resolve())

    batches = load_all(root / "years" / year / "batches")
    question = next((x for x in batches if x.get("number") == num), None)
    if question is None:
        sys.exit(f"在 years/{year}/batches/ 找不到第 {num} 題")

    enrich_items = load_all(root / "years" / year / "enrich")
    qid_full = f"{year}-{nnn}"
    enrich = next((x for x in enrich_items if x.get("id") == qid_full), None)

    out_dir = root / "slides" / year / nnn / "raw"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "question.json").write_text(
        json.dumps(question, ensure_ascii=False, indent=2), encoding="utf-8")
    if enrich:
        (out_dir / "enrich.json").write_text(
            json.dumps(enrich, ensure_ascii=False, indent=2), encoding="utf-8")

    # 下載 figures(灰階呈現用)
    figs = (enrich or {}).get("figures") or []
    saved_figs = []
    for i, fig in enumerate(figs, 1):
        # figures 可能是 {"url":..,"caption":..} 物件，也可能只是 URL 字串
        if isinstance(fig, str):
            url, caption = fig, ""
        elif isinstance(fig, dict):
            url, caption = fig.get("url"), fig.get("caption", "")
        else:
            continue
        if not url:
            continue
        ext = (re.search(r"\.(jpg|jpeg|png|gif|webp)(\?|$)", url, re.I) or [None, "jpg"])[1]
        dest = out_dir / f"figure-{i}.{ext.lower()}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                dest.write_bytes(r.read())
            saved_figs.append((dest.name, caption))
        except Exception as e:
            print(f"[warn] 圖下載失敗 {url}: {e}", file=sys.stderr)

    # 純文字摘要(供 Claude 撰寫講義)
    def explain_text(cj):
        out = []
        def walk(n):
            if isinstance(n, dict):
                t = n.get("type")
                if t == "heading":
                    # 標題文字直接取自子節點，取完即返回，避免再走一次造成重複
                    out.append("\n## " + "".join(c.get("text", "") for c in n.get("content", [])))
                    return
                if t == "text":
                    out.append(n.get("text", ""))
                for c in n.get("content", []):
                    walk(c)
            elif isinstance(n, list):
                for c in n:
                    walk(c)
        walk(cj)
        return "".join(out)

    print(f"# {qid_full}  (group: {question.get('group','?')})")
    print(f"raw 已寫入: {out_dir}")
    print(f"\n## 題幹\n{question.get('stem','')}")
    print("\n## 選項")
    opts = question.get("options") or {}
    if isinstance(opts, dict):
        opt_pairs = list(opts.items())
    elif isinstance(opts, list):
        # 純字串陣列(K 型組合題等)：依序配 A/B/C…；物件則取常見鍵
        opt_pairs = []
        for i, o in enumerate(opts):
            label = chr(65 + i)
            if isinstance(o, dict):
                key = o.get("key") or o.get("label") or label
                val = o.get("text") or o.get("value") or o.get("content") or ""
            else:
                key, val = label, o
            opt_pairs.append((key, val))
    else:
        opt_pairs = []
    for k, v in opt_pairs:
        print(f"  {k}. {v}")
    print(f"\n## 答案: {question.get('answer','?')}")
    print(f"## tags: {', '.join(question.get('tags') or [])}")
    if question.get("explanation_md"):
        print(f"\n## explanation_md\n{question['explanation_md']}")
    if enrich:
        print(f"\n## oe_article_id: {enrich.get('oe_article_id')}")
        if enrich.get("content_json"):
            print(f"\n## 共筆詳解(純文字)\n{explain_text(enrich['content_json'])}")
    if saved_figs:
        print("\n## 已下載圖(raw/ 下，HTML 以 grayscale 呈現)")
        for name, cap in saved_figs:
            print(f"  - raw/{name} — {cap}")


if __name__ == "__main__":
    main()
