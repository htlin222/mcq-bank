#!/usr/bin/env python3
"""Deterministic front door for the /mcq skill.

The agent passes the slash-command args VERBATIM as a single argument; this
router parses the leading token and dispatches to get_mcq.py with the right
flags. No SKILL.md reasoning needed — the prefix decides the action:

    <題號>              → 出題(不給答案,測驗模式)      114-011
    <題號> answer       → 揭曉答案 + 共筆詳解 + 個人筆記   114-011 answer
    search: <關鍵字>     → 關鍵字搜尋題目                search: CML
    note <題號>: <內容>  → 附加個人筆記(append)          note 114-011: TKI 首選…
    note <題號> #2: …    → 附加到第 2 則筆記              note 114-011 #2: …
    note <題號> new: …   → 另開一則筆記                  note 114-011 new: …
    other               → 列出「其他筆記」(不掛題目的私人筆記)
    other <短碼>         → 讀某一則全文                   other 4fef0394
    other new: <內容>    → 新增一則                       other new: 今天讀到…
    other new [標題]: …  → 新增並指定標題                  other new [語氣作答法]: …
    other <短碼>: <內容> → 附加到那一則                    other 4fef0394: 補充…
    other <短碼> replace: … → 整則覆寫

`answer` 也接受:ans / --answer / -a / 答案 / 看答案 / 揭曉。
題號格式沿用 get_mcq.py(114-1、'114 1' 也可)。錯誤訊息由 get_mcq.py 產生。
筆記編號在 answer 的輸出裡(`### #N 標題`);不指定就是第一則。

進階(帶圖 HTML / OpenEvidence 匯入、--replace 覆寫)仍直接用 get_mcq.py —
本 router 只覆蓋日常三種前綴,不重新實作那些流程。
"""

import subprocess
import sys
from pathlib import Path

GET_MCQ = str(Path(__file__).resolve().parent / "get_mcq.py")

REVEAL_TOKENS = {"answer", "ans", "--answer", "-a", "答案", "看答案", "揭曉"}


def run(argv: list[str], stdin_text: str | None = None) -> None:
    """Delegate to get_mcq.py, streaming its output, and exit with its code."""
    proc = subprocess.run([sys.executable, GET_MCQ, *argv], input=stdin_text, text=True)
    sys.exit(proc.returncode)


def main() -> None:
    # All args arrive as one verbatim string (the agent quotes the slash-command
    # args). Join defensively in case they arrive already split.
    raw = " ".join(sys.argv[1:]).strip()
    if not raw:
        sys.exit(
            "用法:mcq_cmd.py '<args>' — 例:"
            "'114-011' / '114-011 answer' / 'search: CML' / 'note 114-011: 內容'"
        )

    low = raw.lower()

    # search: <關鍵字>
    if low.startswith("search:"):
        query = raw[len("search:") :].strip()
        if not query:
            sys.exit("search: 後面要接關鍵字,例:search: CML")
        run(["--search", query])

    # other …  —— 其他筆記(free_notes),不掛在任何題目上
    #
    # 放在 note 之前判斷,因為兩者的字首不同、不會互相吃掉;但順序寫死比較好讀。
    if low == "other" or low.startswith("other ") or low.startswith("other:"):
        rest = raw[len("other") :].lstrip(":").strip()
        if not rest:
            run(["--free-notes"])
        head, sep, text = rest.partition(":")
        head = head.strip()
        text = text.strip()
        if not sep:
            # 沒有冒號 → 只是要讀某一則
            run(["--free", head])
        if not head:
            sys.exit("格式:other <短碼|new>[ replace][ [標題]]: <內容>")
        # head 可能長成:「new」「new [標題]」「<短碼>」「<短碼> replace」
        title = None
        if "[" in head and head.rstrip().endswith("]"):
            pre, _, rest_t = head.partition("[")
            title = rest_t.rstrip().rstrip("]").strip()
            head = pre.strip()
        parts = head.split()
        if not parts:
            sys.exit("格式:other <短碼|new>[ replace][ [標題]]: <內容>")
        ref = parts[0]
        extra: list[str] = []
        for tok in parts[1:]:
            if tok.lower() in ("replace", "覆寫", "--replace"):
                extra = ["--replace"]
            else:
                sys.exit(
                    f"看不懂的參數「{tok}」—— other 只吃 replace,或用 [標題] 指定標題"
                )
        if not text:
            sys.exit("筆記內容是空的,未送出")
        if ref == "new" and extra:
            sys.exit("new 是另開一則,沒有舊內容可覆寫 —— 拿掉 replace")
        argv = ["--free", ref, "--note", "-", *extra]
        if title:
            argv += ["--title", title]
        run(argv, stdin_text=text)

    # note <題號>[ #<編號>|new]: <內容>
    if low.startswith("note ") or low.startswith("note:"):
        rest = raw[len("note") :].lstrip()  # drop leading "note", keep the rest
        head, sep, text = rest.partition(":")
        head = head.strip()
        text = text.strip()
        if not sep or not head:
            sys.exit(
                "格式:note <題號>[ #<筆記編號>|new]: <內容>,"
                "例:note 114-011: TKI 首選… / note 114-011 #2: … / note 114-011 new: …"
            )
        # 一題可以有多則筆記。題號後面不寫東西就是第一則(與從前相同);
        # `#2` 寫進第 2 則,`new` 另開一則。編號在 answer 的輸出裡看得到。
        parts = head.split()
        qid = parts[0]
        where: list[str] = []
        for tok in parts[1:]:
            if tok.lower() == "new":
                where = ["--new"]
            elif tok.startswith("#") and tok[1:].isdigit():
                where = ["--slot", tok[1:]]
            else:
                sys.exit(
                    f"看不懂的筆記位置「{tok}」—— 用 #<編號> 指定某一則,或 new 另開一則"
                )
        if not text:
            sys.exit("筆記內容是空的,未送出")
        # Pass the note body via stdin so quotes / newlines survive intact.
        run([qid, "--note", "-", *where], stdin_text=text)

    # <題號> [answer]
    parts = raw.split()
    qid = parts[0]
    reveal = len(parts) > 1 and parts[1].lower() in REVEAL_TOKENS
    run([qid, "--answer"] if reveal else [qid])


if __name__ == "__main__":
    main()
