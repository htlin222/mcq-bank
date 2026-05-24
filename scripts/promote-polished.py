#!/usr/bin/env python3
"""
Promote `explanation_polished_md` into `explanation_md` for every question that
has a polished version. Questions without a polished field (self-rejects + empty
sources) keep their raw `explanation_md` unchanged.

After this runs, the `explanation_polished_md` sidecar field is removed — the
batches are clean and ready for `scripts/seed-explanations.py --remote`.

Usage:
  python3 scripts/promote-polished.py --dry-run
  python3 scripts/promote-polished.py
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
YEARS = list(range(104, 114))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    total = promoted = no_polish = empty_raw = 0

    for year in YEARS:
        for p in sorted((ROOT / "years" / str(year) / "batches").glob("batch-*.json")):
            data = json.loads(p.read_text(encoding="utf-8"))
            changed = False
            for q in data:
                total += 1
                pol = q.get("explanation_polished_md")
                raw = q.get("explanation_md", "")
                if pol and pol.strip():
                    q["explanation_md"] = pol
                    q.pop("explanation_polished_md", None)
                    promoted += 1
                    changed = True
                else:
                    if not raw.strip():
                        empty_raw += 1
                    else:
                        no_polish += 1
                    # Strip empty sidecar if present
                    if "explanation_polished_md" in q:
                        q.pop("explanation_polished_md", None)
                        changed = True
            if changed and not args.dry_run:
                p.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                json.loads(p.read_text(encoding="utf-8"))  # validate

    print(f"TOTAL: {total}", file=sys.stderr)
    print(f"  promoted (polished → raw): {promoted}", file=sys.stderr)
    print(f"  kept raw (no polish, e.g. self-reject): {no_polish}", file=sys.stderr)
    print(f"  empty raw (legitimately blank): {empty_raw}", file=sys.stderr)
    if args.dry_run:
        print("\n(dry run — no files written)", file=sys.stderr)
    else:
        print("\n✅ Promote complete. Next: python3 scripts/seed-explanations.py --remote", file=sys.stderr)


if __name__ == "__main__":
    main()
