# 匯入內容清洗層（OpenEvidence → TipTap）

2026-07-20

## 問題

筆記 114-048 / 114-027 匯入後夾帶三類雜訊：

1. `{"text": "</h3> [[1,1"}` —— OE 的回答本文帶著模型吐出的裸收尾標籤，
   加上未被 chip 化的 citation marker。`linkifyCitations()` 只改寫真正的
   `markdown-article-citation-chip` span，裸 marker 完全沒人處理。
2. `Used under license from Wiley.` / `Feedback` —— 圖片區塊的 chrome，
   不是 `<button>`，所以 `stripChrome()` 的 `CHROME_SELECTOR` 撈不到。
3. 結尾的「您是否想進一步了解…?」邀請句 —— 位置在 `data-answer-end`
   sentinel **之前**，`dropFollowUps()` 構不著。

三者的共通點：`oe-import.ts` 是純結構搬運，沒有任何文字層的把關。

## 決策

| 面向 | 選擇 | 理由 |
|---|---|---|
| 清洗哲學 | **白名單淨化** | 規則只描述「機器殘渣長什麼樣」，與 OE 的 DOM 無關。OE 改版讓 selector 全部失效時，這層照樣有效 |
| 執行位置 | **匯入時，TS/Python 各自呼叫** | 使用者手打的 `</h3>`、`[[1,1]]` 永遠不被碰——因為 sanitize 從不在 save 路徑執行 |
| 可觀測性 | **靜默** | 誤刪的爆炸半徑限制在「剛匯入的那一段」，且使用者當下就在看預覽 |

被否決的方案：在 Worker 寫入時統一把關（會默默改掉手打內容）；
把整個 OE 解析搬進 Worker（worker 無 DOMParser，重構規模不成比例）。

## 實作

`frontend/src/lib/sanitize-import.ts` — 純函式 `sanitizeImportedDoc(doc)`，
不 import DOM 或 tiptap，可直接用 `node --test` 測。
`.claude/skills/mcq/scripts/oe_import.py` 的 `sanitize_imported_doc()` 是同規格的移植。

三組規則，依序套用：

- **A. 文字節點刷洗** —— 裸標籤字面、數字 citation marker（含各種截斷）、
  落單的 `[[` / `]]`、零寬字元與 C0 控制碼；連續空白收合。
  刷完若變成全空白**而原本不是**，該節點刪除；原本就是空白的（marks 之間
  的真實分隔）保留。
- **B. 整塊 chrome 丟棄** —— `paragraph` / `heading` 的正規化純文字比對
  `CHROME_PATTERNS`（授權聲明、Feedback、狀態列、追問邀請句）。
- **C. 空殼收合** —— 由內而外遞迴。`codeBlock` 整棵跳過（程式碼本來就會有
  `</h3>`）；`image` / `horizontalRule` 等 void 節點保留；表格 cell 空了補一個
  空 paragraph 而非刪除（刪 cell 會破壞列的欄數）。

接點：`RichEditor.tsx` 的 `insertSanitized()` 是所有外來內容的唯一咽喉。
改用 ProseMirror `DOMParser` 顯式產生 JSON 再插入——原本交給
`insertContent(html)` 由 TipTap 內部解析，根本沒有可攔截的位置。
OE 匯入對話框、外部 HTML 貼上、markdown 貼上三個入口全部收斂於此。

## 誤刪防護

- `[[` 只在後面不接文字時才刪，`]]` 只在 token 邊界才刪 →
  真正的 `[[wiki link]]` 不受影響。
- 裸標籤用有界的 tag 名單，`a<b` 這種散文不受影響。
- 追問句規則要求開頭詞 **且** 以問號結尾；中文開頭詞後不能加 `\b`
  （CJK 不是 `\w`，加了整條規則會靜默失效——這是實作時踩到的坑）。

## 驗證

13 個單元測試，fixture 直接取自 114-048 的真實殘留。
端到端跑一則真實對話（`/ask/d6d6cbad-…`）：文字節點 436 → 433、
字元 10867 → 10593（-2.5%），移除的是 `Used under license from…`、
`Feedback`、`Would you like…?` 三段，外加一個藏在文獻標題裡的軟連字號；
表格、圖片、清單數量完全不變。

## 未處理

既有的 2 筆髒筆記（114-027、114-048）尚未回填清洗——
sanitizer 是純函式，補一支一次性 script 走訪 `personal_notes` 即可。
