"""
與 hema-2026 匯入暫存區溝通的薄客戶端。

金鑰來自 .env,是網站在下載這個 .skill 時當場烘進去的:

    BANK_API_BASE=https://…
    BANK_API_KEY=bnkk_…
    BANK_USER_EMAIL=…

這把金鑰只寫得到暫存區。它不能發布,也不能改既有題目 —— 發布那一步必須回到
瀏覽器,在 Cloudflare Access 認證過的 session 裡按下去。所以就算這台筆電被
拿走,能造成的最大損害是塞一批髒資料進一個學員看不到的暫存表。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx

SKILL_ROOT = Path(__file__).resolve().parent.parent


def load_env() -> dict[str, str]:
    """讀 skill 根目錄的 .env。不用外部套件,格式很單純。"""
    env: dict[str, str] = {}
    path = SKILL_ROOT / ".env"
    if not path.exists():
        die(
            f"找不到 {path}\n"
            "這個 .skill 應該要帶著一份烘好的 .env。請從網站的「加入新年份」"
            "精靈重新下載一次。"
        )
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()

    missing = [k for k in ("BANK_API_BASE", "BANK_API_KEY", "BANK_USER_EMAIL") if not env.get(k)]
    if missing:
        die(f".env 缺少 {', '.join(missing)} —— 請重新下載 .skill。")
    return env


def die(msg: str) -> None:
    print(f"\n✗ {msg}\n", file=sys.stderr)
    raise SystemExit(1)


class Client:
    def __init__(self, env: dict[str, str] | None = None) -> None:
        self.env = env or load_env()
        self.base = self.env["BANK_API_BASE"].rstrip("/")
        self.email = self.env["BANK_USER_EMAIL"]
        self._http = httpx.Client(
            timeout=60.0,
            headers={
                "Authorization": f"Bearer {self.env['BANK_API_KEY']}",
                "X-User-Email": self.email,
            },
        )

    def _post(self, path: str, **kw) -> dict:
        r = self._http.post(f"{self.base}/api/bank-ingest{path}", **kw)
        if r.status_code == 401:
            die(
                "金鑰無效或已被撤銷。最常見的原因是你在網站上按過「重新產生」,\n"
                "  或者這個 .skill 是別人的帳號下載的。\n"
                "  請回精靈重新下載 bank-ingest.skill,覆蓋掉這個資料夾。"
            )
        if r.status_code == 503:
            die("伺服器尚未設定 BANK_KEY_SECRET,請聯絡站長。")
        if r.status_code >= 400:
            detail = ""
            try:
                detail = r.json().get("error", "")
            except Exception:
                detail = r.text[:300]
            die(f"{path} 回 {r.status_code}: {detail}")
        return r.json()

    # ---- 端點 ------------------------------------------------------------

    def config(self) -> dict:
        r = self._http.get(f"{self.base}/api/bank-ingest/config")
        if r.status_code >= 400:
            die(f"/config 回 {r.status_code}")
        return r.json()

    def heartbeat(self) -> dict:
        """驗證金鑰 + 網路可達,並讓網頁精靈的 Step 2 亮綠燈。"""
        return self._post("/heartbeat")

    def open_job(self, year: int) -> dict:
        return self._post("/jobs", json={"year": year})

    def progress(self, job_id: str, stage: str, detail: str | None = None) -> dict:
        return self._post(f"/jobs/{job_id}/progress", json={"stage": stage, "detail": detail})

    def push_questions(self, job_id: str, questions: list[dict]) -> dict:
        return self._post(f"/jobs/{job_id}/questions", json={"questions": questions})

    def complete(self, job_id: str) -> dict:
        return self._post(f"/jobs/{job_id}/complete")

    def upload_image(self, year: int, data: bytes, mime: str, name: str) -> dict:
        return self._post(
            "/image",
            files={"file": (name, data, mime)},
            data={"year": str(year)},
        )


def env_or_die() -> Client:
    return Client()
