#!/usr/bin/env python3
"""
把候選影片切成批次給 Haiku 評分,再把結果合回一個檔。

評分本身不在這裡 —— 是 Claude Code 派 subagent 做的。這支只負責切/合,
因為那兩件事寫成程式比讓 agent 自己拼 JSON 可靠。

  python3 scripts/score-batches.py split [--size 75]
      → scripts/data/score-in/batch-NN.json(去重後的候選)

  python3 scripts/score-batches.py merge
      → scripts/data/video-scores.json(讀 score-out/*.json 合併)
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "scripts" / "data"
CANDIDATES = DATA / "video-candidates.json"
IN_DIR = DATA / "score-in"
OUT_DIR = DATA / "score-out"
SCORES = DATA / "video-scores.json"


def cmd_split(args):
    if not CANDIDATES.exists():
        sys.exit("沒有候選檔,先跑 curate-videos.py search")
    cand = json.load(CANDIDATES.open())

    # 同一支影片可能被多個主題搜到 —— 評一次就好,但要讓評分者知道
    # 它是在哪些主題底下被找出來的,判斷相關性才有依據。
    byid: dict[str, dict] = {}
    for slug, vids in cand.items():
        for v in vids:
            e = byid.setdefault(v["id"], {
                "id": v["id"], "title": v["title"], "channel": v["channel"],
                "desc": v["desc"][:400], "topics": [],
            })
            e["topics"].append(slug)

    items = sorted(byid.values(), key=lambda e: e["id"])
    IN_DIR.mkdir(parents=True, exist_ok=True)
    for f in IN_DIR.glob("batch-*.json"):
        f.unlink()

    n = 0
    for i in range(0, len(items), args.size):
        n += 1
        (IN_DIR / f"batch-{n:02d}.json").write_text(
            json.dumps(items[i:i + args.size], ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
    print(f"{len(items)} 支候選(去重後)→ {n} 個批次 @ {args.size} → {IN_DIR}")


def cmd_merge(args):
    if not OUT_DIR.exists():
        sys.exit(f"沒有 {OUT_DIR}")
    merged: dict[str, dict] = {}
    bad = 0
    for f in sorted(OUT_DIR.glob("*.json")):
        try:
            rows = json.load(f.open())
        except json.JSONDecodeError as e:
            print(f"! {f.name} 不是合法 JSON:{e}", file=sys.stderr)
            bad += 1
            continue
        # 容許 agent 回 list 或 {id: {...}} —— 兩種都見過
        pairs = rows.items() if isinstance(rows, dict) else (
            (r.get("id"), r) for r in rows
        )
        for vid, r in pairs:
            if not vid or not isinstance(r, dict):
                continue
            merged[vid] = {
                "score": int(r.get("score") or 0),
                "is_teaching": bool(r.get("is_teaching", True)),
                "reason": (r.get("reason") or "").strip()[:120],
            }

    SCORES.write_text(json.dumps(merged, ensure_ascii=False, indent=1),
                      encoding="utf-8")
    kept = sum(1 for r in merged.values()
               if r["is_teaching"] and r["score"] >= 6)
    print(f"合併 {len(merged)} 筆評分({bad} 個壞檔)→ {SCORES}")
    print(f"  通過門檻(is_teaching 且 score>=6):{kept} 支")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("split")
    s.add_argument("--size", type=int, default=75)
    s.set_defaults(func=cmd_split)
    m = sub.add_parser("merge")
    m.set_defaults(func=cmd_merge)
    a = ap.parse_args()
    a.func(a)


if __name__ == "__main__":
    main()
