"""解析 `wrangler … --json` 的 stdout。

不能直接 json.loads:wrangler 會在 JSON 前面夾雜給人看的行,而且種類會變。
目前見過的有版本更新提示,以及 4.90 開始的

    Cloudflare agent skills are available for: Claude Code, Cursor, …

後者讓 pnpm db:pull 掛在 "SyntaxError: Unexpected token 'C'" —— 一個跟真正
問題毫無關係的錯誤訊息。這種雜訊未來只會更多,所以剝除它應該是一個地方的事。

以「行」為單位找起點,而不是 str.find("["):文案裡出現一個方括號就會讓字元級
的搜尋切在錯的地方,而 --json 的輸出必定從行首開始。

TypeScript / JS 那邊的對應版本是 scripts/lib/wrangler-json.mjs,行為要一致。
"""

from __future__ import annotations

import json
from typing import Any


class WranglerOutputError(RuntimeError):
    """wrangler 沒有吐出可解析的 JSON。"""


def parse_wrangler_json(stdout: str | bytes, what: str = "wrangler") -> Any:
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", errors="replace")

    lines = stdout.split("\n")
    at = next(
        (i for i, l in enumerate(lines) if l.lstrip()[:1] in ("[", "{")),
        -1,
    )
    if at < 0:
        raise WranglerOutputError(f"{what}:輸出裡找不到 JSON。原始輸出:\n{stdout}")

    try:
        return json.loads("\n".join(lines[at:]))
    except json.JSONDecodeError as err:
        raise WranglerOutputError(
            f"{what}:JSON 解析失敗({err})。原始輸出:\n{stdout}"
        ) from err


def d1_rows(stdout: str | bytes, what: str = "wrangler d1 execute") -> list[dict]:
    """`wrangler d1 execute --json` 的常用形狀:取第一段查詢的 results。

    查無資料回空 list;**但輸出不是 JSON 時會拋** —— 兩者不該長得一樣,
    否則「wrangler 壞了」會被誤讀成「資料庫是空的」。
    """
    payload = parse_wrangler_json(stdout, what)
    try:
        return payload[0]["results"]
    except (IndexError, KeyError, TypeError) as err:
        raise WranglerOutputError(
            f"{what}:JSON 形狀不符(找不到 [0].results):{payload!r}"
        ) from err
