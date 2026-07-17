---
name: mcq
version: 0.7.0
description: 血液腫瘤考古題(單題測驗/看答案/關鍵字搜尋/個人筆記,筆記可讀可寫,可從 HTML 或 OpenEvidence 公開對話匯入圖文)。前綴決定動作,由 mcq_cmd.py 確定性 dispatch。當使用者輸入 /mcq 開頭的指令時使用,例如 /mcq 114-001、/mcq 114-001 answer、/mcq search: CML、/mcq note 114-001: 內容。
---

# mcq — 考古題測驗 / 搜尋 / 筆記

**前綴決定動作,你不用判斷。** 把 `/mcq` 後面的參數**原封不動**丟給 router,印出它的輸出即可。

先把本技能目錄(這段指令開頭的 **Base directory for this skill** 那個路徑)設進變數:

    SKILL="<貼上上面的 Base directory for this skill>"

然後**一律**執行(把使用者的參數整串用單引號包起來當一個參數):

    python3 "$SKILL/scripts/mcq_cmd.py" '<使用者給的參數,原樣>'

## 前綴 → 動作(router 內部決定,你只要照跑)

| 使用者輸入 | 實際跑的 | 動作 |
| --- | --- | --- |
| `/mcq 114-011` | `mcq_cmd.py '114-011'` | 出題,**不含答案**(測驗模式) |
| `/mcq 114-011 answer` | `mcq_cmd.py '114-011 answer'` | 揭曉答案 + 共筆詳解 + 個人筆記 |
| `/mcq search: CML` | `mcq_cmd.py 'search: CML'` | 關鍵字搜尋題目 |
| `/mcq note 114-011: 內容` | `mcq_cmd.py 'note 114-011: 內容'` | 附加個人筆記(append) |

`answer` 也接受 `ans` / `答案` / `看答案` / `揭曉`。題號 `114-1`、`114 1` 也可。參數格式錯誤時 router / get_mcq.py 會印明確錯誤,照訊息處理。

### Fallback:router 只是快速路徑,get_mcq.py 是全功能後盾

`mcq_cmd.py` 只覆蓋上面四種日常前綴。**只要落在它之外,就直接叫 `get_mcq.py`**,不要硬套前綴語法:

- 使用者的意圖對不上任何前綴(例:要搜尋還要限定年份/筆數、要覆寫筆記、要匯入 HTML/OpenEvidence 圖文)。
- `mcq_cmd.py` 印出「格式…」之類的錯誤,而你判斷使用者其實想做別的動作。
- 筆記內容含單引號、很長或多行且帶特殊字元,不適合塞進 `'<args>'` → 改用 `get_mcq.py 114-011 --note -` 走 stdin。

`get_mcq.py` 支援的完整旗標:`--answer`、`--search`(+`--year`/`--limit`)、`--note`、`--html`、`--oe-url`(+`--turn`)、`--replace`,見下方「進階」。換句話說 router 是為了少讓你判斷,但你隨時可以繞過它、直接用底層腳本。

## 唯一需要你「跨兩回合」的:測驗兩段式

`/mcq 114-011`(裸題號)是測驗模式,分兩步:

1. 跑 `mcq_cmd.py '114-011'` → 只輸出題幹與選項。**先別洩漏答案**,請使用者回覆 A/B/C/D/E。
2. 使用者回覆字母後,跑 `mcq_cmd.py '114-011 answer'` → 比對他選的字母與 `✅ 答案`,先說答對/答錯,再附共筆詳解;若他在網站寫過個人筆記,輸出末尾的「## 個人筆記」一併呈現。

使用者若直接說「看答案 / 不用測驗」,直接跑 `'114-011 answer'` 一次給完。

## 搜尋:關鍵字要用縮寫

搜尋是 FTS 前綴比對再把每個 token 用 AND 串起來,所以**用縮寫、別打全名**:

- ✅ `search: CML`、`search: CMV`、`AML`、`DIC`、`ITP` — 短、命中率高
- ❌ `search: chronic myeloid leukemia` — 變成三個詞全部都要命中,反而找不到

沒結果就換別的縮寫,而不是改打全名。中文詞(例:`血栓`)可直接打。搜尋輸出是 `年-題號 [group] snippet`(命中字用【】標),**不含答案**;把清單給使用者挑一題,再走測驗/看答案流程。可加 `--year` / `--limit`(這兩個要直接用 `get_mcq.py --search 關鍵字 --year 113`)。

## 進階:直接用 get_mcq.py(router 不覆蓋這些)

日常三種前綴走 `mcq_cmd.py` 就好;下面是它不處理的進階流程,直接叫 `get_mcq.py`:

### 覆寫筆記
`mcq_cmd.py 'note …'` 一律 append。要**整筆覆寫**用 `--replace`,且**覆寫前必須先用 `answer` 讓使用者看過現有筆記並明確同意**(網頁端筆記若含圖片或 @mention,覆寫後會遺失且無法復原;輸出會回印舊內容,終端還救得回來):

    echo "新內容" | python3 "$SKILL/scripts/get_mcq.py" 114-011 --note - --replace

支援的 markdown:段落、`#` 標題、`-`/`1.` 清單、`>` 引用、``` 圍欄程式碼、`**粗體**`、`*斜體*`。

### 匯入圖文筆記(HTML / OpenEvidence)
把**帶圖片與樣式的 HTML** 匯入成筆記。腳本本地把 HTML 轉成 TipTap 文件,Worker 端消毒節點並把外部圖片 sideload 進 R2(改寫成 `/img/…`,避免 hotlink 失效)。預設 append,加 `--replace` 才覆寫(同樣需先讓使用者看過舊筆記並同意):

    echo "$HTML" | python3 "$SKILL/scripts/get_mcq.py" 114-011 --html -
    python3 "$SKILL/scripts/get_mcq.py" 114-011 --oe-url "https://www.openevidence.com/ask/<id>"

OpenEvidence 連結必須是已 Make public 的 `/ask/<id>`;多輪對話會全部匯入並各自加問題標題,只要其中一輪用 `--turn N`(1 起算)。旗標別名:`--openevidence-url` / `--oe`。支援節點:標題、段落、清單、表格、引用、程式碼、圖片,以及粗體/斜體/`code`/刪除線/highlight/連結;不支援的丟棄(印 `⚠️`),@mention 降級純文字。圖片上限 12 張;抓不到的外部圖保留原 hotlink 並警告。

### 搭配 OpenEvidence MCP `oe_ask`
先用 `oe_ask` 針對該題問一段含圖表的實證回答,回傳 HTML 就 `--html -`、只有 markdown 就 `--note -`;若有可公開對話連結,改用 `--oe-url` 讓腳本自己抓整段。預設 append,要換掉才 `--replace`(先給使用者看過舊內容)。

## 設定 / 錯誤

到個人頁面 `https://<host>/profile` →「MCQ 小測驗金鑰」→ 下載 `.skill`(`.env` 已內含個人金鑰,`mcqk_` 開頭)。手動設定見 `.env.example`。遇 **401** 多半是金鑰過期/被重新產生 → 回 `/profile` 重新下載 `.skill` 換掉 `.env`(重新部署 worker **不會**使金鑰失效)。403 是 email 不在白名單,404 是查無此題。
