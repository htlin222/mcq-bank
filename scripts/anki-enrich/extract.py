import json, glob, os
ROOT="/Users/htlin/hema-2026/years"
out=[]
for y in (112,113,114):
    seen={}
    for f in sorted(glob.glob(f"{ROOT}/{y}/batches/batch-*.json")):
        for q in json.load(open(f,encoding="utf-8")):
            n=q.get("number")
            if n in seen:   # later batch wins? keep first non-dup
                continue
            seen[n]=1
            out.append({
                "id": f"{y}-{int(n):03d}",
                "year": y, "number": n,
                "group": q.get("group"),
                "stem": (q.get("stem") or "").strip(),
                "options": q.get("options") or {},
                "answer": q.get("answer"),
                "tags": q.get("tags") or [],
                "explanation_md": (q.get("explanation_md") or "").strip(),
            })
out.sort(key=lambda x:(x["year"],x["number"]))
json.dump(out, open("/tmp/hema_anki/questions_300.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
ids=[x["id"] for x in out]
print("total:",len(out),"unique ids:",len(set(ids)))
import collections
print("per year:", dict(collections.Counter(x["year"] for x in out)))
print("empty explanation:", sum(1 for x in out if not x["explanation_md"]))
print("sample id:", out[0]["id"], "| last:", out[-1]["id"])
