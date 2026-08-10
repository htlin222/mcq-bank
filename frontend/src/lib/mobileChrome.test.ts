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
  assert.match(APP_TSX, /<header className="safe-top /);
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
