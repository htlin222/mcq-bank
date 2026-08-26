import { useRef, useState, type ReactNode } from "react";

/**
 * 看過就留著:第一次符合條件時掛載,之後改用 CSS 隱藏,不再拆掉重建。
 *
 * **買到的是狀態,不是時間 —— 別把它當效能改善。** `/q/:id` 的分頁原本寫成
 * `{tab === "x" && <Pane/>}`,切走就整棵卸載,於是個人筆記裡展開到一半的手風琴
 * 會全部收合回去:瞄一眼詳解再切回來,讀到哪裡就沒了。捲動位置同理。
 *
 * 時間不是它的賣點。切分頁的 render + commit 實測只有 0.7ms(1x)/ 4.9ms
 * (CPU 節流 6x)—— `Question.tsx` 的重繪從來就不是瓶頸。**量的時候不要拿
 * `requestAnimationFrame` 當「做完了」的訊號**:一個 rAF 就是一次幀邊界
 * (≈16.7ms),量到的是等待不是工作,而那個假數字曾經讓這段註解寫成
 * 「20–25ms 全是重繪」。React 18 的 sync work 排在 microtask,所以正確的量法是
 * `click()` → `await` 兩層 `queueMicrotask`。
 *
 * 三件事刻意如此:
 *
 * - **第一次是懶掛載,不是預先全掛。** 沒點過的分頁一行 DOM 都不會產生,
 *   只讀題目不看詳解的人不必為此付任何代價。
 * - **隱形時凍住子樹**(見下面)。少了那一步,留著的 pane 愈多、每次切換愈貴。
 * - **隱藏用 `hidden` 屬性而不是 Tailwind 的 `hidden` class。** 這一層不該對版面
 *   有任何意見,而 class 會跟外面那些 `md:block` 之類的前綴打架。
 *
 * ⚠️ **代價:隱形分頁的控制項還留在 DOM 裡。** 使用者碰不到(`hidden` 同時移出
 * a11y tree 與 tab order),但 `document.querySelector('article')` 與
 * `locator("button", {hasText:"編輯"}).first()` 會拿到隱形的那一個。這一頁上的
 * 查詢一律要限定看得見的元素 —— 見 CLAUDE.md「分頁的載入卡頓」那節。
 */
export function KeepAlive({
	active,
	children,
}: {
	active: boolean;
	children: ReactNode;
}) {
	// render 期間更新自己的 state 是 React 認可的「由 props 推導狀態」寫法:
	// 它會在 commit 之前立刻重跑這個元件,不會多一幀。
	const [seen, setSeen] = useState(active);
	if (active && !seen) setSeen(true);

	// **隱形的時候要把子樹凍住。** 天真的實作會讓每次 `setTab` 的重繪連三個 pane
	// 一起跑 —— 留著的東西愈多愈虧。實測(6x 節流)切到詳解 8.5 → 4.4ms、切到
	// 討論串 12.6 → 10ms。
	//
	// 收著上一次的 element 再交回去,React 會看到 `prev === next` 而**整棵跳過**
	// —— 這是 element identity 的短路,不是 memo。隱形時看到的是舊 props,但那
	// 正好是我們要的:它看不見,而重新亮起來時 `active` 為 true,交出去的就是
	// 新的那一份。
	const frozen = useRef<ReactNode>(children);
	if (active) frozen.current = children;

	if (!seen && !active) return null;
	return <div hidden={!active}>{frozen.current}</div>;
}
