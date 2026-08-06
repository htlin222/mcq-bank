#!/usr/bin/env python3
"""
環境自檢。跑法:

    uv run python scripts/doctor.py

檢查三件事,然後打一支心跳讓網頁精靈的 Step 2 亮起來。

心跳的重點不是「套件裝好了沒」—— 那個 import 一下就知道了。重點是**它同時
驗證了金鑰有效與網路可達**。最常見的失敗是 .env 裡的金鑰在下載之後被撤銷過;
沒有這支心跳的話,這個錯誤要拖到整份 PDF 解析完、準備推送時才炸出來。
"""

from __future__ import annotations

import sys
from datetime import datetime

from api import Client, die, load_env


def main() -> int:
    ok = True

    # 1) Python 版本
    if sys.version_info < (3, 11):
        print(f"✗ Python {sys.version_info.major}.{sys.version_info.minor} 太舊,需要 3.11+")
        ok = False
    else:
        print(f"✓ Python {sys.version_info.major}.{sys.version_info.minor}")

    # 2) 相依套件
    try:
        import fitz  # noqa: F401

        print(f"✓ pymupdf {fitz.__doc__.strip().splitlines()[0] if fitz.__doc__ else ''}".rstrip())
    except ImportError:
        print("✗ pymupdf 沒裝 —— 在 skill 資料夾裡跑 `uv sync`")
        ok = False

    # 3) .env
    try:
        env = load_env()
        print(f"✓ .env  ({env['BANK_USER_EMAIL']} → {env['BANK_API_BASE']})")
    except SystemExit:
        return 1

    if not ok:
        print("\n先把上面的問題修掉再跑一次。")
        return 1

    # 4) 心跳 —— 金鑰 + 網路
    print("\n… 連線到伺服器")
    client = Client(env)
    res = client.heartbeat()
    at = datetime.fromtimestamp(res["at"] / 1000).strftime("%H:%M:%S")
    print(f"✓ 金鑰有效,伺服器已在 {at} 收到心跳")
    print("\n✓ ready —— 回網頁精靈,Step 2 應該已經變綠了。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        die(f"{type(e).__name__}: {e}")
