#!/usr/bin/env python3
"""Read final/<id>.json (>=10 self-contained cards + enrich_html footer),
append the footer to each card's Back (basic) / Extra (cloze),
write merged/<id>.json for insertion into 02_Hematology_enrich."""
import json, glob, os

BASE = "/tmp/hema_anki"
SRC = os.environ.get("HEMA_FINAL_DIR", "final")
DST = os.environ.get("HEMA_MERGED_DIR", "merged")
os.makedirs(f"{BASE}/{DST}", exist_ok=True)
ids = json.load(open(f"{BASE}/ids.json", encoding="utf-8"))

n_q = n_cards = n_footer = 0
missing = []
bad = []
for qid in ids:
    fp = f"{BASE}/{SRC}/{qid}.json"
    if not os.path.exists(fp):
        missing.append(qid); continue
    try:
        g = json.load(open(fp, encoding="utf-8"))
    except Exception as e:
        bad.append((qid, str(e)[:50])); continue
    footer = (g.get("enrich_html") or "").strip()
    if footer:
        n_footer += 1
    tags = list(g.get("extra_tags") or [])
    if "enriched" not in tags:
        tags.append("enriched")
    cards = []
    for idx, c in enumerate(g.get("cards", [])):
        c = dict(c)
        # footer ONLY on the first (core) card of each question (decision A)
        if footer and idx == 0:
            block = "<hr>" + footer
            if c.get("kind") == "cloze":
                c["extra"] = (c.get("extra", "") or "") + block
            else:
                c["back"] = (c.get("back", "") or "") + block
        cards.append(c); n_cards += 1
    json.dump({"id": qid, "topic_index": g["topic_index"], "extra_tags": tags, "cards": cards},
              open(f"{BASE}/{DST}/{qid}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    n_q += 1

print(f"merged {n_q} questions, {n_cards} cards ({'%.1f' % (n_cards/n_q) if n_q else 0}/q), {n_footer} with footer")
if missing: print(f"MISSING final/ for {len(missing)}: {missing[:15]}{'...' if len(missing)>15 else ''}")
if bad: print(f"BAD final files {len(bad)}: {bad[:10]}")
