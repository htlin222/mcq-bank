import { config } from '../config';

/**
 * 「強制手機版面」——(#94)在平板/電子紙上把整個 app 切成手機版。
 *
 * ── 為什麼是改 viewport meta,而不是加一個「假裝很窄」的旗標 ──────────────
 * 全站的版面幾乎都寫在 Tailwind 的 `md:` / `lg:` utility 裡,而 media query 問的
 * 是**視窗寬度**,不是任何 React state。所以「強制手機版面」只有兩條路:把三千多
 * 處 utility 改寫成 container query,或是讓瀏覽器相信視窗就是那麼窄。後者是一行。
 *
 * ── 這在桌機上不會有作用,而且那是刻意的 ──────────────────────────────
 * 桌機 Chrome / Safari **完全忽略** viewport meta(它是行動瀏覽器的東西)。所以
 * 這顆按鈕只在 `(pointer: coarse)` 的裝置上出現 —— 顯示一顆在 Mac 上按了沒反應的
 * 按鈕,比沒有這顆按鈕更糟。BOOX 是 Android,吃這一套。
 *
 * ── 為什麼是 560 ────────────────────────────────────────────────────
 * 要小於 Tailwind 的 `md`(768)才會拿到手機版面,也要小於 `sm`(640)底部導覽列
 * 才會回來(它是 `md:hidden` + `--bottom-nav-h`,而手機版的導覽就靠它)。560 兩個
 * 條件都滿足,而且在 ~830px 的 BOOX 上等於把所有內容放大約 1.5 倍 —— 在電子紙上
 * 那是附帶的好處,不是副作用。
 *
 * localStorage-only,同 lib/theme.ts:這是「這台裝置怎麼顯示」,不是「這個人是誰」。
 */
export type ViewportMode = 'auto' | 'mobile';

const STORAGE_KEY = config.storage.viewport_storage_key;
const MOBILE_WIDTH = 560;

/**
 * 純函式,所以「切過去/切回來各該送什麼字串」有測試擋著。
 * `viewport-fit=cover` 兩邊都要帶 —— 少了它,瀏海機/圓角螢幕的 safe-area
 * inset 會歸零,底部導覽列會被系統手勢條吃掉一截。
 */
export function viewportContent(mode: ViewportMode): string {
  return mode === 'mobile'
    ? `width=${MOBILE_WIDTH}, initial-scale=1.0, viewport-fit=cover`
    : 'width=device-width, initial-scale=1.0, viewport-fit=cover';
}

export function readViewportMode(): ViewportMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'mobile' ? 'mobile' : 'auto';
  } catch {
    // Safari 私密瀏覽會讓 localStorage 存取直接 throw
    return 'auto';
  }
}

export function writeViewportMode(mode: ViewportMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 存不進去就算了,當次 session 仍然生效 */
  }
}

export function applyViewportMode(mode: ViewportMode): void {
  const meta = document.querySelector('meta[name="viewport"]');
  // index.html 一定有這個 tag;真的沒有就補一個,而不是靜靜什麼都不做。
  if (meta) {
    meta.setAttribute('content', viewportContent(mode));
    return;
  }
  const el = document.createElement('meta');
  el.setAttribute('name', 'viewport');
  el.setAttribute('content', viewportContent(mode));
  document.head.appendChild(el);
}

/**
 * 這台裝置的 viewport meta 有沒有意義。桌機瀏覽器整個忽略它,所以 FAB 也不該出現。
 * `(pointer: coarse)` 是最接近「行動瀏覽器引擎」的可用訊號 —— 觸控筆電會誤判成
 * 有,代價只是多一顆按不出效果的按鈕,而漏判(平板被當成桌機)才是真的傷。
 */
export function viewportModeSupported(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

// 開檔即套用,同 theme.ts —— 晚一步的話,第一幀會用裝置寬度排完再跳一次。
if (typeof window !== 'undefined') applyViewportMode(readViewportMode());
