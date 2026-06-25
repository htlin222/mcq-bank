#!/usr/bin/env python3
"""slide_batch.py — 可續跑的「詳解講義」批次驅動狀態機。

唯一的批次邏輯來源（不依賴 LLM、可獨立測試）。真相來源是檔案系統：
一題「完成」= slides/{Y}/{NNN}/slide.pdf (>50KB) 且 逐字稿.txt (>200B) 皆存在。
manifest 只為可視性 + 失敗重試計數；遺失可用 `rebuild` 由檔案系統還原。

子指令：
  next   [--scope 114,113,...] [--retry-failed]   印下一個待辦 YYY-NNN，全完成印 DONE
  mark   <qid> <status> [--oe ID] [--err MSG] [--pages N]   更新 manifest
  status [--scope ...]                              進度摘要
  rebuild [--scope ...]                             由檔案系統重建 manifest
"""
from __future__ import annotations
import argparse, json, sys, time
from pathlib import Path

# 預設範圍：民國 114 → 105（newest first），年內 1..100
DEFAULT_SCOPE = list(range(114, 104, -1))
NUMS = range(1, 101)
PDF_MIN = 50 * 1024      # slide.pdf 視為完成的最小大小
TXT_MIN = 200            # 逐字稿.txt 視為完成的最小大小
MAX_ATTEMPTS = 2         # failed 累積到此值即被 next 跳過


def repo_root() -> Path:
    p = Path(__file__).resolve().parent
    for cand in [p, *p.parents]:
        if (cand / "years").is_dir() and (cand / "slides").is_dir():
            return cand
    # 退而求其次：scripts/ 的上一層
    return Path(__file__).resolve().parent.parent


ROOT = repo_root()
MANIFEST = ROOT / "slides" / "_batch" / "manifest.json"
RUNLOG = ROOT / "slides" / "_batch" / "run.log"


def qid(year: int, num: int) -> str:
    return f"{year:03d}-{num:03d}"


def qdir(year: int, num: int) -> Path:
    return ROOT / "slides" / f"{year:03d}" / f"{num:03d}"


def is_done_fs(year: int, num: int) -> bool:
    d = qdir(year, num)
    pdf = d / "slide.pdf"
    txt = d / "逐字稿.txt"
    return (
        pdf.is_file() and pdf.stat().st_size > PDF_MIN
        and txt.is_file() and txt.stat().st_size > TXT_MIN
    )


def load_manifest() -> dict:
    if MANIFEST.is_file():
        try:
            return json.loads(MANIFEST.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"items": {}, "updated_at": None}


def save_manifest(m: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    m["updated_at"] = int(time.time() * 1000)
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")


def log(line: str) -> None:
    RUNLOG.parent.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with RUNLOG.open("a", encoding="utf-8") as f:
        f.write(f"[{ts}] {line}\n")


def parse_scope(s: str | None) -> list[int]:
    if not s:
        return DEFAULT_SCOPE
    return [int(x) for x in s.replace(" ", "").split(",") if x]


# ── 子指令 ────────────────────────────────────────────────────────────────

def cmd_next(args) -> int:
    scope = parse_scope(args.scope)
    m = load_manifest()
    items = m["items"]
    for year in scope:
        for num in NUMS:
            if is_done_fs(year, num):
                continue
            rec = items.get(qid(year, num))
            if rec and rec.get("status") == "failed" and rec.get("attempts", 0) >= MAX_ATTEMPTS:
                if not args.retry_failed:
                    continue
            print(qid(year, num))
            return 0
    print("DONE")
    return 0


def cmd_mark(args) -> int:
    m = load_manifest()
    items = m["items"]
    rec = items.get(args.qid, {"qid": args.qid, "attempts": 0})
    now = int(time.time() * 1000)
    rec["status"] = args.status
    if args.status == "in_progress":
        rec["attempts"] = rec.get("attempts", 0) + 1
        rec["started_at"] = now
    else:
        rec["finished_at"] = now
    if args.oe:
        rec["oe_article_id"] = args.oe
    if args.pages is not None:
        rec["pages"] = args.pages
    if args.err:
        rec["last_error"] = args.err[:500]
    elif args.status == "done":
        rec["last_error"] = None
    items[args.qid] = rec
    save_manifest(m)
    log(f"mark {args.qid} {args.status}"
        + (f" pages={args.pages}" if args.pages is not None else "")
        + (f" oe={args.oe}" if args.oe else "")
        + (f" err={args.err[:120]}" if args.err else ""))
    print(f"ok {args.qid} -> {args.status} (attempts={rec.get('attempts',0)})")
    return 0


def cmd_status(args) -> int:
    scope = parse_scope(args.scope)
    m = load_manifest()
    items = m["items"]
    total = done = failed = pending = 0
    per_year = {}
    cur_year = None
    for year in scope:
        yd = yf = yp = 0
        for num in NUMS:
            total += 1
            if is_done_fs(year, num):
                done += 1; yd += 1
                continue
            rec = items.get(qid(year, num))
            if rec and rec.get("status") == "failed" and rec.get("attempts", 0) >= MAX_ATTEMPTS:
                failed += 1; yf += 1
            else:
                pending += 1; yp += 1
                if cur_year is None:
                    cur_year = year
        per_year[year] = (yd, yf, yp)
    print(f"scope {scope[0]}→{scope[-1]}  total={total}  done={done}  failed={failed}  pending={pending}")
    print(f"current year: {cur_year}")
    # 粗估剩餘時間（每題以 5 分鐘計）
    eta_h = pending * 5 / 60
    print(f"est. remaining: ~{eta_h:.1f} h  (@5 min/題)")
    print("year   done failed pend")
    for year in scope:
        yd, yf, yp = per_year[year]
        print(f"{year:>4}   {yd:>4} {yf:>6} {yp:>4}")
    return 0


def cmd_rebuild(args) -> int:
    scope = parse_scope(args.scope)
    m = load_manifest()
    items = m["items"]
    n = 0
    for year in scope:
        for num in NUMS:
            if is_done_fs(year, num):
                k = qid(year, num)
                rec = items.get(k, {"qid": k, "attempts": 0})
                if rec.get("status") != "done":
                    rec["status"] = "done"
                    rec.setdefault("started_at", None)
                    rec["finished_at"] = rec.get("finished_at") or int(time.time() * 1000)
                    items[k] = rec
                    n += 1
    save_manifest(m)
    log(f"rebuild: reconciled {n} done from filesystem")
    print(f"rebuilt manifest; reconciled {n} done item(s) from filesystem")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="slide-deck 批次驅動狀態機")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("next"); p.add_argument("--scope"); p.add_argument("--retry-failed", action="store_true"); p.set_defaults(fn=cmd_next)
    p = sub.add_parser("mark"); p.add_argument("qid"); p.add_argument("status", choices=["in_progress", "done", "failed"]); p.add_argument("--oe"); p.add_argument("--err"); p.add_argument("--pages", type=int); p.set_defaults(fn=cmd_mark)
    p = sub.add_parser("status"); p.add_argument("--scope"); p.set_defaults(fn=cmd_status)
    p = sub.add_parser("rebuild"); p.add_argument("--scope"); p.set_defaults(fn=cmd_rebuild)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
