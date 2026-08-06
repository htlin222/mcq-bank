#!/usr/bin/env python3
"""
第二階段:parsed.json → 匯入暫存區

    uv run python scripts/push.py <民國年> <資料夾> [--explain source|ai|none]

--explain 決定 explanation_md 要怎麼處理:

    source  (預設) 只送 PDF 裡抽出來的詳解
    ai             同上,但把 explanation_md 標成 AI 產出(給 Claude 補寫完
                   之後用,來源會記在資料庫裡以便日後辨識)
    none           完全不送詳解,題庫只進題目與答案,詳解留給站上共筆

推上去之後**還沒有人看得到**。要進到正式題庫,得回瀏覽器的「加入新年份」
精靈按下發布 —— 這把金鑰做不到那件事。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from api import Client, die
from tiptap import md_to_tiptap

CHUNK = 50


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        die("用法:uv run python scripts/push.py <民國年> <資料夾> [--explain source|ai|none]")
    year = int(args[0])
    folder = Path(args[1]).expanduser()

    mode = "source"
    if "--explain" in sys.argv:
        i = sys.argv.index("--explain")
        if i + 1 < len(sys.argv):
            mode = sys.argv[i + 1]
    if mode not in ("source", "ai", "none"):
        die("--explain 只能是 source / ai / none")

    src = folder / "parsed.json"
    if not src.exists():
        die(f"找不到 {src} —— 先跑 scripts/parse.py")
    records = json.loads(src.read_text(encoding="utf-8"))

    client = Client()
    job = client.open_job(year)
    job_id = job["job_id"]
    client.progress(job_id, "explaining", f"詳解模式 {mode}")

    payload: list[dict] = []
    with_expl = 0
    for r in records:
        md = (r.get("explanation_md") or "").strip()
        doc = None
        if mode != "none" and md:
            doc = md_to_tiptap(md)
            with_expl += 1
        item = {
            "number": r["number"],
            "group": r["group"],
            "stem": r["stem"],
            "options": r["options"],
            "answer": r.get("answer") or "",
            "tags": r.get("tags") or [],
            "confidence": r.get("confidence", 0),
            "explanation_doc": doc,
        }
        if doc is not None:
            item["explanation_source"] = "ai" if mode == "ai" else "source"
        payload.append(item)

    print(f"推送 {len(payload)} 題(含詳解 {with_expl} 題,模式 {mode})")

    staged = 0
    rejected: list[dict] = []
    for i in range(0, len(payload), CHUNK):
        chunk = payload[i : i + CHUNK]
        res = client.push_questions(job_id, chunk)
        staged = res["staged"]
        rejected.extend(res.get("rejected") or [])
        print(f"  {i + len(chunk)}/{len(payload)} … 已暫存 {staged}")

    if rejected:
        # 被退回的題目印出來而不是默默吞掉 —— 否則發布時才發現年份不完整,
        # 卻已經不知道是解析的哪一步壞掉。
        print(f"\n⚠︎ 有 {len(rejected)} 題被伺服器退回:")
        for r in rejected[:20]:
            print(f"   Q{r.get('number')}: {'; '.join(r.get('errors') or [])}")

    done = client.complete(job_id)
    print(f"\n✓ 已推進暫存區:{done['staged']} 題,其中 {done['needs_review']} 題待人工確認")
    print("\n回瀏覽器的「加入新年份」精靈,逐題審閱後按發布。")
    print("(這把金鑰只能寫暫存區,發布必須在網站上完成。)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        die(f"{type(e).__name__}: {e}")
