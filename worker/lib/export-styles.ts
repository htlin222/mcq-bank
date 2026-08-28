// 匯出用的單檔樣式表 —— **白底黑字、字級變化小、印表機友善**。
//
// ⚠️ **這份不再是 mcq-to-anki `templates/styling.css` 的複製品。**
// 舊版是那份 Catppuccin 主題的拷貝(12–24px 的字級、九種語意色、還有一整組
// `prefers-color-scheme: dark` 變數),檔頭寫著「上游改版時要手動同步」。
// 2026-08-28 依使用者要求整份換成極簡版之後,那個同步契約就結束了 —— 留著舊的
// 檔頭會讓下一個人以為「照上游更新就好」,而那是假的(同這輪查到的
// `API_CACHE_NAME` 假註解)。
//
// **保留的是 markup 契約,不是配色**:class 名稱仍然對齊 mcq-to-anki 的
// `templates/back.html`(`.anki-note > .field-front + .field-back`、`.qid`、
// `.stem`、`.options`/`.optkey`、`.answer`、`.expl`),所以 `export-html.ts` 與
// `export-csv.ts` 產生的標記一行都不用改,Anki 那邊也還套得上它自己的樣式。
//
// 三條設計判準,改動時請一起讀:
//
//   1. **只有黑白灰。** 匯出檔的用途是離線讀、列印、封存 —— 顏色在灰階列印下
//      會全部塌成同一階,而語意如果只寫在顏色裡,印出來就整個消失(同 CLAUDE.md
//      電子紙那節的「顏色沒了之後,語意要換一個維度重講」)。所以正解靠**粗體 +
//      「正解」二字**,畫記靠**底線**,不靠顏色。
//   2. **字級只有三階(12 / 15 / 19px)。** 舊版題幹 24px、選項與詳解 12px,
//      差兩倍 —— 題幹像標題、詳解像註腳,而它們其實都是要讀的正文。現在題幹、
//      選項、詳解**同樣 15px**,只有頁首標題與 metadata 不同。
//   3. **沒有深色模式。** 一份會被列印與封存的文件不該跟著讀者的作業系統主題
//      變色;而且深色配色在列印時會被瀏覽器的 `print-color-adjust: economy`
//      丟掉背景、只留下淺色文字,結果是幾乎看不見的一頁。
//
// ⚠️ **底下那個字串裡的 CSS 註解不能寫反引號** —— 整份是一個 template literal,
// 一個反引號就把字串切斷,而 tsc 報的是「Cannot find name 'backHtml'」這種完全
// 不指向原因的錯。寫這一版時踩過兩次。

export const EXPORT_STYLES = `
:root {
  --ink: #000;
  --ink-soft: #555;
  --rule: #bbb;
  --rule-soft: #ddd;
  --wash: #f2f2f2;
}

html {
  background: #fff;
}

body {
  margin: 0;
  padding: 0;
  color: var(--ink);
  background: #fff;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", Arial, "Noto Sans CJK TC", sans-serif;
  font-size: 15px;
  line-height: 1.65;
  text-align: left;
}

.anki-note {
  box-sizing: border-box;
  width: min(760px, 100%);
  margin: 0 auto;
  padding: 28px 24px 32px;
}

.field {
  overflow-wrap: anywhere;
  word-break: normal;
}

/* 題面與答案面。舊版在這裡分別給了 24px 與 12px —— 現在兩面都是正文的 15px,
   分隔改由 .field-front--review 的那條線負責。 */
.field-front,
.field-back {
  color: var(--ink);
  font-size: 15px;
  line-height: 1.65;
}

.field-front--review {
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--rule-soft);
}

/* 題號。整份文件裡唯一的小字之一 —— 它是索引,不是內容。 */
.qid {
  margin: 0 0 0.6em;
  color: var(--ink-soft);
  font-size: 12px;
  font-weight: 600;
}

/* 題幹。**跟選項、詳解同樣 15px** —— 它們都是要讀的正文,靠粗體區分即可。 */
.stem {
  margin: 0 0 0.9em;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.65;
  white-space: pre-wrap;
}

.options {
  margin: 0;
  padding: 0;
  font-size: 15px;
  font-weight: 400;
  line-height: 1.65;
  list-style: none;
}

.options li {
  position: relative;
  margin: 0;
  padding: 0.42em 0 0.42em 1.9em;
}

/* 選項之間只有一條細線;最後一條也留著,好跟底下的答案分開。 */
.options li + li {
  border-top: 1px solid var(--rule-soft);
}

.optkey {
  position: absolute;
  top: 0.42em;
  left: 0;
  font-weight: 600;
}

/* 複習模式那一版的題面:同樣的字級,只是間距緊一點。 */
.field-front--review .qid {
  margin-bottom: 0.5em;
}

.field-front--review .stem {
  margin-bottom: 0.7em;
  font-weight: 600;
}

.field-front--review .options li {
  padding-top: 0.32em;
  padding-bottom: 0.32em;
}

/* 正解。**不靠顏色** —— 灰階列印下綠色和黑色一樣黑。 */
.answer {
  margin: 0.9em 0 1em;
  padding: 0.45em 0.7em;
  border-left: 3px solid var(--ink);
  background: var(--wash);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.65;
}

.expl {
  margin-top: 1em;
  padding-top: 1em;
  border-top: 1px solid var(--rule);
  font-size: 15px;
  line-height: 1.65;
}

/* 詳解裡的標題只比內文重,不比內文大 —— 一份文件裡有六階字級,讀起來像簡報。 */
.expl h1,
.expl h2,
.expl h3,
.expl h4,
.expl h5,
.expl h6,
.note h1,
.note h2,
.note h3,
.note h4,
.note h5,
.note h6 {
  margin: 1.3em 0 0.4em;
  color: var(--ink);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
}

.expl h3:first-child,
.note h1:first-child,
.note h2:first-child,
.note h3:first-child {
  margin-top: 0;
}

.expl p,
.note p {
  margin: 0.6em 0;
}

.expl ol,
.expl ul,
.note ol,
.note ul {
  margin: 0.6em 0;
  padding-left: 1.5em;
}

li + li {
  margin-top: 0.2em;
}

.expl blockquote,
.note blockquote {
  margin: 0.8em 0;
  padding: 0.1em 0 0.1em 0.9em;
  border-left: 2px solid var(--rule);
  color: var(--ink-soft);
}

.field-front > :first-child {
  margin-top: 0;
}

.field-front > :last-child {
  margin-bottom: 0;
}

strong {
  font-weight: 600;
}

em {
  font-style: italic;
}

/* 連結不用藍色 —— 印出來看不出是連結,只會多一種顏色。底線就夠了。 */
a {
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 2px;
}

code {
  padding: 0 0.25em;
  background: var(--wash);
  border-radius: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}

pre {
  margin: 0.8em 0;
  padding: 0.7em 0.85em;
  overflow-x: auto;
  background: var(--wash);
  border: 1px solid var(--rule-soft);
  border-radius: 3px;
  font-size: 0.92em;
  line-height: 1.5;
}

pre code {
  padding: 0;
  background: none;
}

hr {
  margin: 1.4em 0;
  border: 0;
  border-top: 1px solid var(--rule-soft);
}

table {
  width: 100%;
  margin: 0.8em 0;
  border-collapse: collapse;
  font-size: 0.95em;
}

td,
th {
  padding: 0.35em 0.55em;
  border: 1px solid var(--rule);
  text-align: left;
  vertical-align: top;
}

th {
  background: var(--wash);
  font-weight: 600;
}

img {
  max-width: 100%;
  height: auto;
}

/* 個人筆記與畫記。 */
.note {
  margin-top: 1em;
  padding-top: 1em;
  border-top: 1px solid var(--rule);
}

.hl {
  margin-top: 1em;
  padding-top: 1em;
  border-top: 1px solid var(--rule);
}

/* ⚠️ **區塊標籤是拿掉顏色之後才需要的。** 舊版靠配色分辨詳解 / 個人筆記 / 畫記
   (mauve 標題、不同的文字色);全部變黑之後,這三區只剩一條一模一樣的分隔線,
   印出來根本分不出哪段是誰寫的。這正是 CLAUDE.md 電子紙那節的
   「顏色沒了之後,語意要換一個維度重講」。

   用 ::before 而不是改 backHtml 的標記:那份標記與 mcq-to-anki 的
   templates/back.html 對齊(見檔頭),而這是純排版的需求,不該讓兩邊漂移。 */
.expl::before,
.note::before,
.hl::before {
  display: block;
  margin-bottom: 0.35em;
  color: var(--ink-soft);
  font-size: 12px;
  font-weight: 600;
}

.expl::before {
  content: "詳解";
}

.note::before {
  content: "個人筆記";
}

.hl::before {
  content: "畫記";
}

.hl ul {
  margin: 0.4em 0;
  padding-left: 1.5em;
}

/* 畫記靠**底線**,不靠黃色底 —— 灰階列印下黃色會塌成一塊灰,而底線在任何
   輸出上都活得下來(同電子紙那節「語意要換一個維度重講」)。 */
mark {
  padding: 0;
  color: var(--ink);
  background: none;
  border-bottom: 2px solid var(--ink);
}

.mention,
.qref {
  color: var(--ink);
  font-weight: 600;
}

/* 多題單檔:題與題之間的分隔。 */
.anki-note + .anki-note {
  border-top: 2px solid var(--rule);
}

/* 頁首。 */
.export-head {
  box-sizing: border-box;
  width: min(760px, 100%);
  margin: 0 auto;
  padding: 28px 24px 0;
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.6;
}

.export-head h1 {
  margin: 0 0 0.4em;
  color: var(--ink);
  font-size: 19px;
  font-weight: 600;
  line-height: 1.4;
}

.export-head .privacy {
  margin: 0 0 0.5em;
}

.export-head ul {
  margin: 0;
  padding-left: 1.3em;
}

@media (max-width: 520px) {
  .anki-note,
  .export-head {
    padding-left: 16px;
    padding-right: 16px;
  }
}

/* ---------------------------------------------------------------- 列印
   一份匯出檔最常見的下場就是被印出來或存成 PDF(Worker 產 PDF 是 non-goal,
   見 export-html.ts 的檔頭),所以這一段不是附贈的。 */
@page {
  margin: 15mm 14mm;
}

@media print {
  html,
  body {
    background: #fff;
    color: #000;
    font-size: 11pt;
  }

  .anki-note,
  .export-head {
    width: auto;
    max-width: none;
    padding-left: 0;
    padding-right: 0;
  }

  /* 一題盡量不要被切成兩頁;真的太長就讓它切,總比留一整頁空白好。 */
  .anki-note {
    break-inside: avoid;
    padding-top: 10pt;
    padding-bottom: 10pt;
  }

  /* 標題不要落在頁尾當孤兒。 */
  .stem,
  .expl h1,
  .expl h2,
  .expl h3,
  .note h1,
  .note h2,
  .note h3 {
    break-after: avoid;
  }

  /* 段落與表格列不要被切開。 */
  p,
  li,
  tr,
  blockquote,
  pre {
    break-inside: avoid;
  }

  img {
    max-height: none !important;
    break-inside: avoid;
  }

  /* 底色一律不印 —— 省墨,而且 print-color-adjust 預設本來就會丟掉它們,
     與其讓瀏覽器各自決定,不如自己講清楚。語意已經另外由框線與粗體帶著。 */
  .answer,
  code,
  pre,
  th {
    background: none;
  }

  .answer {
    border-left: 3px solid #000;
  }
}
`;
