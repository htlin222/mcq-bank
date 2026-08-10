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

test('theme-color 分亮/暗兩種,而且留一條沒有 media 的後備', () => {
  // 只有一條 accent 色的話,深色模式下那條瀏覽器 bar 會是亮橘紅、跟頁面接不起來。
  assert.match(INDEX_HTML, /name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"/);
  assert.match(INDEX_HTML, /name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"/);
  const bare = INDEX_HTML.match(/<meta name="theme-color" content="[^"]*"\s*\/>/g) ?? [];
  assert.equal(bare.length, 1, '應該剛好有一條不帶 media 的 theme-color 當後備');
});
