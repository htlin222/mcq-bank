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
    replace = False
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
        elif a == "--replace":
            replace = True
        else:
            positional.append(a)
        i += 1
    if not positional:
        sys.exit(
            "用法:get_mcq.py <題號> [--answer] [--note <內容|-> [--replace]],"
            "例如 get_mcq.py 114-001"
        )
    if replace and note_text is None:
        sys.exit("--replace 只能搭配 --note 使用")
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

    qid = normalize(positional[0])
    headers = {
        "Authorization": f"Bearer {key}",
        "X-User-Email": email,
        # Cloudflare blocks the default "Python-urllib/x.y" UA (error 1010);
        # send an explicit UA so the request isn't bounced at the edge.
        "User-Agent": "mcq-skill/0.1 (+claude-code)",
    }

    if note_text is not None:
        if not note_text.strip():
            sys.exit("筆記內容是空的,未送出")
        payload = json.dumps(
            {"markdown": note_text, "mode": "replace" if replace else "append"}
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{base}/api/mcq/{qid}/note",
            data=payload,
            method="PUT",
            headers={**headers, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                d = json.load(resp)
        except urllib.error.HTTPError as e:
            sys.exit(f"API {e.code}: {e.read().decode('utf-8', 'replace')}")
        except urllib.error.URLError as e:
            sys.exit(f"連線失敗:{e.reason} — 檢查 MCQ_API_BASE 是否正確")
        verb = {"create": "已建立", "append": "已附加到", "replace": "已覆寫"}[d["mode"]]
        print(f"📝 {verb} {qid} 的個人筆記")
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
