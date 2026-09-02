#!/usr/bin/env python3
"""Fetch one exam question from the hema-2026 read-only API for the /mcq skill.

Reads config from .claude/skills/mcq/.env (MCQ_API_BASE / MCQ_API_KEY /
MCQ_USER_EMAIL), sends the per-user key + member email, prints the question.
The .env comes pre-baked in the .skill downloaded from /profile.
Standard library only — no pip install needed.
"""

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# 預設讀 skill 根目錄那份 .env(下載 .skill 時已內含個人金鑰)。
# `MCQ_ENV_FILE` 只換「讀哪一個檔」,給測試與多環境用 —— 它**不**動
# 「.env 蓋過 os.environ」那條優先序:下載下來的 .env 就是這個人的身分,
# 不該被殘留的環境變數悄悄蓋掉。
ENV_FILE = Path(os.environ.get("MCQ_ENV_FILE") or Path(__file__).resolve().parent.parent / ".env")


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


def do_search(
    base: str, headers: dict, query: str, year: str | None, limit: int
) -> None:
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
    out = [
        f"# {d['id']}（{d.get('group') or '?'}・難度 {d.get('difficulty') or '?'}）",
        "",
    ]
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
        out.append(
            f"## 共筆詳解（v{exp.get('version')},最後更新 {exp.get('updated_by') or '—'}）"
        )
        out.append(exp["markdown"])
    else:
        out.append("")
        out.append("(尚無共筆詳解)")
    # Personal notes are the caller's own — only shown after answering, so quiz
    # mode can't spoil the answer via the user's past notes.
    out.extend(render_notes(d))
    return "\n".join(out)


def render_notes(d: dict) -> list[str]:
    """一題可以有多則筆記(網頁上用左上下拉切換),全部印出來並標上編號。

    `personal_notes` 是 0.8.0 的欄位;對著舊版 Worker 就只有單則的
    `personal_note`,退回去用它,免得升級順序反過來時什麼都印不出來。
    """
    notes = d.get("personal_notes")
    if notes is None:
        one = d.get("personal_note")
        notes = [one] if one else []
    notes = [n for n in notes if n and n.get("markdown")]
    if not notes:
        return []

    out = [""]
    if len(notes) == 1:
        out.append("## 個人筆記")
        out.append(notes[0]["markdown"])
        return out

    out.append(f"## 個人筆記({len(notes)} 則)")
    for n in notes:
        out.append("")
        out.append(f"### #{n.get('slot', 0)} {n.get('title') or ''}".rstrip())
        out.append(n["markdown"])
    out.append("")
    out.append("(要寫進某一則加 --slot <編號>;要另開一則加 --new)")
    return out


def idem_key(qid: str, payload_obj: dict) -> str:
    """
    寫入請求的去重鍵 —— 同一題、同一份內容、同一個寫法,算出來就是同一個 key,
    Worker 端(lib/idempotency.ts)會直接 replay 上次的回應而不再寫一次。

    為什麼需要:預設 mode 是 append 不是覆寫,所以重跑一次會在筆記裡多出一份;
    `--new` 則是多出一則。而這裡沒有自動重試,真正的破口是「urlopen 逾時、
    Worker 其實已經寫成功」之後由人或 agent 手動重跑 —— 尤其 --oe-url 那條要在
    請求裡 sideload 最多 12 張圖進 R2,最容易撞到 60 秒。

    整個 payload 都進雜湊(內容、mode、slot 意圖),所以改任何一項都算另一次寫入。
    真的想把同一份內容再 append 一次,用 --force 不送這個 header。
    """
    material = qid + "\n" + json.dumps(payload_obj, sort_keys=True, ensure_ascii=False)
    return "mcq-note-" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


# ── 其他筆記(free_notes)────────────────────────────────────────────────
#
# 不掛在任何題目上的私人筆記,與網頁的 /lectures?tab=note 是同一批資料。
# 代號用 id 的前 8 碼(短碼)—— 完整 UUID 沒有人會想手打,而 8 碼在 500 則的
# 量級下撞號機率極低;真的撞到時伺服器回 409 並列出候選,不會猜。


def _free_req(base, headers, path, data=None, method=None, extra=None):
    url = f"{base}/api/mcq/free-notes{path}"
    h = dict(headers)
    if extra:
        h.update(extra)
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        hints = {
            401: "金鑰錯誤/已重新產生 → 回 /profile 重新下載 .skill",
            404: "找不到這則筆記 → 先跑 --free-notes 看有哪些短碼",
            409: "短碼不只對應一則 → 多打幾碼,或用完整 id",
        }
        sys.exit(f"API {e.code}: {detail}\n提示:{hints.get(e.code, '')}")
    except urllib.error.URLError as e:
        sys.exit(f"連線失敗:{e.reason} — 檢查 MCQ_API_BASE 是否正確")


def do_free_list(base, headers):
    d = _free_req(base, headers, "")
    items = d.get("items") or []
    if not items:
        print("(還沒有任何其他筆記 —— 用 `other new: 內容` 建立第一則)")
        return
    print(f"📒 其他筆記 {d.get('count', len(items))} 則(上限 {d.get('max', '?')})\n")
    for it in items:
        when = ""
        if it.get("updated_at"):
            when = time.strftime("%Y-%m-%d", time.localtime(it["updated_at"] / 1000))
        print(f"  [{it['short']}] {it.get('title') or '(無標題)'}   {when}")
        if it.get("excerpt"):
            print(f"           {it['excerpt']}")
    print("\n讀全文:other <短碼>   附加:other <短碼>: 內容   新增:other new: 內容")


def do_free_read(base, headers, ref):
    d = _free_req(base, headers, f"/{urllib.parse.quote(ref)}")
    print(f"# {d.get('title') or '(無標題)'}   [{d['short']}]\n")
    print(d.get("note_markdown") or "(空白)")


def do_free_write(base, headers, ref, text, mode, title, force):
    payload = {"markdown": text, "mode": mode, "id": ref}
    if title:
        payload["title"] = title
    extra = {}
    if not force:
        # 與題目筆記同一套去重:預設是 append,同一份內容送兩次會多出一份。
        extra["Idempotency-Key"] = idem_key(f"free:{ref}", payload)
    d = _free_req(base, headers, "", data=payload, method="PUT", extra=extra)
    verb = {"create": "已建立", "append": "已附加到", "replace": "已覆寫"}[d["mode"]]
    if d.get("replayed"):
        print(
            f"♻️  這份內容先前已寫入,本次未重複寫入 [{d['short']}]「{d.get('title')}」"
        )
        print("   (確定要再寫一份就加 --force)")
    else:
        print(f"📝 {verb}其他筆記 [{d['short']}]「{d.get('title')}」")
    for w in d.get("warnings") or []:
        print(f"⚠️  {w}")
    if d.get("previous_markdown"):
        print("\n--- 被覆寫的舊內容(留存於此,如需可救回)---")
        print(d["previous_markdown"])
    print("\n--- 目前筆記全文 ---")
    print(d["note_markdown"])


def main() -> None:
    args = sys.argv[1:]
    with_answer = False
    note_text = None
    html_text = None
    oe_url = None
    turn = None
    replace = False
    slot = None
    new_note = False
    force = False
    search_query = None
    year_filter = None
    limit = 20
    free_ref = None  # --free <id|前綴|new>:其他筆記(不掛題目)
    free_list = False  # --free-notes:列出其他筆記
    free_title = None  # --title <標題>(只在 --free 建立/更新時有意義)
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
        elif a == "--slot":
            i += 1
            if i >= len(args) or not args[i].lstrip("#").isdigit():
                sys.exit("--slot 需要筆記編號(先跑 answer 看有哪些),例如 --slot 1")
            slot = int(args[i].lstrip("#"))
        elif a in ("--new", "--new-note"):
            new_note = True
        elif a == "--force":
            force = True
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
        elif a in ("--free-notes", "--free-list", "--others"):
            free_list = True
        elif a in ("--free", "--free-note", "--other"):
            i += 1
            if i >= len(args):
                sys.exit(
                    "--free 需要筆記代號(先跑 --free-notes 看短碼),或 new 另開一則"
                )
            free_ref = args[i]
        elif a == "--title":
            i += 1
            if i >= len(args):
                sys.exit("--title 需要標題文字")
            free_title = args[i]
        elif a == "--limit":
            i += 1
            if i >= len(args) or not args[i].isdigit():
                sys.exit("--limit 需要數字")
            limit = int(args[i])
        else:
            positional.append(a)
        i += 1
    if free_list or free_ref is not None:
        if positional:
            sys.exit(
                "其他筆記不掛在題目上 —— 不要帶題號。用 --free-notes 列出、--free <代號> 指定"
            )
        if search_query is not None:
            sys.exit("--search 與其他筆記模式不能同時使用")
    if not positional and search_query is None and not free_list and free_ref is None:
        sys.exit(
            "用法:get_mcq.py <題號> [--answer]"
            " [--note <內容|->|--html <HTML|->|--oe-url <URL> [--turn N]]"
            " [--slot N|--new] [--replace] [--force]"
            " | get_mcq.py --search <關鍵字> [--year YYY] [--limit N]"
            " | get_mcq.py --free-notes | get_mcq.py --free <代號|new> [--note <內容|->] [--title T] [--replace],"
            "例如 get_mcq.py 114-001 或 get_mcq.py --search CML"
        )
    content_flags = [
        f
        for f, v in (("--note", note_text), ("--html", html_text), ("--oe-url", oe_url))
        if v is not None
    ]
    if len(content_flags) > 1:
        sys.exit(f"{' 與 '.join(content_flags)} 不能同時使用")
    if replace and not content_flags:
        sys.exit("--replace 只能搭配 --note / --html / --oe-url 使用")
    if slot is not None and new_note:
        sys.exit("--slot 與 --new 不能同時使用:一個是寫進既有的那則,一個是另開一則")
    if new_note and replace:
        sys.exit("--new 是另開一則,沒有舊內容可覆寫 —— 拿掉 --replace")
    if (slot is not None or new_note) and not content_flags:
        sys.exit(
            "--slot / --new 是寫入用的,要搭配 --note / --html / --oe-url。"
            "只是想看有哪些筆記就跑 --answer"
        )
    if turn is not None and oe_url is None:
        sys.exit("--turn 只能搭配 --oe-url 使用")
    if force and not content_flags:
        sys.exit("--force 只和寫入有關,要搭配 --note / --html / --oe-url")
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

    # ── 其他筆記(free_notes)——不掛在任何題目上的私人筆記 ──────────────
    if free_list:
        do_free_list(base, headers)
        return
    if free_ref is not None:
        if html_text is not None or oe_url is not None:
            sys.exit(
                "其他筆記目前只吃 --note(markdown);--html / --oe-url 請寫進題目筆記"
            )
        if note_text is None:
            if free_ref == "new":
                sys.exit("--free new 是建立筆記,要搭配 --note <內容>")
            do_free_read(base, headers, free_ref)
            return
        if not note_text.strip():
            sys.exit("筆記內容是空的,未送出")
        do_free_write(
            base,
            headers,
            free_ref,
            note_text,
            "replace" if replace else "append",
            free_title,
            force,
        )
        return

    qid = normalize(positional[0])

    if content_flags:
        mode = "replace" if replace else "append"
        # 不帶 slot 就是第一則 —— 與 0.7.x 的 .skill 行為相同。
        slot_field = (
            {"slot": "new"}
            if new_note
            else ({"slot": slot} if slot is not None else {})
        )
        if note_text is not None:
            if not note_text.strip():
                sys.exit("筆記內容是空的,未送出")
            payload_obj = {"markdown": note_text, "mode": mode, **slot_field}
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
                print(
                    f"🔎 已解析 OpenEvidence 對話「{convo['title']}」,共 {len(convo['turns'])} 輪"
                )
                doc = oe_import.oe_conversation_to_doc(convo, final_url, turn)
            payload_obj = {"doc": doc, "mode": mode, **slot_field}
        payload = json.dumps(payload_obj).encode("utf-8")
        write_headers = {**headers, "Content-Type": "application/json"}
        if not force:
            write_headers["Idempotency-Key"] = idem_key(qid, payload_obj)
        req = urllib.request.Request(
            f"{base}/api/mcq/{qid}/note",
            data=payload,
            method="PUT",
            headers=write_headers,
        )
        try:
            # Image sideloading happens inside this request — allow more time.
            with urllib.request.urlopen(req, timeout=60) as resp:
                d = json.load(resp)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            hints = {
                404: "題號或筆記編號不存在 → 先跑 answer 看這題有哪些筆記,或用 --new 另開一則",
                409: "這一題的筆記則數已達上限 → 寫進既有的某一則(--slot N)",
                401: "金鑰錯誤/已重新產生 → 回 /profile 重新下載 .skill",
            }
            sys.exit(f"API {e.code}: {body}\n提示:{hints.get(e.code, '')}")
        except urllib.error.URLError as e:
            sys.exit(f"連線失敗:{e.reason} — 檢查 MCQ_API_BASE 是否正確")
        verb = {"create": "已建立", "append": "已附加到", "replace": "已覆寫"}[
            d["mode"]
        ]
        # slot / title 是 0.8.0 才有的;對舊版 Worker 就退回原本的說法。
        where = ""
        if d.get("slot") is not None and (d.get("notes_count") or 1) > 1:
            where = f" #{d['slot']}「{d.get('title') or ''}」"
        elif d.get("slot"):
            where = f" #{d['slot']}"
        if d.get("replayed"):
            # 同一份內容剛剛已經寫過了(去重命中)。講清楚「沒有再寫一次」——
            # 一模一樣的成功訊息會讓人以為又多 append 了一份。
            print(f"♻️  {qid} 的這份內容先前已寫入,本次未重複寫入{where}")
            print("   (確定要再寫一份就加 --force)")
        else:
            print(f"📝 {verb} {qid} 的個人筆記{where}")
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
