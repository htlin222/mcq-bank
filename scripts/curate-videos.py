#!/usr/bin/env python3
"""
策展 YouTube 教學影片 —— 離線批次,結果寫進 D1 供站上顯示。

主題定義在 scripts/video-topics.json(由 question_tags 正規化而來)。
題目 → 影片的關聯是 question_tags → tag_topics → topic_videos → videos,
所以這裡只處理「主題有哪些影片」,不碰題目。

沒有 YouTube Data API key —— 走 yt-dlp。代價是 YouTube 哪天改版就會壞掉,
但壞掉只影響這支離線腳本,站上既有資料不受影響。

三個階段刻意拆成三個子指令,因為中間那段(相關性把關)是由 Claude Code
派 Haiku subagent 做的,不在這支腳本裡:

    python3 scripts/curate-videos.py search
        → 搜尋 + 過濾 + 補 metadata,產出 data/video-candidates.json
        （可中斷續跑:已有候選的主題預設跳過,--force 才重搜)

    ── 此時由 Claude Code 讀候選、派 Haiku 評分,寫出 data/video-scores.json
       格式:{"<videoId>": {"score": 0-10, "is_teaching": bool, "reason": "..."}}

    python3 scripts/curate-videos.py publish [--remote]
        → 合併評分、每主題取前 8、縮圖上傳 R2、寫入 D1

    python3 scripts/curate-videos.py refresh [--remote]
        → 只重抓既有影片的 metadata,下架的標 status='dead'
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import tomllib
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "scripts" / "data"
TOPICS_FILE = ROOT / "scripts" / "video-topics.json"
CANDIDATES_FILE = DATA / "video-candidates.json"
SCORES_FILE = DATA / "video-scores.json"
# 搜尋與 metadata 各自落地。調門檻是常態(第一版 treatment 設 5 年,
# 結果 28 個主題整個空掉),沒有快取就要為了改一個數字重跑 30 分鐘。
SEARCH_CACHE = DATA / "video-search-cache.json"
META_CACHE = DATA / "video-meta-cache.json"

with (ROOT / "config.toml").open("rb") as _f:
    _CFG = tomllib.load(_f)
D1_DB = _CFG["project"]["d1_db"]
R2_BUCKET = _CFG["project"]["r2_bucket"]

SEARCH_N = 25          # 每主題向 YouTube 要幾筆
CANDIDATE_N = 12       # 補完整 metadata 的候選數(補一支 ~1.5s,別太貪)
KEEP_N = 8             # 最終每主題留幾支
MIN_DURATION = 300     # 5 分鐘 —— 排掉 Shorts 與預告
MAX_DURATION = 2400    # 40 分鐘 —— 排掉整場研討會錄影
MIN_SCORE = 6          # Haiku 相關性門檻

# 年限依主題類別分開:治療會過時,機轉不太會。
#
# 但這是「偏好」不是「硬牆」。第一版把 treatment 當硬牆設 5 年,結果 28 個
# 主題一支都不剩 —— YouTube 上的醫學教學影片絕大多數比這老。所以改成:
# 先收 MAX_AGE_YEARS 以內的,不足 MIN_PER_TOPIC 支才從較舊的池子依觀看數
# 回填,到 HARD_AGE_YEARS 為止。卡片上會顯示年份,舊的自己看得出來。
MAX_AGE_YEARS = {"treatment": 5, "mechanism": 12}
HARD_AGE_YEARS = {"treatment": 10, "mechanism": 18}
MIN_PER_TOPIC = 5

THREADS = 4            # yt-dlp 併發數,再高容易被 YouTube 擋
THUMB_PREFIX = "video-thumbs"


# ---------- yt-dlp ------------------------------------------------------------

def _ytdlp(args: list[str]) -> list[dict]:
    """跑 yt-dlp 並解析 NDJSON。失敗回空 list —— 單一主題掛掉不該中斷整批。"""
    try:
        out = subprocess.run(
            ["yt-dlp", *args, "--dump-json", "--no-warnings", "--ignore-errors"],
            capture_output=True, text=True, timeout=180,
        ).stdout
    except subprocess.TimeoutExpired:
        return []
    rows = []
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def search_topic(query: str) -> list[dict]:
    """flat 搜尋。快(~2s)但沒有上傳日期,所以只拿來初篩。"""
    return _ytdlp([f"ytsearch{SEARCH_N}:{query}", "--flat-playlist"])


def fetch_meta(video_id: str) -> dict | None:
    """單支完整 metadata(~1.5s)。upload_date / description 只有這裡拿得到。"""
    rows = _ytdlp([f"https://www.youtube.com/watch?v={video_id}", "--skip-download"])
    return rows[0] if rows else None


def age_years(upload_date: str | None) -> float | None:
    if not upload_date or len(upload_date) != 8:
        return None
    try:
        d = datetime.strptime(upload_date, "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - d).days / 365.25


# ---------- search ------------------------------------------------------------

def _load(p: Path) -> dict:
    return json.load(p.open()) if p.exists() else {}


def cmd_search(args):
    topics = json.load(TOPICS_FILE.open())["topics"]
    if args.topic:
        topics = [t for t in topics if t["slug"] in args.topic]
        if not topics:
            sys.exit(f"找不到主題:{', '.join(args.topic)}")

    DATA.mkdir(parents=True, exist_ok=True)
    existing = _load(CANDIDATES_FILE)
    search_cache = _load(SEARCH_CACHE)
    meta_cache = _load(META_CACHE)

    todo = [t for t in topics if args.force or t["slug"] not in existing]
    print(f"主題 {len(topics)} 個,待處理 {len(todo)} 個"
          f"(快取:{len(search_cache)} 組搜尋、{len(meta_cache)} 支 metadata)")

    for i, topic in enumerate(todo, 1):
        slug, kind = topic["slug"], topic["kind"]

        hits = search_cache.get(slug)
        if hits is None or args.refetch:
            hits = search_topic(topic["query"])
            search_cache[slug] = hits
            SEARCH_CACHE.write_text(json.dumps(search_cache, ensure_ascii=False),
                                    encoding="utf-8")

        # 先用 flat 結果篩時長、排觀看數 —— 補 metadata 很貴,少補一支省 1.5 秒
        pool = [
            h for h in hits
            if h.get("id") and h.get("duration")
            and MIN_DURATION <= h["duration"] <= MAX_DURATION
        ]
        pool.sort(key=lambda h: h.get("view_count") or 0, reverse=True)
        pool = pool[:CANDIDATE_N]

        need = [h["id"] for h in pool
                if h["id"] not in meta_cache or args.refetch]
        if need:
            with ThreadPoolExecutor(max_workers=THREADS) as ex:
                for vid, meta in zip(need, ex.map(fetch_meta, need)):
                    meta_cache[vid] = meta
            META_CACHE.write_text(json.dumps(meta_cache, ensure_ascii=False),
                                  encoding="utf-8")

        fresh, stale = [], []
        for h in pool:
            m = meta_cache.get(h["id"])
            if not m or m.get("availability") not in (None, "public"):
                continue
            yrs = age_years(m.get("upload_date"))
            if yrs is not None and yrs > HARD_AGE_YEARS[kind]:
                continue
            row = {
                "id": m["id"],
                "title": m.get("title") or "",
                "channel": m.get("channel") or m.get("uploader") or "",
                "channel_id": m.get("channel_id"),
                "duration_s": int(m.get("duration") or 0),
                "view_count": int(m.get("view_count") or 0),
                "upload_date": m.get("upload_date"),
                "subscribers": m.get("channel_follower_count"),
                # 描述截斷:評分只看得到前面這段,存全文只是讓 JSON 變胖
                "desc": (m.get("description") or "")[:500],
            }
            (fresh if yrs is None or yrs <= MAX_AGE_YEARS[kind] else stale).append(row)

        # 回填按觀看數 —— 既然已經比偏好年限舊了,至少挑多數人看過的那幾支
        stale.sort(key=lambda r: r["view_count"], reverse=True)
        kept = fresh + stale[: max(0, MIN_PER_TOPIC - len(fresh))]

        existing[slug] = kept
        CANDIDATES_FILE.write_text(
            json.dumps(existing, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        print(f"[{i}/{len(todo)}] {slug:26s} 搜到 {len(hits):2d} → "
              f"候選 {len(pool):2d} → 留 {len(kept):2d}"
              f"(新 {len(fresh)} + 回填 {len(kept) - len(fresh)})")

    total = sum(len(v) for v in existing.values())
    print(f"\n候選共 {total} 支(去重後 "
          f"{len({v['id'] for vs in existing.values() for v in vs})} 支)"
          f" → {CANDIDATES_FILE.relative_to(ROOT)}")


# ---------- publish -----------------------------------------------------------

def sq(v) -> str:
    """SQL 字面值。None → NULL,字串跳脫單引號。"""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def upload_thumb(video_id: str, remote: bool) -> str | None:
    """hqdefault.jpg → R2。已存在就跳過(R2 put 是冪等的,但省一趟網路)。"""
    key = f"{THUMB_PREFIX}/{video_id}.jpg"
    url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            blob = r.read()
    except Exception:
        return None
    if len(blob) < 1024:          # YouTube 對不存在的縮圖回一張灰底小圖
        return None

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(blob)
        tmp_path = tmp.name
    cmd = ["wrangler", "r2", "object", "put", f"{R2_BUCKET}/{key}",
           "--file", tmp_path, "--content-type", "image/jpeg"]
    cmd.append("--remote" if remote else "--local")
    r = subprocess.run(cmd, capture_output=True, text=True)
    Path(tmp_path).unlink(missing_ok=True)
    if r.returncode != 0:
        print(f"  ! 縮圖上傳失敗 {video_id}: {r.stderr.strip()[:120]}", file=sys.stderr)
        return None
    return key


def run_sql(statements: list[str], remote: bool, chunk: int = 40):
    """分批送 —— 單次 wrangler 呼叫塞太多 statement 會超時。"""
    flag = "--remote" if remote else "--local"
    for i in range(0, len(statements), chunk):
        batch = statements[i:i + chunk]
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False,
                                         encoding="utf-8") as f:
            f.write(";\n".join(batch) + ";\n")
            path = f.name
        r = subprocess.run(
            ["wrangler", "d1", "execute", D1_DB, flag, "--file", path, "--yes"],
            capture_output=True, text=True,
        )
        Path(path).unlink(missing_ok=True)
        if r.returncode != 0:
            sys.exit(f"D1 寫入失敗(第 {i // chunk + 1} 批):{r.stderr[-800:]}")
        print(f"  寫入 {min(i + chunk, len(statements))}/{len(statements)} 句")


def cmd_publish(args):
    topics = json.load(TOPICS_FILE.open())["topics"]
    if not CANDIDATES_FILE.exists():
        sys.exit("沒有候選檔,先跑 search")
    candidates = json.load(CANDIDATES_FILE.open())
    scores = json.load(SCORES_FILE.open()) if SCORES_FILE.exists() else {}
    if not scores:
        print("! 沒有 video-scores.json —— 未經相關性把關,全部照收", file=sys.stderr)

    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    chosen: dict[str, dict] = {}      # video_id → video row
    links: list[tuple[str, str, int]] = []
    dropped = 0

    for topic in topics:
        rows = candidates.get(topic["slug"], [])
        ranked = []
        for v in rows:
            s = scores.get(v["id"])
            if s is not None:
                if not s.get("is_teaching", True) or (s.get("score") or 0) < MIN_SCORE:
                    dropped += 1
                    continue
            ranked.append((s.get("score") if s else None, v))
        # 先 AI 分數後觀看數 —— 分數相同時讓看的人多的排前面
        ranked.sort(key=lambda p: (p[0] or 0, p[1]["view_count"]), reverse=True)

        for rank, (score, v) in enumerate(ranked[:KEEP_N], 1):
            s = scores.get(v["id"]) or {}
            prev = chosen.get(v["id"])
            # 同一支影片可能被多個主題選中,保留分數較高的那次評語
            if not prev or (s.get("score") or 0) > (prev["ai_score"] or 0):
                chosen[v["id"]] = {**v, "ai_score": s.get("score"),
                                   "ai_reason": s.get("reason")}
            links.append((topic["slug"], v["id"], rank))

    print(f"選中 {len(chosen)} 支影片、{len(links)} 組主題關聯"
          f"(相關性刷掉 {dropped} 支)")

    print("上傳縮圖到 R2…")
    ids = list(chosen)
    with ThreadPoolExecutor(max_workers=THREADS) as ex:
        keys = list(ex.map(lambda v: upload_thumb(v, args.remote), ids))
    for vid, key in zip(ids, keys):
        chosen[vid]["thumb_key"] = key
    print(f"  {sum(1 for k in keys if k)}/{len(ids)} 支有縮圖")

    stmts: list[str] = []
    for t in topics:
        stmts.append(
            "INSERT INTO video_topics (slug,label,kind,query,created_at) VALUES ("
            f"{sq(t['slug'])},{sq(t['label'])},{sq(t['kind'])},{sq(t['query'])},{now})"
            " ON CONFLICT(slug) DO UPDATE SET label=excluded.label,"
            " kind=excluded.kind, query=excluded.query"
        )
        for tag in t["tags"]:
            stmts.append(
                "INSERT OR IGNORE INTO tag_topics (tag,topic_slug) VALUES "
                f"({sq(tag)},{sq(t['slug'])})"
            )

    for v in chosen.values():
        stmts.append(
            "INSERT INTO videos (id,title,channel,channel_id,duration_s,view_count,"
            "upload_date,thumb_key,ai_score,ai_reason,refreshed_at,created_at) VALUES ("
            f"{sq(v['id'])},{sq(v['title'])},{sq(v['channel'])},{sq(v.get('channel_id'))},"
            f"{v['duration_s']},{v['view_count']},{sq(v.get('upload_date'))},"
            f"{sq(v.get('thumb_key'))},{sq(v.get('ai_score'))},{sq(v.get('ai_reason'))},"
            f"{now},{now})"
            # 重跑只更新會變的欄位。status 刻意不碰 —— 使用者刪掉的影片
            # 不該因為重跑策展就復活。
            " ON CONFLICT(id) DO UPDATE SET title=excluded.title,"
            " view_count=excluded.view_count, thumb_key=COALESCE(excluded.thumb_key,"
            " videos.thumb_key), ai_score=excluded.ai_score,"
            " ai_reason=excluded.ai_reason, refreshed_at=excluded.refreshed_at"
        )

    for slug, vid, rank in links:
        stmts.append(
            f"INSERT INTO topic_videos (topic_slug,video_id,rank) VALUES "
            f"({sq(slug)},{sq(vid)},{rank})"
            " ON CONFLICT(topic_slug,video_id) DO UPDATE SET rank=excluded.rank"
        )

    if args.dry_run:
        print(f"\n--dry-run:{len(stmts)} 句 SQL 未執行。前 3 句:")
        for s in stmts[:3]:
            print("  " + s[:160])
        return

    print(f"寫入 D1({'remote' if args.remote else 'local'})…")
    run_sql(stmts, args.remote)
    print("完成")


# ---------- refresh -----------------------------------------------------------

def d1_query(sql: str, remote: bool) -> list[dict]:
    flag = "--remote" if remote else "--local"
    r = subprocess.run(
        ["wrangler", "d1", "execute", D1_DB, flag, "--command", sql, "--json"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"D1 查詢失敗:{r.stderr[-500:]}")
    m = re.search(r"\[\s*\{", r.stdout)
    if not m:
        return []
    return json.loads(r.stdout[m.start():])[0]["results"]


def cmd_refresh(args):
    rows = d1_query("SELECT id FROM videos WHERE status != 'removed'", args.remote)
    ids = [r["id"] for r in rows]
    print(f"重抓 {len(ids)} 支影片的 metadata…")

    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    with ThreadPoolExecutor(max_workers=THREADS) as ex:
        metas = list(ex.map(fetch_meta, ids))

    stmts, dead = [], 0
    for vid, m in zip(ids, metas):
        # 抓不到或非公開 = 來源已消失。標 dead 而不刪 —— 留著才知道
        # 這個主題曾經有過什麼,也才知道要不要補搜。
        if not m or m.get("availability") not in (None, "public"):
            dead += 1
            stmts.append(
                f"UPDATE videos SET status='dead', refreshed_at={now} WHERE id={sq(vid)}"
            )
            continue
        stmts.append(
            f"UPDATE videos SET view_count={int(m.get('view_count') or 0)},"
            f" title={sq(m.get('title') or '')}, status='ok', refreshed_at={now}"
            f" WHERE id={sq(vid)} AND status != 'removed'"
        )
    print(f"  {dead} 支已下架 → status='dead'")

    if args.dry_run:
        print(f"--dry-run:{len(stmts)} 句 SQL 未執行")
        return
    run_sql(stmts, args.remote)
    print("完成")


# ---------- main --------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search", help="搜尋 + 過濾,產出候選")
    s.add_argument("--force", action="store_true",
                   help="已有候選的主題也重算(有快取時很快,適合調門檻)")
    s.add_argument("--refetch", action="store_true",
                   help="連快取一起重抓 —— 真的重打 YouTube,慢")
    s.add_argument("--topic", nargs="*", help="只跑指定主題 slug")
    s.set_defaults(func=cmd_search)

    p = sub.add_parser("publish", help="合併評分 → 縮圖 → 寫入 D1")
    p.add_argument("--remote", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_publish)

    r = sub.add_parser("refresh", help="重抓既有影片 metadata")
    r.add_argument("--remote", action="store_true")
    r.add_argument("--dry-run", action="store_true")
    r.set_defaults(func=cmd_refresh)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
