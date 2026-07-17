#!/usr/bin/env python3
"""Fetch one exam question from the hema-2026 read-only API for the /mcq skill.

Reads config from .claude/skills/mcq/.env (MCQ_API_BASE / MCQ_API_KEY /
MCQ_USER_EMAIL), sends the per-user key + member email, prints the question.
The .env comes pre-baked in the .skill downloaded from /profile.
Standard library only — no pip install needed.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env() -> dict:
    cfg = dict(os.environ)
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            cfg[key.strip()] = val.strip().strip("\"'")  # .env wins over os.environ
    return cfg


def normalize(qid: str) -> str:
    """114-1 / '114 1' / 114-001 -> 114-001."""
    parts = qid.replace(" ", "-").split("-")
    if len(parts) < 2 or not parts[0].isdigit() or not parts[1].isdigit():
        sys.exit(f"題號格式應為 <年>-<題號>,例如 114-001(收到:{qid!r})")
    return f"{int(parts[0])}-{int(parts[1]):03d}"


def looks_like_qid(s: str) -> bool:
    """A 年-題號 like 114-001 / 114-1 / '114 1' — else it's a search keyword."""
    parts = s.replace(" ", "-").split("-")
    return len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit()


def clean_snippet(snip: str) -> str:
    """FTS snippet → one readable line: << >> markers become 【 】, newlines gone."""
    snip = snip.replace("<<", "【").replace(">>", "】")
    return " ".join(snip.split())


def do_search(base: str, headers: dict, query: str, year: str | None, limit: int) -> None:
    import urllib.parse

    params = {"q": query, "limit": str(limit)}
    if year:
        params["year"] = year
    url = f"{base}/api/mcq/search?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        hints = {
            401: "金鑰錯誤/已重新產生 → 回 /profile 重新下載 .skill",
            403: "email 不在白名單 → 向管理者確認 MCQ_USER_EMAIL 已加入",
            400: "FTS 語法問題 → 換個關鍵字(建議用 CML、CMV 這類縮寫)",
        }
        sys.exit(f"API {e.code}: {body}\n提示:{hints.get(e.code, '')}")
    except urllib.error.URLError as e:
        sys.exit(f"連線失敗:{e.reason} — 檢查 MCQ_API_BASE 是否正確")

    items = data.get("items", [])
    if not items:
        print(f"🔎「{query}」查無符合題目。試試更短的縮寫關鍵字(例:CML、CMV、DIC)。")
        return
    print(f"🔎「{query}」找到 {len(items)} 題(依相關度):")
    for it in items:
        snip = clean_snippet(it.get("snippet") or "")
        grp = it.get("group") or "?"
        line = f"- {it['id']}  [{grp}]"
        if snip:
            line += f"  {snip}"
        print(line)
    print("\n給我其中一個題號(例:上面任一個 年-題號)就能作答或看詳解。")


def render(d: dict, with_answer: bool = False) -> str:
    out = [f"# {d['id']}（{d.get('group') or '?'}・難度 {d.get('difficulty') or '?'}）", ""]
    out.append(d["stem"])
    out.append("")
    for opt in d.get("options", []):
        out.append(f"({opt['key']}) {opt['text']}")
    if not with_answer:
        # Quiz mode (default): question only, answer withheld for the user to attempt.
        return "\n".join(out)
    out.append("")
    out.append(f"✅ 答案:{d['answer']}")
    if d.get("source"):
        out.append(f"來源:{d['source']}")
    exp = d.get("explanation")
    if exp and exp.get("markdown"):
        out.append("")
        out.append(f"## 共筆詳解（v{exp.get('version')},最後更新 {exp.get('updated_by') or '—'}）")
        out.append(exp["markdown"])
    else:
        out.append("")
        out.append("(尚無共筆詳解)")
    # Personal note is the caller's own — only shown after answering, so quiz
    # mode can't spoil the answer via the user's past notes.
    note = d.get("personal_note")
    if note and note.get("markdown"):
        out.append("")
        out.append("## 個人筆記")
        out.append(note["markdown"])
    return "\n".join(out)


def main() -> None:
    args = sys.argv[1:]
    with_answer = False
    note_text = None
    html_text = None
    oe_url = None
    turn = None
    replace = False
    search_query = None
    year_filter = None
    limit = 20
    positional = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--answer", "-a", "--reveal"):
            with_answer = True  # reveal answer + 共筆詳解 (the original full output)
        elif a == "--note":
            i += 1
            if i >= len(args):
                sys.exit("--note 需要內容,或用 --note - 從 stdin 讀多行")
            note_text = sys.stdin.read() if args[i] == "-" else args[i]
        elif a == "--html":
            i += 1
            if i >= len(args):
                sys.exit("--html 需要 HTML 內容,或用 --html - 從 stdin 讀")
            html_text = sys.stdin.read() if args[i] == "-" else args[i]
        elif a in ("--oe-url", "--openevidence-url", "--openevidenceURL", "--oe"):
            i += 1
            if i >= len(args):
                sys.exit(f"{a} 需要 OpenEvidence 公開對話網址")
            oe_url = args[i]
        elif a == "--turn":
            i += 1
            if i >= len(args) or not args[i].isdigit():
                sys.exit("--turn 需要 1 起算的輪次數字(搭配 --oe-url)")
            turn = int(args[i])
        elif a == "--replace":
            replace = True
        elif a in ("--search", "-s"):
            i += 1
            if i >= len(args):
                sys.exit("--search 需要關鍵字,例如 --search CML")
            search_query = args[i]
        elif a == "--year":
            i += 1
            if i >= len(args) or not args[i].isdigit():
                sys.exit("--year 需要年份數字,例如 --year 113")
            year_filter = args[i]
        elif a == "--limit":
            i += 1
            if i >= len(args) or not args[i].isdigit():
                sys.exit("--limit 需要數字")
            limit = int(args[i])
        else:
            positional.append(a)
        i += 1
    if not positional and search_query is None:
        sys.exit(
            "用法:get_mcq.py <題號> [--answer]"
            " [--note <內容|->|--html <HTML|->|--oe-url <URL> [--turn N]] [--replace]"
            " | get_mcq.py --search <關鍵字> [--year YYY] [--limit N],"
            "例如 get_mcq.py 114-001 或 get_mcq.py --search CML"
        )
    content_flags = [f for f, v in (("--note", note_text), ("--html", html_text), ("--oe-url", oe_url)) if v is not None]
    if len(content_flags) > 1:
        sys.exit(f"{' 與 '.join(content_flags)} 不能同時使用")
    if replace and not content_flags:
        sys.exit("--replace 只能搭配 --note / --html / --oe-url 使用")
    if turn is not None and oe_url is None:
        sys.exit("--turn 只能搭配 --oe-url 使用")
    cfg = load_env()
    base = cfg.get("MCQ_API_BASE", "").rstrip("/")
    key = cfg.get("MCQ_API_KEY", "")
    email = cfg.get("MCQ_USER_EMAIL", "")
    missing = [
        name
        for name, val in (
            ("MCQ_API_BASE", base),
            ("MCQ_API_KEY", key),
            ("MCQ_USER_EMAIL", email),
        )
        if not val
    ]
    if missing:
        sys.exit(
            f"缺少設定:{', '.join(missing)} — 請在 {ENV_FILE} 填好"
            " (可 cp .env.example .env)"
        )

    headers = {
        "Authorization": f"Bearer {key}",
        "X-User-Email": email,
        # Cloudflare blocks the default "Python-urllib/x.y" UA (error 1010);
        # send an explicit UA so the request isn't bounced at the edge.
        "User-Agent": "mcq-skill/0.1 (+claude-code)",
    }

    # Search mode: explicit --search, or a positional that isn't a 年-題號
    # (so `get_mcq.py CML` just works). Read-only — no note flags allowed.
    if search_query is None and positional and not looks_like_qid(positional[0]):
        search_query = " ".join(positional)
    if search_query is not None:
        if content_flags:
            sys.exit("搜尋模式不能搭配 --note / --html / --oe-url")
        do_search(base, headers, search_query, year_filter, limit)
        return

    qid = normalize(positional[0])

    if content_flags:
        mode = "replace" if replace else "append"
        if note_text is not None:
            if not note_text.strip():
                sys.exit("筆記內容是空的,未送出")
            payload_obj = {"markdown": note_text, "mode": mode}
        else:
            # --html / --oe-url both convert to a TipTap doc locally
            # (scripts/oe_import.py); the Worker sanitizes the node set and
            # sideloads external images into R2.
            import oe_import

            if html_text is not None:
                if not html_text.strip():
                    sys.exit("HTML 內容是空的,未送出")
                doc = oe_import.html_to_doc(html_text)
                if not doc["content"]:
                    sys.exit("HTML 解析後沒有可用內容,未送出")
            else:
                page_html, final_url = oe_import.fetch_oe_html(oe_url)
                convo = oe_import.parse_oe_conversation(page_html)
                if not convo["turns"]:
                    sys.exit(
                        "解析不到任何對話內容 — 確認該連結是公開(Make public)的"
                        " /ask/<id> 對話"
                    )
                print(f"🔎 已解析 OpenEvidence 對話「{convo['title']}」,共 {len(convo['turns'])} 輪")
                doc = oe_import.oe_conversation_to_doc(convo, final_url, turn)
            payload_obj = {"doc": doc, "mode": mode}
        payload = json.dumps(payload_obj).encode("utf-8")
        req = urllib.request.Request(
            f"{base}/api/mcq/{qid}/note",
            data=payload,
            method="PUT",
            headers={**headers, "Content-Type": "application/json"},
        )
        try:
            # Image sideloading happens inside this request — allow more time.
            with urllib.request.urlopen(req, timeout=60) as resp:
                d = json.load(resp)
        except urllib.error.HTTPError as e:
            sys.exit(f"API {e.code}: {e.read().decode('utf-8', 'replace')}")
        except urllib.error.URLError as e:
            sys.exit(f"連線失敗:{e.reason} — 檢查 MCQ_API_BASE 是否正確")
        verb = {"create": "已建立", "append": "已附加到", "replace": "已覆寫"}[d["mode"]]
        print(f"📝 {verb} {qid} 的個人筆記")
        for w in d.get("warnings") or []:
            print(f"⚠️  {w}")
        if d.get("previous_markdown"):
            print("\n--- 被覆寫的舊內容(留存於此,如需可救回)---")
            print(d["previous_markdown"])
        print("\n--- 目前筆記全文 ---")
        print(d["note_markdown"])
        return

    req = urllib.request.Request(f"{base}/api/mcq/{qid}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        hints = {
            401: "金鑰錯誤/已重新產生 → 回 /profile 重新下載 .skill",
            403: "email 不在白名單 → 向管理者確認 MCQ_USER_EMAIL 已加入",
            404: "查無此題 → 確認題號格式(年-題號)",
        }
        sys.exit(f"API {e.code}: {body}\n提示:{hints.get(e.code, '')}")
    except urllib.error.URLError as e:
        sys.exit(f"連線失敗:{e.reason} — 檢查 MCQ_API_BASE 是否正確")

    print(render(data, with_answer=with_answer))


if __name__ == "__main__":
    main()
