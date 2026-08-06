#!/usr/bin/env python3
"""
第一階段:PDF → parsed.json

    uv run python scripts/parse.py <民國年> <資料夾>

資料夾裡放官方 PDF,一個科別一個檔:

    ~/bank-115/
      內科.pdf
      共同.pdf

檔名要包含科別名稱(從伺服器的 [groups] 設定來),用來決定每個檔的題號要對應到
題庫的哪一段。內科 1..70 → 全域 1..70;共同 1..30 → 全域 71..100。

產物是 <資料夾>/parsed.json。那是一份**刻意留給人看、留給人改**的中間檔:
如果操作者選了「AI 補缺詳解」,就由 Claude 直接編輯裡面的 explanation_md
欄位,再跑 push.py。不必再發明一套資料交換格式。
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

from api import Client, die
from parse_exam import parse_pdf


def match_group(filename: str, labels: list[str]) -> str | None:
    stem = Path(filename).stem
    for label in labels:
        if label in stem:
            return label
    return None


def main() -> int:
    if len(sys.argv) < 3:
        die("用法:uv run python scripts/parse.py <民國年> <資料夾>")
    year = int(sys.argv[1])
    folder = Path(sys.argv[2]).expanduser()
    if not folder.is_dir():
        die(f"{folder} 不是資料夾")

    client = Client()
    client.heartbeat()

    cfg = client.config()
    groups = cfg["groups"]
    if not groups:
        die("伺服器沒有設定題組(config.toml [groups].list),無法決定題號對應。")
    labels = [g["label"] for g in groups]
    by_label = {g["label"]: g for g in groups}

    pdfs = sorted(p for p in folder.glob("*.pdf"))
    if not pdfs:
        die(f"{folder} 裡沒有 .pdf")

    plan: list[tuple[Path, dict]] = []
    unmatched: list[Path] = []
    for p in pdfs:
        label = match_group(p.name, labels)
        if label:
            plan.append((p, by_label[label]))
        else:
            unmatched.append(p)

    print(f"年份 {year} · 題庫共 {cfg['total']} 題")
    for p, g in plan:
        print(f"  {p.name}  → {g['label']}  (全域 {g['start_number']}..{g['end_number']}, {g['count']} 題)")
    for p in unmatched:
        print(f"  {p.name}  → ⚠︎ 檔名認不出科別({'/'.join(labels)}),略過")
    if not plan:
        die(f"沒有任何 PDF 的檔名對得上科別。請把檔名改成含有 {'/'.join(labels)}。")

    job = client.open_job(year)
    job_id = job["job_id"]
    if job.get("resumed"):
        print(f"\n(接續既有的匯入工作 {job_id})")
    client.progress(job_id, "parsing", f"{len(plan)} 個檔案")

    records: list[dict] = []
    for p, g in plan:
        client.progress(job_id, "parsing", p.name)
        print(f"\n… 解析 {p.name}")
        qs = parse_pdf(str(p))
        got = len(qs)
        if got != g["count"]:
            print(f"  ⚠︎ 解析出 {got} 題,設定說這個科別應該有 {g['count']} 題")
        for q in qs:
            if not (1 <= q.number <= g["count"]):
                print(f"  ⚠︎ 題號 {q.number} 超出 {g['label']} 的 1..{g['count']},略過")
                continue
            records.append(
                {
                    "number": g["start_number"] + q.number - 1,
                    "source_number": q.number,
                    "source_file": p.name,
                    "group": g["label"],
                    "stem": q.stem,
                    "options": q.options,
                    "answer": q.answer,
                    "tags": [],
                    "explanation_md": q.explanation_md,
                    "confidence": q.confidence,
                }
            )
        conf = Counter(round(q.confidence, 2) for q in qs)
        print(f"  {got} 題 · 信心分佈 {dict(sorted(conf.items(), reverse=True))}")

    records.sort(key=lambda r: r["number"])
    out = folder / "parsed.json"
    out.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")

    missing_ans = [r["number"] for r in records if not r["answer"]]
    no_expl = [r["number"] for r in records if not r["explanation_md"]]

    client.progress(job_id, "parsed", f"{len(records)} 題,{len(missing_ans)} 題缺答案")

    print(f"\n✓ 寫出 {out}")
    print(f"  共 {len(records)} 題 / 應有 {cfg['total']} 題")
    print(f"  缺答案:{len(missing_ans)} 題 {missing_ans[:20] if missing_ans else ''}")
    print(f"  缺詳解:{len(no_expl)} 題")
    print(f"\njob_id = {job_id}")
    print("下一步:確認詳解要怎麼處理,然後跑 scripts/push.py")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        die(f"{type(e).__name__}: {e}")
