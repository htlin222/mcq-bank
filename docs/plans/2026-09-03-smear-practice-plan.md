# 抹片練習 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 hema-2026 加一個獨立的「抹片練習」功能 —— 看圖、把診斷**拼寫**出來、
判分、檢討,跟現有 MCQ 題庫完全分開。

**Architecture:** 離線 pipeline 把 4 份考古題投影片 + ASH Image Bank 建成
`smear_dx` / `smear_terms` / `smear_questions` 三張表(alias 與詳解掛「診斷」
不掛「題目」);判定與抽題是**純函式**;Worker 只是薄薄一層 CRUD;前端在
`/smear` 一條路由底下分四個分頁。

**Tech Stack:** Python 3.11 + PyMuPDF(pipeline)、Cloudflare D1 / R2、
Hono(Worker)、React 18 + Vite + TailwindCSS、`node --test`(純函式)、
Playwright WebKit(e2e)。

**設計文件:** `docs/plans/2026-09-03-smear-practice-design.md` —— **動手前先讀完**,
這份 plan 不重複那裡的理由。

**分支:** `feat/smear-practice`(已建立,設計文件已 commit)

---

## 名詞對照(整份 plan 一致)

| 詞 | 意思 |
| --- | --- |
| **dx** | 一個診斷(`dacrocyte`、`AML`)。alias 與詳解掛在這一層 |
| **question** | 一張圖。多張圖可以共用同一個 dx |
| **term** | 一個可接受的寫法,帶 tier(`full` / `half` / `lay`) |
| **tier** | `full` 全對 1 分 / `half` 半對 0.5 分 / `lay` 俗名 0 分但明講正解 |
| **form** | `long` 全稱 / `abbrev` 縮寫 —— 決定開場 dialog 選哪一種時畫幾格 |

`topic` 七類固定值:
`myeloid` / `lymphoid` / `normal_reactive` / `rbc` / `platelet` / `infection` / `other`

---

# Phase A —— 題庫 pipeline(離線)

## Task A1: 答案卷解析 + deck↔key 對應驗證

**Files:**
- Create: `scripts/smear/parse_answers.py`
- Create: `scripts/smear/test_parse_answers.py`

**Step 1: 寫失敗的測試**

```python
# scripts/smear/test_parse_answers.py
import unittest
from parse_answers import parse_answer_key, DECK_MAP

class TestParseAnswerKey(unittest.TestCase):
    def test_plain_line(self):
        rows = parse_answer_key("1. AMoL\n2. MM\n")
        self.assertEqual(rows[0], {"n": 1, "raw": "AMoL", "main": "AMoL",
                                   "alts": [], "half": []})

    def test_parenthetical_alternates(self):
        rows = parse_answer_key("3. Pronormoblast (proerythroblast)\n")
        self.assertEqual(rows[0]["main"], "Pronormoblast")
        self.assertEqual(rows[0]["alts"], ["proerythroblast"])

    def test_half_marker_is_not_an_alternate(self):
        # 「半對」是分級,不是同義詞 —— 混進 alts 會讓 Plasma cell 拿滿分
        rows = parse_answer_key("9. Plasmoblast (Plasma cell 半對)\n")
        self.assertEqual(rows[0]["main"], "Plasmoblast")
        self.assertEqual(rows[0]["alts"], [])
        self.assertEqual(rows[0]["half"], ["Plasma cell"])

    def test_comma_inside_parens_splits(self):
        rows = parse_answer_key("42. MAHA (Hemolysis, DIC)\n")
        self.assertEqual(rows[0]["alts"], ["Hemolysis", "DIC"])

    def test_comma_outside_parens_does_not_split(self):
        # 「AML, M4」是一個答案,不是兩個
        rows = parse_answer_key("43. AML, M4\n")
        self.assertEqual(rows[0]["main"], "AML, M4")

    def test_ignores_header_line(self):
        rows = parse_answer_key("[Test 1 ANS]\n\n1. AMoL\n")
        self.assertEqual(len(rows), 1)

if __name__ == "__main__":
    unittest.main()
```

**Step 2: 跑測試確認它紅**

```bash
cd scripts/smear && python3 -m unittest test_parse_answers -v
```
Expected: `ModuleNotFoundError: No module named 'parse_answers'`

**Step 3: 實作**

`scripts/smear/parse_answers.py`:

```python
"""解析 Test-N-ANS.pdf 的文字層。

⚠️ 括號裡的東西有兩種語意,不能混為一談:
      Pronormoblast (proerythroblast)     → 同義詞,全對
      Plasmoblast (Plasma cell 半對)      → 半對
   混進同一個桶子的話 Plasma cell 會拿滿分,而那正是答案卷刻意要扣的那半分。

⚠️ 逗號也有兩種語意,靠「在不在括號內」區分:
      MAHA (Hemolysis, DIC)  → 括號內,是兩個同義詞
      AML, M4                → 括號外,是同一個答案的一部分
"""
import re

HALF_MARK = "半對"
LINE_RE = re.compile(r"^\s*(\d+)\s*[.、]\s*(.+?)\s*$")

DECK_MAP = {
    "Test-1-ANS.pdf": "pre-test-A-2026.pdf",
    "Test-2-ANS.pdf": "pre-test-2.pdf",
    "Test-3-ANS.pdf": "wk-11-test.pdf",
    "Test-4-ANS.pdf": "week12.pdf",
}


def parse_answer_key(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        n, raw = int(m.group(1)), m.group(2).strip()
        main, alts, half = _split(raw)
        rows.append({"n": n, "raw": raw, "main": main, "alts": alts, "half": half})
    return rows


def _split(raw: str) -> tuple[str, list[str], list[str]]:
    alts: list[str] = []
    half: list[str] = []

    def take(m: re.Match) -> str:
        inner = m.group(1).strip()
        for part in [p.strip() for p in inner.split(",") if p.strip()]:
            if HALF_MARK in part:
                cleaned = part.replace(HALF_MARK, "").strip()
                if cleaned:
                    half.append(cleaned)
            else:
                alts.append(part)
        return ""

    main = re.sub(r"\(([^)]*)\)", take, raw).strip()
    main = re.sub(r"\s{2,}", " ", main).strip(" ,;")
    return main, alts, half
```

**Step 4: 跑測試確認它綠**

```bash
cd scripts/smear && python3 -m unittest test_parse_answers -v
```
Expected: `OK (6 tests)`

**Step 5: 驗證 deck↔key 對應(這一步不是測試,是人工確認)**

⚠️ **`DECK_MAP` 是猜的 —— 只靠題數對得上。對錯位一格之後每一題都錯,而症狀是
「答案看起來都很像但就是不對」。** 用錨點題驗證:

```bash
cd "/Users/htlin/Dropbox/血專大補丁/抹片考訊"
# Test-3 #18 是 203 題裡唯一的 A/B 雙標題
pdftotext -layout Test-3-ANS.pdf - | grep -n "A = lymphocytes"
# wk-11-test 也只有一頁寫 A and B —— 那一頁必須是第 18 頁
python3 -c "
import fitz
d = fitz.open('wk-11-test.pdf')
for i, p in enumerate(d, 1):
    if 'A and B' in p.get_text():
        print('A/B 在第', i, '頁')
"
```
Expected: `A/B 在第 18 頁`。**不是 18 就停下來重新配對,不要往下做。**
其餘三份用同樣手法各找一個獨特特徵確認(Test-1 #52「Cancer nests」、
Test-4 #51「Osteoclast」、Test-2 #1「Bernard Soulier」)。

**Step 6: Commit**

```bash
git add scripts/smear/parse_answers.py scripts/smear/test_parse_answers.py
git commit -m "feat(smear): 答案卷解析 —— 括號的兩種語意分開收

Pronormoblast (proerythroblast) 是同義詞,Plasmoblast (Plasma cell 半對)
是半對。混進同一個桶子的話 Plasma cell 會拿滿分,而那正是答案卷刻意要扣
的那半分。逗號靠「在不在括號內」區分:AML, M4 是一個答案。"
```

---

## Task A2: 投影片頁面 render → WebP

**Files:**
- Create: `scripts/smear/render_pages.py`
- Create: `scripts/smear/test_render_pages.py`

**Step 1: 寫失敗的測試**(只測純函式部分 —— trim 邊界)

```python
# scripts/smear/test_render_pages.py
import unittest
from render_pages import trim_box

class TestTrimBox(unittest.TestCase):
    def test_all_white_returns_none(self):
        # 全白的頁不該裁成 0×0 —— 回 None,呼叫端保留原圖
        self.assertIsNone(trim_box([[255] * 10 for _ in range(10)], 250))

    def test_finds_content_bounds(self):
        px = [[255] * 10 for _ in range(10)]
        px[3][4] = 0
        px[6][7] = 0
        self.assertEqual(trim_box(px, 250), (4, 3, 8, 7))  # l, t, r, b (exclusive)

    def test_pads_by_margin(self):
        px = [[255] * 10 for _ in range(10)]
        px[5][5] = 0
        self.assertEqual(trim_box(px, 250, margin=2), (3, 3, 8, 8))

    def test_margin_clamped_to_image(self):
        px = [[255] * 4 for _ in range(4)]
        px[0][0] = 0
        self.assertEqual(trim_box(px, 250, margin=3), (0, 0, 4, 4))

if __name__ == "__main__":
    unittest.main()
```

**Step 2: 跑測試確認它紅**

```bash
cd scripts/smear && python3 -m unittest test_render_pages -v
```

**Step 3: 實作**

`scripts/smear/render_pages.py` —— `trim_box()` 是純函式,render 用 PyMuPDF:

```python
"""投影片每頁 → 兩張 WebP。

整頁 render 而不是 pdfimages 抽單張:箭頭、A/B 標記、多圖並列都是畫在投影片
上的,抽單張會把它們丟掉,而那幾題就無解了。代價是白邊 —— 所以 trim。

存兩份:
  view  長邊 1600  預設顯示
  full  長邊 2400  點開放大(顯微鏡細節在 1600 下看不清)
"""
import fitz  # PyMuPDF

DPI = 300


def trim_box(rows, threshold, margin=8):
    """rows: 灰階像素二維陣列(row-major)。回 (l, t, r, b) 或 None。"""
    h = len(rows)
    w = len(rows[0]) if h else 0
    top = bottom = left = right = None
    for y in range(h):
        for x in range(w):
            if rows[y][x] < threshold:
                if top is None:
                    top = y
                bottom = y
                left = x if left is None else min(left, x)
                right = x if right is None else max(right, x)
    if top is None:
        return None
    return (
        max(0, left - margin),
        max(0, top - margin),
        min(w, right + 1 + margin),
        min(h, bottom + 1 + margin),
    )
```

render 的部分照 PyMuPDF 官方 API 寫(`page.get_pixmap(dpi=DPI)` →
`pix.samples` → PIL → `Image.convert("L")` 取灰階做 trim → 原圖裁切 → 縮到
長邊 1600 / 2400 → `save(..., "WEBP", quality=82)`)。

⚠️ **trim 的門檻用 250 不是 254。** 投影片背景常帶極淡的底紋,254 會讓
`trim_box` 認為整頁都有內容而完全不裁。實際跑一次看輸出尺寸有沒有真的變小。

**Step 4: 跑測試 + 實際 render 一份確認**

```bash
cd scripts/smear && python3 -m unittest test_render_pages -v
python3 render_pages.py --deck "/Users/htlin/Dropbox/血專大補丁/抹片考訊/wk-11-test.pdf" \
  --out /tmp/smear-render --limit 3
open /tmp/smear-render/wk-11-test-018-view.webp   # 肉眼確認:是不是第 18 頁、A/B 標記在不在
```

**Step 5: Commit**

---

## Task A3: 術語正規化(subagent)

**Files:**
- Create: `scripts/smear/data/dx.json`(產出物,進 git)
- Create: `scripts/smear/normalize_prompt.md`(給 subagent 的指示,進 git)

**Step 1: 產一份輸入**

```bash
cd scripts/smear && python3 -c "
from parse_answers import parse_answer_key, DECK_MAP
import fitz, json, pathlib
base = pathlib.Path('/Users/htlin/Dropbox/血專大補丁/抹片考訊')
out = []
for key in DECK_MAP:
    txt = ''.join(p.get_text() for p in fitz.open(base / key))
    for r in parse_answer_key(txt):
        out.append({'key': key, **r})
json.dump(out, open('data/raw-answers.json','w'), ensure_ascii=False, indent=1)
print(len(out))
"
```
Expected: `203`

**Step 2: 交給 subagent**

用 `Agent` 工具(`general-purpose`),一次處理約 40 題、分 5 個平行 agent。
prompt 骨架寫進 `scripts/smear/normalize_prompt.md`,要求每題輸出:

```json
{
  "raw": "Teardrop RBC",
  "dx_id": "dacrocyte",
  "canonical_long": "dacrocyte",
  "canonical_abbrev": null,
  "topic": "rbc",
  "qtype": "cell",
  "terms": [
    {"text": "dacrocyte",   "tier": "full", "form": "long"},
    {"text": "dacryocyte",  "tier": "full", "form": "long"},
    {"text": "teardrop cell","tier": "lay", "form": "long"},
    {"text": "tear drop",   "tier": "lay", "form": "long"}
  ]
}
```

⚠️ **prompt 裡必須明講三件事,否則產出會不能用:**
1. **`dx_id` 要合併同義題** —— `AML`、`AML, M2`、`AML, M4` 是**不同**的 dx
   (考卷分得出來),但 `APML` 與 `APL` 是同一個。合併錯的症狀是抽題比例算錯。
2. **俗名(`lay`)要真的標出來**,不要圖省事全丟 `full`。這一層是整個功能跟
   「隨便一個填空題」的差別。
3. **`canonical_abbrev` 沒有就是 `null`**,不要硬造(`Mitosis` 沒有縮寫)。

**Step 3: 人工抽驗**

```bash
python3 -c "
import json,collections
d=json.load(open('data/dx.json'))
print('dx 數:', len({x['dx_id'] for x in d}))
print('topic 分佈:', collections.Counter(x['topic'] for x in d))
print('沒有任何 lay 的比例:', sum(1 for x in d if not any(t['tier']=='lay' for t in x['terms']))/len(d))
"
```
⚠️ **「沒有任何 lay 的比例」超過 0.9 表示 subagent 沒認真標俗名,退回重跑。**

**Step 4: Commit**

---

## Task A4: ASH 補充題對應(subagent)

**Files:**
- Create: `scripts/smear/data/ash-map.json`

對每個 distinct `dx_id`,從 `~/ash-image-bank/data/index.jsonl`(6973 列,
帶 `title` 與 WHO `category`)挑**最多 3 張**同診斷的圖。

⚠️ **挑不到就是挑不到,寫 `[]`。** 硬湊一張「看起來有點像」的圖,使用者答錯時
會以為是自己判讀錯 —— 那比少三張圖糟得多。

⚠️ **`image_number` 要逐字照抄 `index.jsonl`,不准編造。** 匯入時驗證每一個 id
都真的在 index 裡(同 `lecture_page_questions` 回填那次的作法)。

**驗證:**
```bash
python3 -c "
import json
idx={json.loads(l)['id'] for l in open('/Users/htlin/ash-image-bank/data/index.jsonl')}
m=json.load(open('data/ash-map.json'))
bad=[i for v in m.values() for i in v if i not in idx]
print('編造的 id:', bad)          # 必須是 []
print('總補充張數:', sum(len(v) for v in m.values()))
"
```

---

## Task A5: 詳解初稿(subagent)

**Files:**
- Create: `scripts/smear/data/dx-notes.json`
- Create: `scripts/smear/note_prompt.md`

照設計文件「詳解」那節的**固定骨架**產出(一句話 / 怎麼認 / 容易混淆的 /
臨床脈絡 / 拼字提醒),存成 TipTap JSON。

⚠️ **「容易混淆的」那一段提到別的診斷時要輸出 `dx_id`,不是只有名字** ——
匯入時才連得成 `/smear/dx/<id>` 的連結。

⚠️ **不要在 runtime 叫 Workers AI 產詳解。** 這是一次性離線工作,放進請求路徑
等於把免費額度燒在每一次瀏覽上。

---

## Task A6: migration 0043 + 匯入腳本

**Files:**
- Create: `migrations/0043_smear.sql`
- Create: `scripts/smear/import.ts`
- Modify: `package.json`(加 `smear:import` script)

**Step 1: 寫 migration**

`migrations/0043_smear.sql`:

```sql
-- ============================================================
-- Migration 0043: 抹片練習
--
-- 設計:docs/plans/2026-09-03-smear-practice-design.md
--
-- ⚠️ alias 與詳解掛「診斷」(smear_dx)不掛「題目」(smear_questions)。
--    同一個 dacrocyte 有考古題 1 張 + ASH 3 張 = 4 題;alias 掛題目的話,
--    新增一個「dacryocyte 也算對」要改 4 筆,而漏改的那一筆症狀是
--    「同一個答案,這張圖算我對、那張圖算我錯」—— 沒有人回報得清楚。
--
-- ⚠️ 作答記錄不進 attempts。attempts.question_id 有 FK 指向 questions,
--    而抹片題不在那張表裡;動那個 FK 等於讓 attempts 的每一條既有查詢
--    都要多想一次。
-- ============================================================

CREATE TABLE smear_dx (
  id               TEXT PRIMARY KEY,     -- slug, e.g. 'dacrocyte'
  canonical_long   TEXT NOT NULL,
  canonical_abbrev TEXT,                 -- 沒有就是 NULL,不硬造
  topic            TEXT NOT NULL,        -- myeloid|lymphoid|normal_reactive|rbc|platelet|infection|other
  qtype            TEXT NOT NULL,        -- cell|disease
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_smear_dx_topic ON smear_dx(topic);

-- 一列 = 一個可接受的寫法。status 同時是提報流程的狀態機:
--   accepted  判定時採用
--   open      投票中,判定時不採用
--   rejected  墓碑 —— 不能刪列,否則同一個詞會被反覆提報
CREATE TABLE smear_terms (
  id          TEXT PRIMARY KEY,
  dx_id       TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,             -- 原樣,顯示用
  norm        TEXT NOT NULL,             -- normalizeTerm(text),比對用
  tier        TEXT NOT NULL,             -- full|half|lay
  form        TEXT NOT NULL,             -- long|abbrev
  status      TEXT NOT NULL,             -- accepted|open|rejected
  rationale   TEXT,
  proposed_by TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
-- 墓碑靠這個唯一鍵擋住重複提報。
CREATE UNIQUE INDEX idx_smear_terms_uniq ON smear_terms(dx_id, norm);
CREATE INDEX idx_smear_terms_dx ON smear_terms(dx_id, status);

CREATE TABLE smear_term_votes (
  term_id     TEXT NOT NULL REFERENCES smear_terms(id) ON DELETE CASCADE,
  voter_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  agree       INTEGER NOT NULL,          -- 1|0
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (term_id, voter_email)
);

CREATE TABLE smear_questions (
  id             TEXT PRIMARY KEY,       -- 'exam-t3-018' / 'ash-66486'
  dx_id          TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  source         TEXT NOT NULL,          -- exam|ash|po
  source_ref     TEXT,                   -- deck+page / ASH image id
  source_url     TEXT,
  attribution    TEXT,
  image_key_view TEXT NOT NULL,          -- R2 key,長邊 1600
  image_key_full TEXT NOT NULL,          -- R2 key,長邊 2400
  prompt         TEXT,                   -- 'What disease?' / 'What cell?'
  image_note     TEXT,                   -- 箭頭 / A-B 說明(這張圖的事,不是這個診斷的事)
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_smear_q_dx ON smear_questions(dx_id);
CREATE INDEX idx_smear_q_source ON smear_questions(source);

-- 共筆詳解,一個 dx 一份。鎖的形狀同 explanations。
CREATE TABLE smear_dx_notes (
  dx_id         TEXT PRIMARY KEY REFERENCES smear_dx(id) ON DELETE CASCADE,
  content_json  TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  updated_by    TEXT,
  updated_at    INTEGER NOT NULL,
  editing_by    TEXT,
  editing_until INTEGER
);

CREATE TABLE smear_sessions (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  mode         TEXT NOT NULL,            -- review|exam
  config_json  TEXT NOT NULL,            -- {n, form, topics[], sources[], limitSec}
  question_ids TEXT NOT NULL,            -- JSON array —— 抽好就固定,重整不重抽
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  score        REAL,
  max_score    REAL,
  spelling_ok  INTEGER,                  -- 拼字完全正確的題數
  lay_count    INTEGER                   -- 用了俗名的題數
);
CREATE INDEX idx_smear_sess_user ON smear_sessions(user_email, started_at DESC);

CREATE TABLE smear_answers (
  session_id           TEXT NOT NULL REFERENCES smear_sessions(id) ON DELETE CASCADE,
  question_id          TEXT NOT NULL REFERENCES smear_questions(id) ON DELETE CASCADE,
  idx                  INTEGER NOT NULL,
  typed_json           TEXT NOT NULL,    -- 格子陣列
  tier                 TEXT,             -- full|half|lay|miss
  score                REAL,
  spelling_errors_json TEXT,
  hint_used            TEXT,             -- NULL | 'initial,topic' 之類
  answered_at          INTEGER,
  PRIMARY KEY (session_id, question_id)
);

-- 搜尋跟 MCQ 完全分開,自己一份索引。
CREATE VIRTUAL TABLE smear_fts USING fts5(
  dx_id UNINDEXED, canonical, terms, topic, note, tokenize='unicode61'
);
```

**Step 2: 套到 local**

```bash
pnpm db:migrate:local
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local \
  --command "SELECT name FROM sqlite_master WHERE name LIKE 'smear%' ORDER BY name"
```
Expected: 8 張表 + `smear_fts` 的內部表

**Step 3: 寫匯入腳本**

`scripts/smear/import.ts`(`node --experimental-strip-types`):
讀 `data/dx.json` / `data/ash-map.json` / `data/dx-notes.json`,
把 WebP 上傳 R2、把列寫進 D1、同步 `smear_fts`。

⚠️ **`norm` 欄位由 TypeScript 的 `normalizeTerm()` 算(Task B1 產出的那一支),
不要在 Python 端再實作一次。** 兩份正規化實作遲早會分岔,而分岔的症狀是
「某個寫法在搜尋找得到,作答卻判錯」。

⚠️ **匯入是 delete-then-insert per source**,冪等。之後只加 ASH 補充圖時可以
只重跑那一段。

**Step 4: 跑一次 + 驗證**

```bash
pnpm smear:import --local
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --local --command "
  SELECT source, COUNT(*) FROM smear_questions GROUP BY source;
  SELECT topic, COUNT(*) FROM smear_dx GROUP BY topic;
  SELECT tier, COUNT(*) FROM smear_terms GROUP BY tier;"
```
⚠️ **`SELECT COUNT(*)` 一定要跑。** `lecture_page_questions` 那次就是 migration
跑過了、route 寫好了、前端做好了,而表整張是空的 —— 症狀是「這一頁都沒有東西」,
查很久才發現回填從沒執行過。

**Step 5: Commit**

---

# Phase B —— 判定與抽題(純函式,TDD)

## Task B1: `normalizeTerm()` + `gradeSmear()`

**Files:**
- Create: `worker/lib/smear-grade.ts`
- Create: `worker/lib/smear-grade.test.ts`

**Step 1: 寫失敗的測試**

```ts
// worker/lib/smear-grade.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTerm, gradeSmear, type AcceptedTerm } from './smear-grade.ts';

const DACRO: AcceptedTerm[] = [
  { text: 'dacrocyte', tier: 'full' },
  { text: 'dacryocyte', tier: 'full' },
  { text: 'poikilocytosis', tier: 'half' },
  { text: 'tear drop', tier: 'lay' },
  { text: 'teardrop RBC', tier: 'lay' },
];

test('normalize 去變音符', () => {
  assert.equal(normalizeTerm('Döhle body'), 'dohle body');
  assert.equal(normalizeTerm('Pelger-Huët'), 'pelger huet');
});

test('normalize 去撇號與連字號', () => {
  assert.equal(normalizeTerm("Gaucher's disease"), 'gauchers disease');
  assert.equal(normalizeTerm('May-Hegglin'), 'may hegglin');
});

test('全對', () => {
  const g = gradeSmear(['Dacrocyte'], DACRO);
  assert.equal(g.tier, 'full');
  assert.equal(g.score, 1);
  assert.deepEqual(g.spellingErrors, []);
});

test('半對', () => {
  assert.equal(gradeSmear(['poikilocytosis'], DACRO).score, 0.5);
});

test('俗名 0 分,但 tier 是 lay 不是 miss', () => {
  const g = gradeSmear(['tear', 'drop'], DACRO);
  assert.equal(g.tier, 'lay');
  assert.equal(g.score, 0);
  assert.equal(g.canonical, 'dacrocyte');   // 要能明講正解
});

test('完全不會是 miss,不是 lay', () => {
  assert.equal(gradeSmear(['schistocyte'], DACRO).tier, 'miss');
});

test('tier 順序:full 先於 lay', () => {
  // 一個詞同時像兩層時,寬鬆的那層不准先吃掉
  const terms: AcceptedTerm[] = [
    { text: 'target cell', tier: 'lay' },
    { text: 'codocyte', tier: 'full' },
  ];
  assert.equal(gradeSmear(['codocyte'], terms).tier, 'full');
});

test('拼字差一個字元:算對但標記', () => {
  const g = gradeSmear(['dacrocyt'], DACRO);
  assert.equal(g.score, 1);
  assert.deepEqual(g.spellingErrors, [{ typed: 'dacrocyt', expected: 'dacrocyte' }]);
});

test('⚠️ 短字不吃容錯 —— ALL 不准判成 AML', () => {
  const aml: AcceptedTerm[] = [{ text: 'AML', tier: 'full' }];
  assert.equal(gradeSmear(['ALL'], aml).tier, 'miss');
  assert.equal(gradeSmear(['CLL'], [{ text: 'CML', tier: 'full' }]).tier, 'miss');
});

test('大小寫與多餘空白不影響', () => {
  assert.equal(gradeSmear(['  TEAR ', ' DROP '], DACRO).tier, 'lay');
});

test('格子數不硬閘 —— 3 格只填第一格但填對整個答案', () => {
  const maha: AcceptedTerm[] = [
    { text: 'microangiopathic hemolytic anemia', tier: 'full' },
    { text: 'MAHA', tier: 'full' },
  ];
  assert.equal(gradeSmear(['MAHA', '', ''], maha).score, 1);
});

test('空白作答是 miss,不是任何一層', () => {
  assert.equal(gradeSmear(['', '  '], DACRO).tier, 'miss');
});
```

**Step 2: 跑測試確認它紅**

```bash
node --test worker/lib/smear-grade.test.ts
```
Expected: `Cannot find module './smear-grade.ts'`

**Step 3: 實作**

`worker/lib/smear-grade.ts`:

```ts
/**
 * 抹片作答判定。
 *
 * 四層:full(1 分)/ half(0.5)/ lay(俗名,0 分但明講正解)/ miss。
 *
 * ⚠️ 比對順序必須是 full → half → lay。反過來的話 `tear drop` 會被某個寬鬆
 *    規則先吃掉,而症狀是「這個功能好像不太在意我寫什麼」。
 *
 * ⚠️ Levenshtein ≤1 的容錯只給長度 ≥5 的字。AML 與 ALL 的距離正好是 1 ——
 *    對短縮寫開容錯等於把「答錯」判成「拼錯」,而這個題庫滿滿都是三個字母的
 *    縮寫(AML/ALL/CML/CLL/MDS/MPN)。
 */
export type Tier = 'full' | 'half' | 'lay';
export interface AcceptedTerm { text: string; tier: Tier }
export interface SpellingError { typed: string; expected: string }
export interface Grade {
  tier: Tier | 'miss';
  score: number;
  matched: string | null;
  canonical: string | null;
  spellingErrors: SpellingError[];
}

const TIER_ORDER: Tier[] = ['full', 'half', 'lay'];
const TIER_SCORE: Record<Tier, number> = { full: 1, half: 0.5, lay: 0 };
const FUZZY_MIN_LEN = 5;

export function normalizeTerm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // 去變音符:Döhle → dohle
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[-–—_/]+/g, ' ')
    .replace(/[.,;:!?()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 回 null = 不匹配;回陣列 = 匹配(可能帶拼字錯) */
function matchWords(typed: string[], expected: string[]): SpellingError[] | null {
  if (typed.length !== expected.length) return null;
  const errs: SpellingError[] = [];
  for (let i = 0; i < typed.length; i++) {
    if (typed[i] === expected[i]) continue;
    if (expected[i].length >= FUZZY_MIN_LEN && levenshtein(typed[i], expected[i]) <= 1) {
      errs.push({ typed: typed[i], expected: expected[i] });
      continue;
    }
    return null;
  }
  return errs;
}

export function gradeSmear(
  boxes: string[],
  terms: AcceptedTerm[],
  canonical?: string
): Grade {
  const typed = normalizeTerm(boxes.join(' ')).split(' ').filter(Boolean);
  const canon = canonical ?? terms.find((t) => t.tier === 'full')?.text ?? null;
  const miss: Grade = { tier: 'miss', score: 0, matched: null, canonical: canon, spellingErrors: [] };
  if (!typed.length) return miss;

  for (const tier of TIER_ORDER) {
    // 同一層之內,先試完全相同的,再試容錯的 —— 否則一個「差一個字元」的
    // 候選可能搶在「完全正確」的候選前面被選中,回饋就會冤枉地標紅。
    const pool = terms.filter((t) => t.tier === tier);
    for (const pass of [true, false]) {
      for (const t of pool) {
        const errs = matchWords(typed, normalizeTerm(t.text).split(' ').filter(Boolean));
        if (errs === null) continue;
        if (pass && errs.length) continue;
        return { tier, score: TIER_SCORE[tier], matched: t.text, canonical: canon, spellingErrors: errs };
      }
    }
  }
  return miss;
}
```

**Step 4: 跑測試確認它綠**

```bash
node --test worker/lib/smear-grade.test.ts
```
Expected: 13 pass

**Step 5: Commit**

```bash
git add worker/lib/smear-grade.ts worker/lib/smear-grade.test.ts
git commit -m "feat(smear): 判定純函式 —— 四層 tier,短縮寫不吃拼字容錯

Levenshtein ≤1 只給長度 ≥5 的字。AML 與 ALL 的距離正好是 1,對短縮寫開
容錯等於把「答錯」判成「拼錯」,而這個題庫滿滿都是三個字母的縮寫。

比對順序 full → half → lay 是承重的:反過來 tear drop 會被寬鬆規則先吃掉。"
```

---

## Task B2: `pickSmearSet()`

**Files:**
- Create: `worker/lib/smear-pick.ts`
- Create: `worker/lib/smear-pick.test.ts`

**Step 1: 寫失敗的測試**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largestRemainder, pickSmearSet, type PoolItem } from './smear-pick.ts';

const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

test('largestRemainder 加總必定等於 n', () => {
  const q = largestRemainder(50, { a: 0.3, b: 0.22, c: 0.18, d: 0.15, e: 0.06, f: 0.04, g: 0.05 });
  assert.equal(Object.values(q).reduce((s, v) => s + v, 0), 50);
});

test('largestRemainder 在 n 很小時也不掉題', () => {
  const q = largestRemainder(3, { a: 0.5, b: 0.3, c: 0.2 });
  assert.equal(Object.values(q).reduce((s, v) => s + v, 0), 3);
});

const pool = (n: number, topic: string, pre = ''): PoolItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${pre}${topic}-${i}`, topic }));

test('⚠️ 某類題數不足時,缺額要回填給其他類 —— 不准靜默少題', () => {
  const p = [...pool(50, 'myeloid'), ...pool(2, 'infection')];
  const got = pickSmearSet(p, 20, { myeloid: 0.5, infection: 0.5 }, new Set(), seq([0.5]));
  assert.equal(got.length, 20);                       // 不是 12
  assert.equal(got.filter((id) => id.startsWith('infection')).length, 2);
});

test('題庫比 n 小的時候,回傳全部而不是重複', () => {
  const p = pool(7, 'rbc');
  const got = pickSmearSet(p, 20, { rbc: 1 }, new Set(), seq([0.5]));
  assert.equal(got.length, 7);
  assert.equal(new Set(got).size, 7);
});

test('⚠️ 避開上一場考過的題', () => {
  const p = pool(20, 'rbc');
  const exclude = new Set(p.slice(0, 10).map((x) => x.id));
  const got = pickSmearSet(p, 10, { rbc: 1 }, exclude, seq([0.5]));
  assert.equal(got.filter((id) => exclude.has(id)).length, 0);
});

test('排除項不夠時仍然湊滿,不是少給', () => {
  const p = pool(12, 'rbc');
  const exclude = new Set(p.slice(0, 10).map((x) => x.id));
  const got = pickSmearSet(p, 10, { rbc: 1 }, exclude, seq([0.5]));
  assert.equal(got.length, 10);
  assert.equal(new Set(got).size, 10);
});

test('不重複', () => {
  const p = [...pool(40, 'myeloid'), ...pool(40, 'lymphoid')];
  const got = pickSmearSet(p, 50, { myeloid: 0.5, lymphoid: 0.5 }, new Set(), seq([0.1, 0.9, 0.4]));
  assert.equal(new Set(got).size, 50);
});
```

**Step 2–4:** 紅 → 實作 → 綠。實作要點:

- `largestRemainder(n, weights)` —— floor 後把餘數大的那幾類各 +1,直到加總 = n
- 每類:候選 = pool 濾 topic、濾掉 `exclude`,Fisher–Yates（rng 注入）後取配額
- 缺額回填:先從所有類剩下的「非 exclude」候選補,還不夠才動用 `exclude` 的
- 回傳前 `assert` 沒有重複

**Step 5: Commit**

---

# Phase C —— Worker API

## Task C1: `/api/smear` 讀取端

**Files:**
- Create: `worker/routes/smear.ts`
- Modify: `worker/index.ts`(在 `app.route('/api/play', …)` 附近加一行)

端點:

| Method | Path | 說明 |
| --- | --- | --- |
| GET | `/api/smear/meta` | topic 比例、各 source 題數、dx 總數 |
| POST | `/api/smear/sessions` | 開一場:抽題(`pickSmearSet`)並寫 `question_ids` |
| GET | `/api/smear/sessions/:id` | 題目 payload(**不含答案**) |
| POST | `/api/smear/sessions/:id/answer` | 送一題,回判定結果 |
| POST | `/api/smear/sessions/:id/finish` | 交卷,算總分 |
| GET | `/api/smear/sessions` | 作答記錄清單 |
| GET | `/api/smear/wrong` | 錯題本(按 dx 聚合) |
| GET | `/api/smear/dx/:id` | 診斷詳情:詳解 + 所有圖 + terms |
| GET | `/api/smear/search?q=` | 獨立 FTS |

⚠️ **複習模式的 `/answer` 回完整判定(含 canonical 與 terms 清單);全真模式
只回 `{ok:true}`,判定結果到 `/finish` 之後才給。** 判定寫在伺服器,不能讓
client 自己算 —— 那等於把答案送到瀏覽器。

⚠️ **`SELECT` 的 bind 是位置對應的。** 這一批查詢有好幾條同時綁 `user_email`
與 `session_id`,照 `worker/lib/bind-order.ts` 的規則命名變數(綁 `user_email = ?`
的變數名要含 `email`),否則那支掃描器會報出來 —— 而它存在的理由就是 #184 那次
無聲的錯位。

⚠️ **`session_id` 的每一條查詢都要再釘一次 `user_email = ?`。** 少了它,任何人
拿到別人的 session id 就能看到那份考卷。

**測試:** route 層這個 repo 沒有測試慣例(`worker/**/*.test.ts` 全是純函式),
所以驗證靠 `wrangler dev` + curl,並把結果貼進 commit message。

---

## Task C2: 「這個寫法也該算對」提報與投票

**Files:**
- Create: `worker/lib/smear-proposal.ts` + `.test.ts`
- Modify: `worker/routes/smear.ts`

| Method | Path |
| --- | --- |
| POST | `/api/smear/dx/:id/terms` | 提報(text + tier + rationale) |
| POST | `/api/smear/terms/:tid/votes` | 投票 |
| DELETE | `/api/smear/terms/:tid/votes` | 收回 |
| GET | `/api/smear/terms/recent` | 近期提報 |

純函式 `resolveProposal(votes, quorum)` 決定 open → accepted / rejected,
**測試要涵蓋**:票數不足時維持 open、通過門檻、否決後 status 是 `rejected`
而**不是刪列**。

⚠️ **通過後不追溯改分。** `/finish` 已經寫進 `smear_answers.tier` 的列一律不動;
檢討頁另外查一次「這個寫法後來被接受了嗎」再標註。

---

# Phase D —— 前端

## Task D1: `/smear` 骨架 + 導覽項

**Files:**
- Create: `frontend/src/routes/Smear.tsx`
- Modify: `frontend/src/App.tsx`(`NavItem` + `Route`)
- Modify: `frontend/e2e/fixtures/`(新增 `api_smear_meta.json` 等)

⚠️ **導覽多一項會動到「尾端摺進 更多」的階梯。** 照 CLAUDE.md 那節:
`更多` 下拉裡的 `xx:hidden` 必須跟列上 `NavItem` 的 `xx:block` 對齊,而且
新項目要**晚**一個斷點才出現。改完跑 `frontend/e2e/overflow.test.mjs`。

分頁:練習 / 作答記錄 / 錯題本 / 搜尋。分頁狀態放 `?tab=`。

## Task D2: 開場 dialog

**Files:** `frontend/src/components/smear/StartDialog.tsx`

題數、模式、作答寫法(全稱/縮寫/任意)、主題篩選、題源。

⚠️ **對話框要吃安全區。** 照 CLAUDE.md「對話框的安全區」那節用 `.dialog-scrim`
+ `max-h-full`,**不要寫 `max-h-[calc(100dvh-2rem)]`**。改完跑
`frontend/src/lib/mobileChrome.test.ts`(掃描器會數對話框數量,新增一個要更新
那個下限)。

## Task D3: 作答頁

**Files:**
- `frontend/src/routes/SmearSession.tsx`
- `frontend/src/components/smear/AnswerBoxes.tsx`
- `frontend/src/components/smear/SmearImage.tsx`

- 格子數 = 該模式下 canonical 的字數;沒有縮寫的題在縮寫模式下 fallback 全稱
- **格子之間 Tab / 空白鍵前進,Backspace 在空格上退回前一格** —— 不做的話
  每打完一個字都要伸手點下一格,50 題就是 50 次
- 圖片點開放大(用 `image_key_full`),手機要能 pinch-zoom
- 複習模式:送出即揭曉(tier 徽章 + 拼字標記 + 正解 + 詳解入口)
- 提示鈕(首字母 / 主題 / 字數),按下即記 `hint_used`

⚠️ **e-ink:四種狀態靠 `✓` / `◐` / `~` / `✗` 加框線語彙,顏色只是加強。**

## Task D4: 成績頁 + 錯題本

**Files:**
- `frontend/src/routes/SmearResult.tsx`
- `frontend/src/components/smear/TopicBreakdown.tsx`

- 總分(百分制)、按 topic 拆開的正確率、**拼字正確率單獨一行**、
  **俗名次數單獨一行**、用了提示的題數單獨算
- 逐題檢討:圖 + 你寫的 + 正解 + tier + 詳解
- 錯題本按 dx 聚合,可一鍵只練錯題

## Task D5: `/smear/dx/:id` 診斷詳情

共筆詳解(沿用 `RichEditor` 與 lock 流程)+ 同診斷所有圖(標 source)+
可接受寫法清單 + 提報入口。

⚠️ **唯讀內容走 `lib/staticDoc.ts` 不要用 `useEditor`** —— 照 CLAUDE.md
「分頁的載入卡頓」那節,唯讀區塊建 EditorView 是 render phase 同步 30–50ms。

## Task D6: 獨立搜尋

`frontend/src/components/smear/SmearSearch.tsx`,打 `/api/smear/search`。
**不共用 `/api/search`。**

---

# Phase E —— 既有防線

## Task E1: 三條防線各補一筆

**Files:**
- Modify: `frontend/src/lib/sw-guards.ts` —— ⚠️ **不要**把 `/api/smear/*` 加進
  `CACHEABLE_API`(可變狀態)。加一條**負面**測試釘住這件事,同
  `/api/free-notes*` 那條的作法。
- Modify: `frontend/e2e/eink.test.mjs` —— 路由表加 `/smear`、`/smear/s/:id`、
  `/smear/dx/:id`。⚠️ 作答頁的輸入格與四種 tier 徽章要真的畫出來才掃得到,
  所以那條路由要先注入一份「已作答」的 fixture。
- Modify: `frontend/e2e/overflow.test.mjs` —— 導覽階梯改了,繞斷點重測。

## Task E2: e2e —— 走完一次練習

**Files:** `frontend/e2e/smear-practice.test.mjs`

⚠️ **每一條都先斷言「輸入格真的長出來」再斷言判定** —— 「沒有判成全對」是負面
斷言,格子沒渲染時也會成立(同 `users_online.json` 空 fixture 那個坑)。

要驗的:
1. 開場 dialog 選全稱 → 那題畫出 3 格
2. 打對 → 全對徽章
3. 打俗名 → **0 分但畫面上出現正解**
4. 打錯一個字母 → 全對 + 拼字標記
5. 用了提示 → 成績頁那題標出來
6. 全真模式:送出後**不**揭曉,交卷才揭曉

**Files:** 加進 `package.json` 的 `test:webkit` 清單。

## Task E3: 部署前檢查

⚠️ `migrations/**` 有變更 → `.github/workflows/deploy.yml` 的 `classify` 會
**直接讓 job 紅**(需要人工)。合併後要:

```bash
pnpm db:migrate:remote
pnpm smear:import --remote
wrangler d1 execute $(node scripts/lib/cfg.mjs project.d1_db) --remote \
  --command "SELECT source, COUNT(*) FROM smear_questions GROUP BY source"
```

**最後這一句不能跳過** —— 見 Task A6 Step 4 的理由。
