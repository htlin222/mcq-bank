// iOS 的「頁面延伸到瀏海底下」是**兩個檔案各一半**,而且只改一邊完全不會報錯:
//
//   index.html    apple-mobile-web-app-status-bar-style: black-translucent
//   styles.css    .safe-top { padding-top: env(safe-area-inset-top) }
//
// 少了下面那一半,加到主畫面之後 header 上半被瀏海切掉;少了上面那一半,
// `.safe-top` 就只是個沒有效果的 class。而**在一般瀏覽器裡兩者看起來一模一樣**
// —— 沒有進入 standalone 時 `env(safe-area-inset-top)` 是 0。
//
// 也就是說,壞掉的只有「已經把網站加到主畫面」的那些人,而他們最不容易回報。
// Playwright 也驗不到:兩個引擎都不模擬 safe-area inset。所以這裡驗的是「兩半
// 都在」這件靜態事實 —— 這是唯一擋得住的角度。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(HERE, '..', '..', 'index.html'), 'utf8');
const STYLES = fs.readFileSync(path.join(HERE, '..', 'styles.css'), 'utf8');
const APP_TSX = fs.readFileSync(path.join(HERE, '..', 'App.tsx'), 'utf8');

test('狀態列設成 black-translucent', () => {
  assert.match(
    INDEX_HTML,
    /name="apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/,
  );
});

test('viewport-fit=cover 一定要在 —— 少了它 env() 一律回 0', () => {
  // 這條是上面那個 meta 的前提。拿掉之後 black-translucent 仍然「設定成功」,
  // 但所有 safe-area inset 都變 0,於是內容照樣被瀏海蓋住。
  assert.match(INDEX_HTML, /name="viewport"[^>]*viewport-fit=cover/);
});

test('.safe-top 存在,而且真的用了 safe-area-inset-top', () => {
  assert.match(STYLES, /\.safe-top\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/);
});

test('header 掛著 .safe-top —— 這是 black-translucent 的另一半', () => {
  // class 前面還有收合用的 app-chrome*(#136),所以不從字串開頭比對。
  assert.match(APP_TSX, /<header className="[^"]*\bsafe-top\b/);
});

test('底部安全區沒有被順手改掉', () => {
  // .safe-bottom 與 --bottom-nav-h 是同一組保證的另一端(見 CLAUDE.md 的
  // 導覽階梯那節)。改頂端時很容易連著動到它。
  assert.match(STYLES, /\.safe-bottom\s*\{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(STYLES, /--bottom-nav-h:\s*calc\(3\.5rem \+ max\(1rem, env\(safe-area-inset-bottom\)\)\)/);
});

test('theme-color 只能有一條,而且不帶 media', () => {
  // ⚠️ 這條測試原本斷言的是相反的事(要有 light/dark 兩條 media 版本),而那是
  // 錯的 —— #126 那樣改之後,`applyTheme()` 的
  // `querySelector('meta[name="theme-color"]')` 拿到的是第一條(帶
  // `prefers-color-scheme: light`),於是手動切主題再也染不到狀態列,而且完全
  // 無聲。media 版本對這個 app 本來就不對:主題是 class-based 的,使用者可以在
  // 系統深色時選淺色,那時 media 版會讓狀態列跟頁面相反。
  const tags = INDEX_HTML.match(/<meta name="theme-color"[^>]*>/g) ?? [];
  assert.equal(tags.length, 1, `theme-color 應該剛好一條,實際:${tags.join(' ')}`);
  assert.ok(!/media=/.test(tags[0]), `theme-color 不該帶 media:${tags[0]}`);
});

test('applyTheme 會改寫 theme-color —— 上面那條的另一半', () => {
  const theme = fs.readFileSync(path.join(HERE, 'theme.ts'), 'utf8');
  assert.match(theme, /meta\[name="theme-color"\]/);
});

test('canvas 背景掛在 :root,不是 body —— 橡皮筋回彈露的是它', () => {
  // iOS Safari 往上拉超過頂端時露出的是 canvas 背景,而 canvas 取的是 <html>
  // 的 background-color(#131)。掛在 body 或內層 div 上的背景一律看不到。
  assert.match(STYLES, /:root\s*\{[^}]*background-color:\s*#f7f5f2/);
  assert.match(STYLES, /:root\.dark\s*\{[^}]*background-color:\s*#0c0a06/);
});

test('body 不再自帶背景 class —— 否則深色模式下它會蓋回淺米色', () => {
  const body = INDEX_HTML.match(/<body class="([^"]*)"/);
  assert.ok(body, '找不到 body 的 class');
  assert.ok(
    !/\bbg-/.test(body[1]),
    `body 不該帶 bg-* class(背景在 :root):${body[1]}`,
  );
});

// ── header 高度只能有一個真相來源 ──────────────────────────────────────
//
// header 帶著頂端安全區(`.safe-top`),所以它的高度是 `3.5rem + inset`,不是
// `3.5rem`。#126 加上 `.safe-top` 時漏了這件事:`.substick`、兩處 `sticky
// top-14`、Chat / LectureReader 的高度計算、Profile 的 `scroll-mt-20` 全都還
// 寫死 3.5rem/56px。**在一般瀏覽器裡 inset 是 0,完全看不出來** —— 只有加到
// 主畫面、有瀏海的裝置才會看到那些內層 sticky 往上鑽進 header 底下。
//
// 也就是說這一類漂移沒有任何執行期的訊號,只能靠靜態掃描擋。
test('沒有人再寫死 header 高度 —— 一律吃 var(--header-h)', () => {
  const roots = [path.join(HERE, '..')];
  const bad: string[] = [];

  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(tsx?|css)$/.test(e.name)) continue;
      if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue;
      const src = strip(fs.readFileSync(full, 'utf8'));
      // `top-14` 是 Tailwind 的 3.5rem;`3.5rem` 直接出現在 calc 裡也一樣。
      // `--header-h` 的定義本身除外(它就是那個真相來源)。
      for (const m of src.matchAll(/\btop-14\b|3\.5rem/g)) {
        const line = src.slice(0, m.index).split('\n').length;
        const text = src.split('\n')[line - 1]?.trim() ?? '';
        // 兩個變數自己的定義處除外 —— 它們就是真相來源。`--bottom-nav-h` 的
        // 那個 3.5rem 是導覽項目的高度(h-14),跟 header 無關。
        if (text.includes('--header-h:') || text.includes('--bottom-nav-h:')) continue;
        bad.push(`${path.relative(roots[0], full)}:${line}  ${text.slice(0, 90)}`);
      }
    }
  };
  walk(roots[0]);

  assert.deepEqual(bad, [], `這些地方應該改吃 var(--header-h):\n${bad.join('\n')}`);
});

test('--header-h 與 --bottom-nav-h 都含安全區 —— 它們是同一組保證的兩端', () => {
  assert.match(STYLES, /--header-h:\s*calc\(3\.5rem \+ env\(safe-area-inset-top\)\)/);
  assert.match(STYLES, /--bottom-nav-h:\s*calc\(3\.5rem \+ max\(1rem, env\(safe-area-inset-bottom\)\)\)/);
});

test('header 是 fixed,而且 <main> 上下都留了空間', () => {
  // fixed 才不會跟著 iOS 橡皮筋走(#132);脫離文件流之後上下留白都得自己補,
  // 少一邊內容就被那一條蓋住。
  assert.match(APP_TSX, /<header className="[^"]*\bfixed top-0 /);
  assert.match(APP_TSX, /<main className="[^"]*pt-\[var\(--header-h\)\][^"]*pb-\[var\(--bottom-nav-h\)\]/);
});

// ── 捲動時自動收起(#136)────────────────────────────────────────────
//
// 同樣是「兩半都在才有效」的東西,而且同樣在一般瀏覽器裡看不出破綻。

test('<main> 的留白吃 --header-h,不是 --chrome-top', () => {
  // 這條是承重的。跟著 --chrome-top 走的話,收合的那 0.22 秒整份內容會位移 ——
  // 比那 113px 的空間糟得多,而且是每一次捲動都發生。
  const main = APP_TSX.match(/<main className="([^"]*)"/);
  assert.ok(main, '找不到 <main>');
  assert.ok(
    main[1].includes('pt-[var(--header-h)]'),
    `<main> 的 pt 必須是 --header-h:${main[1]}`,
  );
  assert.ok(
    !main[1].includes('--chrome-top'),
    `<main> 不該吃 --chrome-top:${main[1]}`,
  );
});

test('header / 底部導覽都掛著收合用的 class', () => {
  assert.match(APP_TSX, /<header className="[^"]*\bapp-chrome-top\b/);
  assert.match(APP_TSX, /<nav className="[^"]*\bapp-chrome-bottom\b/);
});

test('狀態列底色存在,而且高度是頂端安全區', () => {
  // header 收起來時它是唯一還在的東西。少了它,內容會直接從動態島底下穿過去 ——
  // 而這在非 standalone 的瀏覽器裡完全看不出來(inset 是 0,它高度也是 0)。
  assert.match(APP_TSX, /className="status-scrim/);
  assert.match(
    STYLES,
    /\.status-scrim\s*\{[^}]*height:\s*env\(safe-area-inset-top\)/,
  );
});

test('--chrome-top 預設等於 --header-h —— 沒收起來時兩者不能有差', () => {
  assert.match(STYLES, /--chrome-top:\s*var\(--header-h\)/);
  // 收起時停在安全區下緣,不是 0:停 0 的話內容會跑到時鐘後面。
  assert.match(STYLES, /chrome-hidden[\s\S]{0,120}--chrome-top:\s*env\(safe-area-inset-top\)/);
});

test('收合只在 <md 生效', () => {
  // md 以上右欄是自己的捲動容器,window 捲動跟使用者在捲的不是同一個東西。
  const block = STYLES.slice(STYLES.indexOf('--chrome-top: var(--header-h)'));
  const media = block.slice(0, block.indexOf(':root.chrome-hidden'));
  assert.match(media, /@media \(max-width: 767px\)/);
});

// ── 全螢幕筆記卡自己的頂端安全區(#137)────────────────────────────
//
// `/q/:id` 的個人筆記卡可以放大成 `fixed inset-0 z-50` —— 它蓋在 header 之上,
// 也就是**脫離了 header 的 `.safe-top`**。頂端安全區得自己帶,否則加到主畫面的
// iPhone 上,那條 sticky 工具列會被動態島壓住。
//
// ⚠️ 又是一條在一般瀏覽器裡看不出來的規則:inset 是 0 時,帶不帶 env() 算出來
// 都是 20px。所以 Playwright 也驗不到,只能靜態掃。

test('全螢幕筆記卡的工具列自己帶頂端安全區', () => {
  const QUESTION = fs.readFileSync(path.join(HERE, '..', 'routes', 'Question.tsx'), 'utf8');
  // 全螢幕分支的 class 字串裡必須出現 env(safe-area-inset-top)。
  const fs_ = QUESTION.match(/noteFullscreen\s*\n?\s*\?\s*"sticky top-0[^"]*"/);
  assert.ok(fs_, '找不到全螢幕工具列的 class —— 選擇器腐爛了,這條測試沒在驗東西');
  assert.match(
    fs_[0],
    /env\(safe-area-inset-top\)/,
    `全螢幕工具列要自己帶安全區(它蓋在 header 之上):${fs_[0]}`,
  );
});

test('左下角那顆強制手機版面 FAB 已經搬走(#135)', () => {
  // 設定搬進 /profile 的「顯示」卡。留在 App.tsx 的話會變成兩個入口,
  // 而它們讀的是同一個 localStorage —— 兩邊狀態不同步時完全無聲。
  assert.ok(
    !/ViewportModeFab/.test(APP_TSX.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')),
    'App.tsx 不該再渲染 ViewportModeFab(註解裡提到沒關係)',
  );
});
