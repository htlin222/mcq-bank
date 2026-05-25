#!/usr/bin/env python3
"""Fetch one exam question from the hema-2026 read-only API for the /mcq skill.

Reads config from .claude/skills/mcq/.env (MCQ_API_BASE / MCQ_API_KEY /
MCQ_USER_EMAIL), sends the shared key + member email, prints the question.
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
    return "\n".join(out)


def main() -> None:
    args = sys.argv[1:]
    with_answer = False
    positional = []
    for a in args:
        if a in ("--answer", "-a", "--reveal"):
            with_answer = True  # reveal answer + 共筆詳解 (the original full output)
        else:
            positional.append(a)
    if not positional:
        sys.exit("用法:get_mcq.py <題號> [--answer],例如 get_mcq.py 114-001")
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
    req = urllib.request.Request(
        f"{base}/api/mcq/{qid}",
        headers={
            "Authorization": f"Bearer {key}",
            "X-User-Email": email,
            # Cloudflare blocks the default "Python-urllib/x.y" UA (error 1010);
            # send an explicit UA so the request isn't bounced at the edge.
            "User-Agent": "mcq-skill/0.1 (+claude-code)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        hints = {
            401: "金鑰錯誤或未設定 → 檢查 .env 的 MCQ_API_KEY",
            403: "email 不在白名單 → 向管理者確認 MCQ_USER_EMAIL 已加入",
            404: "查無此題 → 確認題號格式(年-題號)",
        }
        sys.exit(f"API {e.code}: {body}\n提示:{hints.get(e.code, '')}")
    except urllib.error.URLError as e:
        sys.exit(f"連線失敗:{e.reason} — 檢查 MCQ_API_BASE 是否正確")

    print(render(data, with_answer=with_answer))


if __name__ == "__main__":
    main()
