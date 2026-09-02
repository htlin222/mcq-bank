#!/usr/bin/env python3
"""把詳解裡「當成純文字存進去的 ``` 圍籬」就地換成真正的 codeBlock。

背景:`scripts/seed-explanations.py` 原本不認得 fenced code block,於是
`years/*/batches/*.json` 裡那些 ASCII 機轉圖被當成普通段落寫進 D1 ——
兩行 ``` 原樣顯示在畫面上,而圖用內文的比例字體排,箭頭全部對不齊。
轉換器已經補上圍籬支援;這一支負責修已經寫進去的資料。

**從 years/*/batches 重新產生,但有一道守門。** 就地轉換救不回縮排 —— 那些
ASCII 圖的箭頭本來就靠前導空白對齊,而空白在 seed 當時就被逐行 strip 掉了,
資料庫裡已經沒有。原始 md 還留著,所以正確的修法是重生。

守門是這樣的:先把現存的 doc 做一次就地轉換(把 literal 圍籬段落換成 codeBlock),
再跟重生的 doc 比對 —— **只有在「程式區塊以外一字不差」時才寫入**。有人編輯過的
詳解會在這裡被擋下並列出來,由人決定。實測 103 年 42 篇裡 18 篇重生後與正式站
逐位元組相同,其餘 24 篇的差異全部落在圍籬那幾段。

    python3 scripts/fix-fenced-explanations.py            # 乾跑(預設)
    python3 scripts/fix-fenced-explanations.py --local --apply
    python3 scripts/fix-fenced-explanations.py --remote --apply

寫入時會先把舊版塞進 explanation_history 再 version + 1 —— 走的是站上原本的
版本機制,所以在網頁上就能還原,不需要另外準備 rollback。
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = subprocess.run(
    ["node", str(ROOT / "scripts/lib/cfg.mjs"), "project.d1_db"],
    capture_output=True, text=True, cwd=ROOT,
).stdout.strip()
ACTOR = "fix-fenced-explanations"


def flat(node: dict) -> str:
    """把一個 paragraph 攤平成文字,hardBreak 還原成換行。"""
    out = []
    for k in node.get("content") or []:
        t = k.get("type")
        if t == "text":
            out.append(k.get("text", ""))
        elif t == "hardBreak":
            out.append("\n")
        else:
            out.append(flat(k))
    return "".join(out)


def to_code_block(node: dict) -> dict | None:
    """整段就是一個 ```…``` 區塊 → codeBlock;否則回 None(不動它)。

    刻意只認「自足」的段落:頭尾都是圍籬、而且中間沒有第三個。半開的圍籬多半
    代表這段文字的結構跟我們想的不一樣,寧可原樣留著也不要猜。
    """
    if node.get("type") != "paragraph":
        return None
    s = flat(node).strip()
    if not s.startswith("```") or not s.endswith("```"):
        return None
    lines = s.split("\n")
    if len(lines) < 2 or s.count("```") != 2:
        return None
    lang = lines[0][3:].strip() or None
    body = "\n".join(lines[1:-1]).rstrip()
    out: dict = {"type": "codeBlock", "attrs": {"language": lang}}
    if body:
        out["content"] = [{"type": "text", "text": body}]
    return out


def fix_doc(doc: dict) -> tuple[dict, int]:
    """回傳 (新的 doc, 換掉幾個區塊)。只走頂層 —— 圍籬段落不會巢在清單裡。"""
    n = 0
    content = []
    for node in doc.get("content") or []:
        cb = to_code_block(node)
        if cb is None:
            content.append(node)
        else:
            content.append(cb)
            n += 1
    return ({**doc, "content": content}, n)


def norm(doc: dict) -> str:
    """把 codeBlock 的內文正規化(逐行去前導空白)後序列化。

    比對用。就地轉換出來的區塊沒有縮排(資料庫裡本來就沒了),重生的有 —— 那正是
    這次要修的東西,所以比對時要把它排除,才問得出「**其他地方**有沒有被動過」。
    """
    d = json.loads(json.dumps(doc))

    def walk(n):
        if n.get("type") == "codeBlock":
            for t in n.get("content") or []:
                if t.get("type") == "text":
                    t["text"] = "\n".join(
                        ln.strip() for ln in t["text"].split("\n")
                    ).strip()
        for k in n.get("content") or []:
            walk(k)

    walk(d)
    return json.dumps(d, ensure_ascii=False, sort_keys=True)


def load_sources() -> dict:
    """years/*/batches/*.json → {question_id: explanation_md}"""
    out = {}
    for yd in sorted((ROOT / "years").glob("*/batches")):
        year = yd.parent.name
        if not year.isdigit():
            continue
        for f in sorted(yd.glob("*.json")):
            for it in json.loads(f.read_text(encoding="utf-8")):
                num = it.get("number")
                md = it.get("explanation_md")
                if num is None or not md:
                    continue
                out[f"{year}-{int(num):03d}"] = md
    return out


def d1(sql: str, remote: bool, json_out: bool = False):
    cmd = ["npx", "wrangler", "d1", "execute", DB,
           "--remote" if remote else "--local", "--command", sql]
    if json_out:
        cmd.append("--json")
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        sys.exit(f"wrangler 失敗:\n{r.stderr[-2000:]}")
    return r.stdout


def main() -> None:
    remote = "--remote" in sys.argv
    apply = "--apply" in sys.argv
    raw = d1(
        "SELECT question_id, version, content_json FROM explanations "
        "WHERE content_json LIKE '%```%' ORDER BY question_id;",
        remote, json_out=True,
    )
    rows = json.loads(raw[raw.index("["):])[0]["results"]
    print(f"{'正式站' if remote else '本機'}:{len(rows)} 篇詳解含 literal 圍籬\n")

    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "seed", ROOT / "scripts/seed-explanations.py"
    )
    seed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(seed)
    sources = load_sources()

    changed = []
    for r in rows:
        qid = r["question_id"]
        doc = json.loads(r["content_json"])
        inplace, n = fix_doc(doc)
        if not n:
            print(f"  ⚠️  {qid} 有圍籬但不是自足段落 —— 略過,請人工看")
            continue
        md = sources.get(qid)
        if md is None:
            print(f"  ⚠️  {qid} 在 years/*/batches 找不到原始 md —— 略過")
            continue
        regen = seed.md_to_tiptap(md)
        if norm(inplace) != norm(regen):
            # 程式區塊以外有差 → 有人編輯過,或轉換器行為變了。兩種都不該由腳本決定。
            print(f"  ⚠️  {qid} 重生的內容與現存**在程式區塊之外**不一致 —— 略過,請人工看")
            continue
        changed.append((qid, r["version"], r["content_json"], regen, n))

    total = sum(c[4] for c in changed)
    print(f"\n可修:{len(changed)} 篇 / {total} 個區塊")
    if not apply:
        for qid, _, _, new, n in changed[:2]:
            blk = next(x for x in new["content"] if x["type"] == "codeBlock")
            body = (blk.get("content") or [{}])[0].get("text", "")
            print(f"\n--- {qid} 轉出來的第一個 codeBlock ---\n{body}")
        print("\n(乾跑。要真的寫入請加 --apply)")
        return

    now = int(time.time() * 1000)
    for qid, ver, old_json, new, n in changed:
        oj = old_json.replace("'", "''")
        nj = json.dumps(new, ensure_ascii=False).replace("'", "''")
        # 先留歷史再改 —— 反過來的話中途失敗就沒有舊版可還原了。
        d1(f"INSERT INTO explanation_history (question_id, version, content_json, updated_by, updated_at) "
           f"VALUES ('{qid}', {ver}, '{oj}', '{ACTOR}', {now});", remote)
        d1(f"UPDATE explanations SET content_json = '{nj}', version = {ver + 1}, "
           f"updated_by = '{ACTOR}', updated_at = {now} WHERE question_id = '{qid}';", remote)
        print(f"  ✓ {qid}  v{ver} → v{ver + 1}  ({n} 個區塊)")
    print(f"\n完成:{len(changed)} 篇。舊版都在 explanation_history,網頁上可還原。")


if __name__ == "__main__":
    main()
