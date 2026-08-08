import { useSyncExternalStore } from 'react';
import { config } from '../config';

/**
 * 主題狀態的唯一來源。localStorage-only,不進 D1 —— 主題是裝置的屬性
 * (同一個人的手機想用亮色、電子紙想用 e-ink),不是使用者的屬性。
 *
 * 這支模組是從 ThemeToggle.tsx 抽出來的:ActivityHeatmap 與 Avatar 也需要
 * 知道現在是不是 e-ink(它們的顏色 bake 在 SVG / inline style 裡,CSS 構不到),
 * 而過去它們只能各自 `classList.contains('dark')` 觀察 DOM。
 */
export type Theme = 'light' | 'dark' | 'system' | 'eink';

const STORAGE_KEY = config.storage.theme_storage_key;
const THEMES: readonly string[] = ['light', 'dark', 'eink', 'system'];

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && THEMES.includes(stored) ? (stored as Theme) : 'system';
  } catch {
    // Safari 私密瀏覽會讓 localStorage 存取直接 throw
    return 'system';
  }
}

export function writeTheme(t: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    /* 存不進去就算了,當次 session 仍然生效 */
  }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  const eink = t === 'eink';

  // ⚠️ 不變式:e-ink 絕不同時掛 `.dark`。
  // styles.css 檔尾那整層 1-bit 中和層的前提就是「eink 走 light 那一套
  // utility」—— darkMode:'class' 只認 .dark,兩個 class 同時在的話,1604 處
  // `dark:` 會復活並蓋過中和層,畫面會變成半黑半白的雜燴。
  const wantsDark =
    !eink &&
    (t === 'dark' ||
      (t === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches));

  root.classList.toggle('dark', wantsDark);
  root.classList.toggle('eink', eink);

  // Tint the iOS status-bar / notch area to match the header
  // (bg-white / dark:bg-ink-800 / e-ink 的純白). Static <meta> can't track the
  // manual class-based theme toggle, so keep it in sync here.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', wantsDark ? '#1a160f' : '#ffffff');
}

/** 讀 DOM 而不是讀 localStorage —— `system` 也可能解析成 dark,而元件在意的是
 *  「現在畫面長什麼樣」,不是「使用者選了什麼」。 */
function einkSnapshot() {
  return document.documentElement.classList.contains('eink');
}

function subscribeToThemeClass(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => mo.disconnect();
}

/** 給那些「CSS 覆寫層構不到、必須改渲染」的元件用(ActivityHeatmap、Avatar)。 */
export function useIsEink(): boolean {
  return useSyncExternalStore(
    subscribeToThemeClass,
    einkSnapshot,
    () => false, // SSR/prerender 沒有 DOM;這個 app 不做 SSR,只是型別上的完整
  );
}

// Apply the saved theme immediately on first import so there's no flash.
// (真正的 FOUC 修掉要在 index.html 加 inline script —— 見 vite.config.ts 的
// `%CONFIG_THEME_KEY%`。這行仍然保留,它負責 SPA 內的一致性。)
if (typeof window !== 'undefined') applyTheme(readTheme());
