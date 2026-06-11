#!/usr/bin/env python3
"""Bulk-insert generated Anki cards into AnkiWeb using a single reused session.

Reads /tmp/hema_anki/gen/<id>.json (written by workflow agents), composes deck +
tags from the topic index, and inserts each card with ONE network call per card
(replicates anki.add_card body construction but skips its per-card info lookups).
Resumable via inserted.txt; failures collected to failures.json.
"""
import json, glob, os, sys, time, re

SKILL = "/Users/htlin/.claude/skills/anki"
sys.path.insert(0, SKILL)
import anki  # noqa: E402

BASE = "/tmp/hema_anki"
GEN = os.environ.get("HEMA_GEN", f"{BASE}/gen")
DONE_FILE = os.environ.get("HEMA_DONE", f"{BASE}/inserted.txt")
FAIL_FILE = os.environ.get("HEMA_FAIL", f"{BASE}/failures.json")
LOG = os.environ.get("HEMA_LOG", f"{BASE}/insert.log")

PREFIX = os.environ.get("HEMA_DECK_PREFIX", "02_Hematology")
SUFFIX = {
    1: ("1_骨髓白血病(WBC-I)", "WBC-I-Myeloid"),
    2: ("2_淋巴瘤(WBC-II)", "WBC-II-Lymphoma"),
    3: ("3_初級止血(Coag-I)", "Coag-I-Primary"),
    4: ("4_凝血血栓(Coag-II)", "Coag-II-Thrombosis"),
    5: ("5_紅血球貧血(RBC)", "RBC"),
    6: ("6_輸血醫學(Transfusion)", "Transfusion"),
    7: ("7_兒科血液(Pediatric)", "Pediatric"),
}
TOPIC = {k: (f"{PREFIX}::{suf}", slug) for k, (suf, slug) in SUFFIX.items()}


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def sanitize_tag(t):
    t = str(t).strip()
    t = re.sub(r"\s+", "_", t)
    t = re.sub(r'[\"\'　]', "", t)
    return t


LOCK = f"{BASE}/.insert.lock"


def main():
    try:
        os.mkdir(LOCK)
    except FileExistsError:
        log("another inserter holds the lock; exiting")
        return
    try:
        _run()
    finally:
        try:
            os.rmdir(LOCK)
        except OSError:
            pass


def _run():
    client = anki.AnkiWebClient()
    client.ensure_login()
    info = client.get_info_for_adding()
    deck_id = {name: did for did, name in info["decks"]}
    nt_id = {name: i for i, name in info["notetypes"]}
    # field counts for the two note types we use
    basic_fields = client.get_notetype_fields(nt_id["Basic"])
    cloze_fields = client.get_notetype_fields(nt_id["3. Cloze"])
    log(f"login ok. Basic fields={basic_fields} Cloze fields={cloze_fields}")

    done = set()
    if os.path.exists(DONE_FILE):
        done = set(open(DONE_FILE, encoding="utf-8").read().split())
    failures = []

    def insert(notetype_id, field_count, values, tags):
        field_vals = [""] * field_count
        for i, v in enumerate(values):
            field_vals[i] = v or ""
        body = b"".join(anki.pb_string(1, fv) for fv in field_vals)
        if tags:
            body += anki.pb_string(2, tags)
        body += anki.pb_message(3, anki.pb_int(1, notetype_id) + anki.pb_int(2, deck_id_cur))  # noqa
        client._svc(anki.ANKIUSER, "/svc/editor/add-or-update", body)

    files = sorted(glob.glob(f"{GEN}/*.json"))
    log(f"found {len(files)} gen files; {len(done)} cards already inserted")
    total_added = 0
    for fp in files:
        try:
            g = json.load(open(fp, encoding="utf-8"))
        except Exception as e:
            log(f"SKIP unreadable {fp}: {e}")
            continue
        qid = g["id"]
        year = qid.split("-")[0]
        ti = int(g["topic_index"])
        deck_name, slug = TOPIC[ti]
        deck_id_cur = deck_id.get(deck_name)
        if deck_id_cur is None:
            log(f"!! deck missing for {deck_name}; skipping {qid}")
            continue
        base_tags = ["hema", f"Y{year}", f"Q{qid}", f"topic::{slug}"]
        extra = [sanitize_tag(t) for t in (g.get("extra_tags") or []) if str(t).strip()]
        tags = " ".join(base_tags + extra)
        for i, c in enumerate(g.get("cards", [])):
            uid = f"{qid}#{i}"
            if uid in done:
                continue
            kind = c.get("kind", "basic")
            try:
                if kind == "cloze":
                    insert(nt_id["3. Cloze"], len(cloze_fields),
                           (c.get("text", ""), c.get("extra", "")), tags)
                else:
                    insert(nt_id["Basic"], len(basic_fields),
                           (c.get("front", ""), c.get("back", "")), tags)
                with open(DONE_FILE, "a", encoding="utf-8") as df:
                    df.write(uid + "\n")
                done.add(uid)
                total_added += 1
                if total_added % 50 == 0:
                    log(f"... {total_added} cards inserted (last {qid})")
                time.sleep(0.06)
            except Exception as e:
                failures.append({"uid": uid, "deck": deck_name, "kind": kind, "err": str(e)})
                log(f"FAIL {uid}: {e}")
                time.sleep(0.5)

    json.dump(failures, open(FAIL_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log(f"DONE. inserted this run={total_added}, total done={len(done)}, failures={len(failures)}")


if __name__ == "__main__":
    deck_id_cur = None  # set per question inside main()
    main()
