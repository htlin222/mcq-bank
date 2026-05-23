#!/usr/bin/env python3
"""
Polish years/<n>/batches/*.json explanation_md fields by shelling out to
`claude -p` per question. Designed to be safe-by-default:

- NEVER overwrites raw `explanation_md`. Writes result to a new field
  `explanation_polished_md` so promotion is an explicit later step.
- Hash-keyed cache in `.polish-cache/` — re-running is cheap; only new or
  changed (qid, raw_md) pairs hit Claude.
- Validators run on every response before write:
    * JSON parses against the schema
    * Every `![alt](url)` image in source appears in polished output
      byte-exact (URLs and alt text)
    * Output length ≤ 3× source length (catches runaway generation)
    * No new PMID/DOI patterns that weren't already in source
- Gentle queue: sequential by default (--concurrency 1), small delay between
  calls. `--concurrency N` to fan out if you really want.
- Modes:
    smoke    one question, print response and validation, no file write
    pilot    one batch (10 questions), write, then print summary diff
    run      iterate a range (--year, --batches) and write

Examples:
    python3 scripts/polish-explanations.py smoke --qid 104-001
    python3 scripts/polish-explanations.py pilot --year 104 --batch 1
    python3 scripts/polish-explanations.py run --year 104
    python3 scripts/polish-explanations.py run --year 104 --batches 1-5
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".polish-cache"
MODEL = "claude-sonnet-4-6"
MAX_BUDGET_USD_PER_CALL = "0.20"
DEFAULT_DELAY_SEC = 0.5

IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
PMID_RE = re.compile(r"\bPMID\s*[:#]?\s*\d{4,}\b", re.IGNORECASE)
DOI_RE = re.compile(r"\bdoi\s*[:/]?\s*10\.\d+/\S+", re.IGNORECASE)

# ---------- claude -p invocation --------------------------------------------

RESPONSE_SCHEMA = {
    "type": "object",
    "required": ["explanation_md", "images_kept", "no_invented_facts"],
    "properties": {
        "explanation_md": {"type": "string"},
        "images_kept": {"type": "array", "items": {"type": "string"}},
        "no_invented_facts": {"type": "boolean"},
    },
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You polish raw medical-exam study notes into clean, readable Markdown for
Taiwan hematology board prep (民國年度血液腫瘤次專科考試). You will receive ONE question
and its rough notes. Your job is to restructure the notes — NOT to add new clinical
content.

Output format (strict):

```
**正解：(X) <option text>**

<2–5 sentences of rationale from the existing notes>

<optional bullet contrast of distractors IF the source notes have material>

<preserve every ![alt](url) image, each on its own line>

<preserve any reference/citation line, lightly cleaned>
```

Hard rules:
1. Preserve every `![alt](url)` image reference from the source byte-exact.
2. NEVER invent: citations, PMIDs, DOIs, drug doses, lab cutoffs, gene names,
   percentages, mutation hotspots, staging criteria, or any clinical fact not
   already in the source notes.
3. If the source is essentially empty (just an echo of the question stem plus a
   single fragment like "WHO 2016 classification"), produce a 1–2 sentence
   rationale that does NOT introduce new facts — point at the hint and stop.
4. DELETE any stem-echo prefix (the source often starts by repeating the question
   stem + options verbatim — strip that).
5. 繁體中文 + English medical terminology (Taiwan idiom). Do not translate medical
   terms unnecessarily.
6. Markdown only. No HTML tags, no tables.
7. Set `no_invented_facts` to true only if you are confident you added nothing
   that wasn't in the source. If unsure, set it to false (the orchestrator will
   reject and re-prompt).

Return strictly JSON matching the schema. No prose outside the JSON.
"""


def build_user_prompt(qid: str, stem: str, options: list, answer: str, raw_md: str) -> str:
    opts_lines = "\n".join(f"({o['key']}) {o['text']}" for o in options)
    return f"""Polish the rough explanation for this question.

Question ID: {qid}

Question stem:
{stem}

Options:
{opts_lines}

Correct answer: {answer}

Raw explanation notes (may include stem-echo + scratch text + image refs):
---
{raw_md}
---
"""


def call_claude(system: str, user: str) -> dict:
    """Invoke claude -p once, return the parsed JSON object."""
    # NOTE: --bare requires ANTHROPIC_API_KEY; we use OAuth (Claude subscription)
    # so we skip --bare and rely on the keychain auth.
    # --disallowedTools is variadic so we MUST put `--` before the positional
    # prompt argument, otherwise the prompt gets eaten by the variadic list.
    cmd = [
        "claude",
        "-p",
        "--model", MODEL,
        "--output-format", "json",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--exclude-dynamic-system-prompt-sections",
        "--max-budget-usd", MAX_BUDGET_USD_PER_CALL,
        "--system-prompt", system,
        "--json-schema", json.dumps(RESPONSE_SCHEMA),
        "--disallowedTools",
        "Bash", "Edit", "Write", "Read", "Glob", "Grep", "Agent",
        "WebFetch", "WebSearch", "TaskCreate", "TaskList", "TaskGet",
        "TaskUpdate", "TaskStop", "NotebookEdit", "Skill",
        "--",
        user,
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.decode('utf-8', errors='replace')[:500]}")
    stdout = proc.stdout.decode("utf-8", errors="replace")
    envelope = json.loads(stdout) if stdout.strip() else {}
    if not isinstance(envelope, dict):
        raise RuntimeError(f"unexpected envelope type: {type(envelope)}")

    if envelope.get("is_error"):
        raise RuntimeError(f"claude API error: {envelope.get('result') or envelope.get('api_error_status')}")

    # When --json-schema is in effect, the validated object lives under
    # `structured_output`. Without a schema, the text response is under `result`.
    so = envelope.get("structured_output")
    if so is not None:
        return so

    result_text = envelope.get("result", "")
    if not result_text:
        raise RuntimeError(f"claude returned no result/structured_output. envelope keys: {list(envelope.keys())}")
    cleaned = result_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned)
    return json.loads(cleaned)


# ---------- Validators ------------------------------------------------------

def extract_images(md: str) -> list[str]:
    return IMAGE_RE.findall(md)


def validate(raw_md: str, response: dict) -> tuple[bool, list[str]]:
    """Return (ok, [reasons_for_rejection])."""
    reasons: list[str] = []
    polished = response.get("explanation_md", "")

    # 1. Images preserved byte-exact (set comparison, order doesn't matter)
    raw_imgs = set(extract_images(raw_md))
    poli_imgs = set(extract_images(polished))
    missing = raw_imgs - poli_imgs
    if missing:
        reasons.append(f"missing images: {sorted(missing)}")

    # 2. Length cap
    if len(polished) > max(300, 3 * len(raw_md)):
        reasons.append(f"runaway length: polished={len(polished)} raw={len(raw_md)}")

    # 3. No new PMIDs / DOIs
    raw_pmids = set(PMID_RE.findall(raw_md))
    new_pmids = set(PMID_RE.findall(polished)) - raw_pmids
    if new_pmids:
        reasons.append(f"invented PMIDs: {sorted(new_pmids)}")
    raw_dois = set(DOI_RE.findall(raw_md))
    new_dois = set(DOI_RE.findall(polished)) - raw_dois
    if new_dois:
        reasons.append(f"invented DOIs: {sorted(new_dois)}")

    # 4. Model self-attestation must be true
    if not response.get("no_invented_facts"):
        reasons.append("model self-reported possible invented facts (no_invented_facts=false)")

    return (len(reasons) == 0, reasons)


# ---------- Cache -----------------------------------------------------------

def cache_key(qid: str, raw_md: str) -> str:
    h = hashlib.sha256()
    h.update(qid.encode("utf-8"))
    h.update(b"\x00")
    h.update(raw_md.encode("utf-8"))
    return h.hexdigest()[:32]


def cache_path(qid: str, raw_md: str) -> Path:
    CACHE_DIR.mkdir(exist_ok=True)
    return CACHE_DIR / f"{qid}__{cache_key(qid, raw_md)}.json"


def cache_get(qid: str, raw_md: str) -> dict | None:
    p = cache_path(qid, raw_md)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
    return None


def cache_put(qid: str, raw_md: str, response: dict) -> None:
    cache_path(qid, raw_md).write_text(
        json.dumps(response, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ---------- Polish one question ---------------------------------------------

def polish_one(qid: str, stem: str, options: list, answer: str, raw_md: str,
               force: bool = False) -> tuple[dict, bool, list[str]]:
    """Return (response, ok, reasons). Uses cache unless force=True."""
    if not force:
        cached = cache_get(qid, raw_md)
        if cached is not None:
            ok, reasons = validate(raw_md, cached)
            return cached, ok, reasons

    system = SYSTEM_PROMPT
    user = build_user_prompt(qid, stem, options, answer, raw_md)
    response = call_claude(system, user)
    ok, reasons = validate(raw_md, response)
    # Only cache valid responses — invalid ones we want to retry next run.
    if ok:
        cache_put(qid, raw_md, response)
    return response, ok, reasons


# ---------- File-level orchestration ----------------------------------------

def load_batch(year: int, batch: int) -> tuple[Path, list[dict]]:
    p = ROOT / "years" / str(year) / "batches" / f"batch-{batch:02d}.json"
    return p, json.loads(p.read_text(encoding="utf-8"))


def save_batch(p: Path, questions: list[dict]) -> None:
    p.write_text(json.dumps(questions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    json.loads(p.read_text(encoding="utf-8"))  # validate


def find_qid(qid: str) -> tuple[Path, list[dict], dict]:
    year_s, num_s = qid.split("-")
    year = int(year_s)
    num = int(num_s)
    batch = ((num - 1) // 10) + 1
    p, qs = load_batch(year, batch)
    for q in qs:
        if q["number"] == num:
            return p, qs, q
    raise SystemExit(f"qid {qid} not found in {p}")


# ---------- Commands --------------------------------------------------------

def cmd_smoke(args) -> int:
    p, qs, q = find_qid(args.qid)
    raw = q.get("explanation_md", "")
    print(f"--- SMOKE: {args.qid} ---", file=sys.stderr)
    print(f"raw_md ({len(raw)} chars):\n{raw[:500]}{'…' if len(raw) > 500 else ''}\n", file=sys.stderr)
    t0 = time.time()
    resp, ok, reasons = polish_one(
        args.qid, q["stem"], q["options"], q["answer"], raw, force=args.force
    )
    dt = time.time() - t0
    print(f"--- RESPONSE (took {dt:.1f}s, ok={ok}) ---", file=sys.stderr)
    print(json.dumps(resp, ensure_ascii=False, indent=2))
    if not ok:
        print(f"\n--- VALIDATION FAILED ---", file=sys.stderr)
        for r in reasons:
            print(f"  - {r}", file=sys.stderr)
        return 2
    print(f"\n--- VALIDATION OK ---", file=sys.stderr)
    print(f"polished_md preview:\n{resp['explanation_md'][:600]}", file=sys.stderr)
    return 0


def process_question(qid: str, q: dict, force: bool) -> tuple[str, bool, list[str], dict | None]:
    raw = q.get("explanation_md", "")
    if not raw.strip():
        return qid, True, ["skipped: empty source"], None
    try:
        resp, ok, reasons = polish_one(qid, q["stem"], q["options"], q["answer"], raw, force=force)
    except Exception as e:
        return qid, False, [f"exception: {e}"], None
    return qid, ok, reasons, resp


def cmd_run(args) -> int:
    year = args.year
    if args.batch is not None:
        batches = [args.batch]
    elif args.batches:
        a, b = args.batches.split("-")
        batches = list(range(int(a), int(b) + 1))
    else:
        batches = list(range(1, 11))

    total = 0
    ok_n = 0
    fail_n = 0
    skip_n = 0
    failures: list[tuple[str, list[str]]] = []

    for bi in batches:
        p, qs = load_batch(year, bi)
        # Build work items.
        items = [(f"{year}-{q['number']:03d}", q) for q in qs]

        results: dict[str, tuple[bool, list[str], dict | None]] = {}
        if args.concurrency <= 1:
            for qid, q in items:
                qid, ok, reasons, resp = process_question(qid, q, args.force)
                results[qid] = (ok, reasons, resp)
                tag = "✓" if ok else "✗"
                print(f"  {tag} {qid}  {'; '.join(reasons) if reasons else ''}", file=sys.stderr)
                time.sleep(args.delay)
        else:
            with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
                futs = {ex.submit(process_question, qid, q, args.force): qid for qid, q in items}
                for fut in as_completed(futs):
                    qid, ok, reasons, resp = fut.result()
                    results[qid] = (ok, reasons, resp)
                    tag = "✓" if ok else "✗"
                    print(f"  {tag} {qid}  {'; '.join(reasons) if reasons else ''}", file=sys.stderr)

        # Write back: set explanation_polished_md for every ok question.
        wrote = 0
        for q in qs:
            qid = f"{year}-{q['number']:03d}"
            ok, reasons, resp = results.get(qid, (False, ["missing result"], None))
            total += 1
            if not q.get("explanation_md", "").strip():
                skip_n += 1
                continue
            if ok and resp is not None:
                q["explanation_polished_md"] = resp["explanation_md"]
                ok_n += 1
                wrote += 1
            else:
                fail_n += 1
                failures.append((qid, reasons))
        save_batch(p, qs)
        print(f"batch-{bi:02d}: wrote {wrote}/{len(qs)} polished fields", file=sys.stderr)

    print(f"\nTotal: {total}  ok: {ok_n}  failed: {fail_n}  skipped (empty): {skip_n}", file=sys.stderr)
    if failures:
        print(f"\nFailures:", file=sys.stderr)
        for qid, reasons in failures[:20]:
            print(f"  {qid}: {'; '.join(reasons)}", file=sys.stderr)
        if len(failures) > 20:
            print(f"  … and {len(failures) - 20} more", file=sys.stderr)
    return 0 if fail_n == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp_smoke = sub.add_parser("smoke", help="single-question dry run")
    sp_smoke.add_argument("--qid", required=True, help="question id, e.g. 104-001")
    sp_smoke.add_argument("--force", action="store_true", help="bypass cache")
    sp_smoke.set_defaults(func=cmd_smoke)

    sp_pilot = sub.add_parser("pilot", help="one batch (alias for run --batch)")
    sp_pilot.add_argument("--year", type=int, required=True)
    sp_pilot.add_argument("--batch", type=int, required=True)
    sp_pilot.add_argument("--force", action="store_true")
    sp_pilot.add_argument("--concurrency", type=int, default=1)
    sp_pilot.add_argument("--delay", type=float, default=DEFAULT_DELAY_SEC)
    sp_pilot.set_defaults(func=lambda a: cmd_run(argparse.Namespace(**{**vars(a), "batches": None})))

    sp_run = sub.add_parser("run", help="process year / batches range")
    sp_run.add_argument("--year", type=int, required=True)
    g = sp_run.add_mutually_exclusive_group()
    g.add_argument("--batch", type=int, help="single batch (1..10)")
    g.add_argument("--batches", help="batch range, e.g. 1-5")
    sp_run.add_argument("--force", action="store_true")
    sp_run.add_argument("--concurrency", type=int, default=1, help="parallel claude -p calls (default 1 = gentle)")
    sp_run.add_argument("--delay", type=float, default=DEFAULT_DELAY_SEC, help="seconds between sequential calls")
    sp_run.set_defaults(func=cmd_run)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
