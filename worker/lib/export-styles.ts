// 匯出用的單檔樣式表。
//
// 來源(唯一真相):github.com/htlin222/mcq-to-anki
//   src/mcq_to_anki/templates/styling.css @ 6b692d1 (2026-07-10)
// Worker 沒有檔案系統,不能 runtime 讀檔,所以這份是**複製**進來的字串常數。
// 上游改版時要手動同步這個檔案;反過來,下面「新增」區塊的 class
// (.note / .hl / mark / .export-head)也應該回饋回 mcq-to-anki,否則兩邊會漂移。
//
// 從上游搬過來時做的四項改動(全部是「Anki → 瀏覽器」造成的,不是配色改動):
//   1. `.card` 拆成 `:root`(--ctp-* 變數)+ `body`(排版/字級)。
//   2. `.card.nightMode` 改掛 `@media (prefers-color-scheme: dark)` 底下的
//      `:root` —— nightMode 是 Anki 自己加的 class,瀏覽器裡不存在。
//   3. `.anki-note` 拿掉 `min-height: 100vh` —— 多題單檔時每題會各佔滿一整螢幕。
//   4. 拿掉 `.replay-button*`(Anki 音檔重播鍵)與 `.mobile .anki-note`
//      (Anki 手機版才有的 class),單檔 HTML 用不到;RWD 由既有的
//      `@media (max-width: 520px)` 負責。

export const EXPORT_STYLES = `
:root {
  --ctp-rosewater: #dc8a78;
  --ctp-flamingo: #dd7878;
  --ctp-pink: #ea76cb;
  --ctp-mauve: #8839ef;
  --ctp-red: #d20f39;
  --ctp-maroon: #e64553;
  --ctp-peach: #fe640b;
  --ctp-yellow: #df8e1d;
  --ctp-green: #40a02b;
  --ctp-teal: #179299;
  --ctp-sky: #04a5e5;
  --ctp-sapphire: #209fb5;
  --ctp-blue: #1e66f5;
  --ctp-lavender: #7287fd;
  --ctp-text: #4c4f69;
  --ctp-subtext1: #5c5f77;
  --ctp-subtext0: #6c6f85;
  --ctp-surface1: #bcc0cc;
  --ctp-surface0: #ccd0da;
  --ctp-base: #eff1f5;
  --ctp-mantle: #e6e9ef;
  --ctp-crust: #dce0e8;
}

/* Anki 用 .card.nightMode 這個 class 切換深色;單檔 HTML 沒有那個 class,
   所以改掛在 prefers-color-scheme 上,兩種主題都會生效。 */
@media (prefers-color-scheme: dark) {
  :root {
  --ctp-rosewater: #f5e0dc;
  --ctp-flamingo: #f2cdcd;
  --ctp-pink: #f5c2e7;
  --ctp-mauve: #cba6f7;
  --ctp-red: #f38ba8;
  --ctp-maroon: #eba0ac;
  --ctp-peach: #fab387;
  --ctp-yellow: #f9e2af;
  --ctp-green: #a6e3a1;
  --ctp-teal: #94e2d5;
  --ctp-sky: #89dceb;
  --ctp-sapphire: #74c7ec;
  --ctp-blue: #89b4fa;
  --ctp-lavender: #b4befe;
  --ctp-text: #cdd6f4;
  --ctp-subtext1: #bac2de;
  --ctp-subtext0: #a6adc8;
  --ctp-surface1: #45475a;
  --ctp-surface0: #313244;
  --ctp-base: #1e1e2e;
  --ctp-mantle: #181825;
  --ctp-crust: #11111b;
  }
}

body {
  margin: 0;
  padding: 0;
  color: var(--ctp-text);
  background: var(--ctp-base);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, "Noto Sans CJK TC", sans-serif;
  font-size: 18px;
  line-height: 1.3;
  text-align: left;
}

.anki-note {
  box-sizing: border-box;
  width: min(860px, 100%);
  margin: 0 auto;
  padding: clamp(24px, 5vh, 48px) clamp(18px, 4vw, 32px);
}

.field {
  overflow-wrap: anywhere;
  word-break: normal;
}

.field-front {
  color: var(--ctp-text);
  font-size: 24px;
  font-weight: 650;
  line-height: 1.3;
}

.field-front--review {
  margin-bottom: 20px;
  padding-bottom: 18px;
  color: var(--ctp-subtext1);
  font-size: 18px;
  font-weight: 550;
  border-bottom: 1px solid var(--ctp-surface0);
}

.field-back {
  color: var(--ctp-text);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
}

.qid {
  margin: 0 0 1rem;
  color: var(--ctp-subtext0);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0;
}

.stem {
  margin: 0 0 1.05em;
  color: var(--ctp-text);
  font-size: 24px;
  font-weight: 650;
  line-height: 1.3;
  white-space: pre-wrap;
}

.options {
  margin: 0;
  padding: 0;
  color: var(--ctp-text);
  font-size: 12px;
  font-weight: 450;
  line-height: 1.3;
  list-style: none;
}

.options li {
  position: relative;
  margin: 0;
  padding: 0.78em 0 0.78em 2.35em;
  border-top: 1px solid var(--ctp-surface0);
}

.options li:last-child {
  border-bottom: 1px solid var(--ctp-surface0);
}

.optkey {
  position: absolute;
  top: 0.78em;
  left: 0;
  color: var(--ctp-blue);
  font-weight: 750;
}

.field-front--review .qid {
  margin-bottom: 0.65rem;
}

.field-front--review .stem {
  margin-bottom: 0.8em;
  color: var(--ctp-subtext1);
  font-size: 18px;
  font-weight: 600;
}

.field-front--review .options {
  color: var(--ctp-subtext1);
  font-size: 12px;
  line-height: 1.3;
}

.field-front--review .options li {
  padding-top: 0.55em;
  padding-bottom: 0.55em;
}

.field-front--review .optkey {
  top: 0.55em;
}

.answer {
  margin: 0 0 1.05em;
  color: var(--ctp-green);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
}

.expl {
  margin-top: 1em;
  padding-top: 1em;
  color: var(--ctp-text);
  border-top: 1px solid var(--ctp-surface0);
  font-size: 12px;
  line-height: 1.3;
}

.expl h1,
.expl h2,
.expl h3,
.expl h4,
.expl h5,
.expl h6 {
  margin: 1.25em 0 0.45em;
  color: var(--ctp-mauve);
  font-size: 1.05em;
  font-weight: 750;
  line-height: 1.3;
}

.expl h1:first-child,
.expl h2:first-child,
.expl h3:first-child {
  margin-top: 0;
}

.expl p {
  margin: 0.65em 0;
}

.expl ul,
.expl ol {
  margin: 0.6em 0 0.8em;
  padding-left: 1.35em;
}

.expl li + li,
li + li {
  margin-top: 0.35em;
}

.expl blockquote {
  margin: 0.9em 0;
  padding-left: 0.9em;
  color: var(--ctp-subtext1);
  border-left: 3px solid var(--ctp-surface1);
}

.field-back > :first-child,
.field-front > :first-child {
  margin-top: 0;
}

.field-back > :last-child,
.field-front > :last-child {
  margin-bottom: 0;
}

b,
strong {
  color: var(--ctp-mauve);
  font-weight: 700;
}

i,
em {
  color: var(--ctp-teal);
}

a {
  color: var(--ctp-blue);
  text-decoration-color: var(--ctp-surface1);
  text-underline-offset: 0.18em;
}

code {
  padding: 0.1em 0.3em;
  color: var(--ctp-maroon);
  background: var(--ctp-mantle);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}

pre {
  max-width: 100%;
  margin: 14px 0 0;
  padding: 14px 16px;
  overflow: auto;
  color: var(--ctp-text);
  background: var(--ctp-mantle);
  border-radius: 6px;
}

pre code {
  padding: 0;
  color: inherit;
  background: transparent;
}

hr {
  height: 1px;
  margin: 20px 0;
  background: var(--ctp-surface0);
  border: 0;
}

ul,
ol {
  margin: 0.65em 0 0;
  padding-left: 1.25em;
}

table {
  width: 100%;
  margin-top: 14px;
  border-collapse: collapse;
  font-size: 0.85em;
}

th,
td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--ctp-surface0);
}

th {
  color: var(--ctp-subtext1);
  font-weight: 650;
}

img {
  display: block;
  max-width: 100% !important;
  max-height: 52vh !important;
  width: auto;
  height: auto;
  margin: 18px auto 0;
}

@media (max-width: 520px) {
  .anki-note {
    width: 100%;
    padding: 22px 16px;
  }

}

/* ---- 以下為 hema-2026 匯出新增,尚未回饋到 mcq-to-anki ---- */

.export-head {
  width: min(860px, 100%);
  margin: 0 auto;
  padding: clamp(24px, 5vh, 48px) clamp(18px, 4vw, 32px) 0;
  color: var(--ctp-subtext0);
  font-size: 13px;
}

.export-head h1 {
  margin: 0 0 0.4em;
  color: var(--ctp-text);
  font-size: 22px;
  font-weight: 750;
}

.export-head .privacy {
  margin: 0.8em 0 0;
  padding: 0.7em 0.9em;
  color: var(--ctp-maroon);
  background: var(--ctp-mantle);
  border-left: 3px solid var(--ctp-maroon);
  border-radius: 4px;
}

.export-head ul {
  margin: 0.6em 0 0;
  padding-left: 1.2em;
}

/* 個人筆記 — 沿用 .expl 的分隔線語彙 */
.note {
  margin-top: 1em;
  padding-top: 1em;
  color: var(--ctp-text);
  border-top: 1px solid var(--ctp-surface0);
  font-size: 12px;
  line-height: 1.3;
}

/* 我的畫記 */
.hl {
  margin-top: 1em;
  padding-top: 1em;
  border-top: 1px solid var(--ctp-surface0);
  font-size: 12px;
  line-height: 1.3;
}

.hl ul {
  margin: 0;
  padding-left: 1.25em;
}

.note h1, .note h2, .note h3, .note h4, .note h5, .note h6 {
  margin: 1.25em 0 0.45em;
  color: var(--ctp-mauve);
  font-size: 1.05em;
  font-weight: 750;
  line-height: 1.3;
}

.note p { margin: 0.65em 0; }

.note ul,
.note ol {
  margin: 0.6em 0 0.8em;
  padding-left: 1.35em;
}

.note blockquote {
  margin: 0.9em 0;
  padding-left: 0.9em;
  color: var(--ctp-subtext1);
  border-left: 3px solid var(--ctp-surface1);
}

mark {
  padding: 0 0.15em;
  color: var(--ctp-crust);
  background: var(--ctp-yellow);
  border-radius: 2px;
}

.mention,
.qref { color: var(--ctp-lavender); }

/* 多題單檔:題與題之間的分隔 */
.anki-note + .anki-note {
  border-top: 1px solid var(--ctp-surface0);
}

@media print {
  .anki-note { break-inside: avoid-page; }
  img { max-height: none !important; }
}
`;
