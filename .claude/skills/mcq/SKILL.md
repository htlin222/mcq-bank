---
name: mcq
version: 0.5.0
description: 血液腫瘤考古題單題(題幹/選項/答案/共筆詳解/個人筆記,筆記可讀可寫,可從 HTML 或 OpenEvidence 公開對話匯入圖文筆記)。當使用者輸入 /mcq 年-題號(例如 /mcq 114-001、也接受 114-1)時使用。
---

# mcq — 單題考古題小測驗

使用者給題號(例:`114-001`,也接受 `114-1`)。預設模擬選擇題:**先讓使用者作答,再揭曉答案與共筆詳解**。

腳本就在本技能目錄下,用**絕對路徑**叫它,**別假設 cwd 是 repo 根目錄、也別去翻目錄找它**。
先把本技能目錄(這段指令開頭的 **Base directory for this skill** 那個路徑)設進變數,後面都用它(`.env` 也在這裡,腳本會自己讀):

    SKILL="<貼上上面的 Base directory for this skill>"

## 流程

1. 取題目(預設不含答案):

       python3 "$SKILL/scripts/get_mcq.py" QID

   輸出題幹與選項。**先別洩漏答案。**

2. 呈現題幹與選項,請使用者回覆答案字母(A/B/C/D/E),等他回覆後再繼續。

3. 作答後揭曉答案:

       python3 "$SKILL/scripts/get_mcq.py" QID --answer

   比對使用者選的字母與 `✅ 答案`,先說答對/答錯,再附上共筆詳解;若使用者在網站上寫過這題的個人筆記,輸出末尾會有「## 個人筆記」段落(只有本人看得到),一併呈現。

若使用者明說「直接看答案 / 不用測驗」,跳過第 2 步,直接用 `--answer` 一次給完整內容。

## 寫個人筆記

使用者說「幫我記下來 / 加到筆記」時,把內容整理成 markdown 後附加(不會動到既有筆記,會加在末尾分隔線之後):

    python3 "$SKILL/scripts/get_mcq.py" QID --note "筆記內容"

多行內容用 stdin:`echo "..." | python3 "$SKILL/scripts/get_mcq.py" QID --note -`
支援的 markdown:段落、`#` 標題、`-`/`1.` 清單、`>` 引用、``` 圍欄程式碼、`**粗體**`、`*斜體*`。

整筆覆寫要加 `--replace`。**覆寫前必須先用 `--answer` 讓使用者看過現有筆記並明確同意** — 網頁端筆記若含圖片或 @mention,覆寫後會遺失且無法復原(輸出會回印舊內容,終端還救得回來)。

## 匯入圖文筆記(HTML / OpenEvidence)

除了純文字 markdown,還能把**帶圖片與樣式的 HTML** 直接匯入成筆記。腳本會在本地把 HTML 轉成 TipTap 文件,Worker 端再消毒節點、並把外部圖片 sideload 進 R2(改寫成 `/img/…`,避免 hotlink 失效)。與 `--note` 一樣,預設 append,加 `--replace` 才整筆覆寫(同樣需先讓使用者看過舊筆記並同意)。

- 從 HTML 匯入(內容多時用 `--html -` 走 stdin,避免命令列過長):

      python3 "$SKILL/scripts/get_mcq.py" QID --html '<h3>標題</h3><p>...<img src="https://..."></p>'
      echo "$HTML" | python3 "$SKILL/scripts/get_mcq.py" QID --html -

- 從 **OpenEvidence 公開對話**匯入(必須是已 Make public 的 `/ask/<id>` 連結):

      python3 "$SKILL/scripts/get_mcq.py" QID --oe-url "https://www.openevidence.com/ask/<id>"

  多輪對話會全部匯入並各自加上問題標題;只要其中一輪用 `--turn N`(1 起算)。旗標別名:`--openevidence-url` / `--openevidenceURL` / `--oe`。

支援的節點:標題、段落、清單、表格、引用、程式碼、圖片,以及粗體/斜體/`code`/刪除線/highlight/連結;不支援的節點會被丟棄(腳本會印 `⚠️` 警告),@mention 一律降級為純文字。圖片上限 12 張;抓不到的外部圖(對方擋 UA 或過期)會保留原始 hotlink 並警告。

### 搭配 OpenEvidence MCP `oe_ask` 豐富筆記

典型流程:先用 `oe_ask`(OpenEvidence MCP)針對該題問一段有實證、含圖表的回答,再把回答寫進筆記:

1. `oe_ask` 取得回答。若回傳的是 **HTML**(含 `<img>`/表格/樣式),直接 `--html -` 餵進去;若只有 markdown,用 `--note` 即可。
2. 若 `oe_ask` 有回傳可公開的對話連結,也可改用 `--oe-url` 讓腳本自己抓整段對話。
3. 預設 append 到既有筆記末尾;要整批換掉才用 `--replace`(先給使用者看過舊內容)。

這樣就能用 MCP 問答的結果,把圖文詳解直接沉澱進自己該題的個人筆記,之後在網站上打開就看得到。

腳本輸出已含 401/403/404 錯誤提示,照訊息處理即可。

設定:到個人頁面 `https://<host>/profile` →「MCQ 小測驗金鑰」→ 下載 `.skill`(`.env` 已內含你的個人金鑰)。手動設定見 `.env.example`。若遇 401,可能是金鑰被重新產生,回 `/profile` 重新下載即可。
