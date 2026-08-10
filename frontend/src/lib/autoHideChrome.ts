/**
 * 捲動時把頂端 header 與底部導覽列收起來,往回捲時放回來(#136)。
 *
 * 390×844 上這兩條加起來吃掉 113px,而長文閱讀(詳解、講義、教科書)是這個站的
 * 主要用途 —— 它們從頭到尾都在那裡,但只有在使用者「想去別的地方」時才有用。
 *
 * ## 為什麼是 CSS class 而不是 React state
 *
 * 要動的東西散在三個地方(App.tsx 的 header/nav、Question.tsx 的兩條分頁列、
 * styles.css 的 `.substick`),而且捲動事件是連續的。把 hidden 放進 React state
 * 等於每一幀重新 render 整棵樹 —— 包含 TipTap。改成在 `<html>` 上 toggle 一個
 * class,一次 DOM 寫入,其餘交給 CSS。
 *
 * ⚠️ 這支**不能 import 任何東西** —— 它要能在 `node --test` 底下單獨載入,而
 * `react` 在那裡載不起來。掛鉤在 `hooks/useAutoHideChrome.ts`。
 *
 * ## 為什麼 `<main>` 的留白不跟著變
 *
 * `--header-h` 有兩種角色:`<main>` 的 `pt`(替 fixed header 佔位)與內層 sticky
 * 的停靠點。**只有後者該跟著 header 走**。前者一起變的話,收合過程中整份內容會
 * 邊捲邊位移 —— 比那 113px 糟得多。所以收起時改的是 `--chrome-top`,不是
 * `--header-h`。
 */

/** 累積位移超過這個距離才動作。手指微抖大約 1–4px,8px 足以濾掉又不會遲鈍。 */
export const CHROME_THRESHOLD = 8;

/** 捲動距離在這之內一律顯示 —— 頁面頂端本來就看得到 header,收起來只會閃一下。 */
export const CHROME_REVEAL_ABOVE = 64;

/** `<html>` 上的 class。CSS 那一半在 styles.css 檔尾。 */
export const CHROME_HIDDEN_CLASS = 'chrome-hidden';

export type ScrollSample = {
  /** window.scrollY */
  y: number;
  /** 可捲動的最大距離(scrollHeight - innerHeight) */
  maxY: number;
  /** 小於等於這個距離時一律顯示 */
  revealAbove: number;
  /** 蓋過一切的顯示條件(輸入框聚焦、reduced-motion、opt-out 路由) */
  forceShow: boolean;
};

export type ChromeState = {
  hidden: boolean;
  /** 上一次的 scrollY,用來算 delta */
  lastY: number;
  /** 同方向的累積位移。換方向時歸零 */
  acc: number;
};

/**
 * 以「當下的捲動位置」起算,而不是 0。
 *
 * 少了這一步,從已經捲到一半的位置掛載(換路由、重新整理、返回上一頁)時,第一次
 * 量測的 delta 會是整個 scrollY —— 於是頁面一載入就自己把兩條列收起來,使用者
 * 一根手指都還沒動。
 */
export function seedChrome(y: number): ChromeState {
  return { hidden: false, lastY: y, acc: 0 };
}

export const INITIAL_CHROME: ChromeState = seedChrome(0);

export function nextChromeState(prev: ChromeState, s: ScrollSample): ChromeState {
  if (s.forceShow || s.y <= s.revealAbove) {
    // 累積一併清掉 —— 留著的話,離開頂端的第一下會被舊的量帶著跑。
    // 頂端的橡皮筋(scrollY 為負)也落在這裡:那時本來就該顯示,而且回彈途中
    // 每一格都 ≤ revealAbove,所以不會被讀成「往下捲」。
    return { hidden: false, lastY: s.y, acc: 0 };
  }

  // 底端的橡皮筋要另外擋。iOS 捲到底再往上拉,scrollY 會超過 maxY 再彈回來 ——
  // 彈回來那一段是**負的** delta,會被讀成「往回捲」而把兩條列放出來,但使用者
  // 只是撞到底而已。
  //
  // ⚠️ lastY 要**夾回 maxY**,不能記成過捲後的值。記成 5080 的話,彈回 5000 那一下
  // 就是 -80 的 delta —— 分支擋住了過捲的那幾格,卻放行了回到範圍內的那一格,
  // 等於沒擋。夾住之後 delta 是 0,整段回彈都不算數。
  if (s.y > s.maxY) return { ...prev, lastY: s.maxY };

  const delta = s.y - prev.lastY;
  if (delta === 0) return { ...prev, lastY: s.y };

  // 換方向就重新起算。沿用舊累積的話,往下捲 400px 之後得往回捲 400px 才會有
  // 反應 —— 手感上就是「怎麼拉都拉不回來」。
  const sameDirection = Math.sign(delta) === Math.sign(prev.acc);
  const acc = sameDirection ? prev.acc + delta : delta;

  if (acc >= CHROME_THRESHOLD) return { hidden: true, lastY: s.y, acc };
  if (acc <= -CHROME_THRESHOLD) return { hidden: false, lastY: s.y, acc };
  return { hidden: prev.hidden, lastY: s.y, acc };
}

/**
 * 哪些路由不收合。判準是「這一頁有沒有東西是消失了會出事的」,不是「這一頁長不長」。
 *
 * - `/exam`、`/exam/:sid`:計時與交卷。考試中最不需要的就是「東西不見了」。
 *   `/exam/:sid/result` 是閱讀頁,不在此列。
 * - `/chat`、`/lectures/:slug`:版面是 `100dvh - var(--header-h)` 的自有捲動容器,
 *   window 幾乎不捲(所以本來也不會觸發),但高度算式吃的是 `--header-h`,
 *   明確排除比依賴「剛好不會發生」可靠。
 * - `/play`:整個棋盤要在一屏內,不捲動。
 */
export function chromeAutoHideAllowed(pathname: string): boolean {
  if (pathname === '/chat' || pathname === '/play') return false;
  if (pathname.startsWith('/lectures/')) return false;
  if (pathname === '/exam') return false;
  if (pathname.startsWith('/exam/') && !pathname.endsWith('/result')) return false;
  return true;
}
