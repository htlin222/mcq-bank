/**
 * 拖曳重排的兩個純函式(#140)。
 *
 * 拆出來的理由跟 `autoHideChrome.ts` 一樣:難的不是「拖了就換位置」,而是**落點
 * 的邊界** —— 往下拖時「越過第 n 項」的門檻在哪、拖到清單外面算第幾項、放回原位
 * 該不該算一次改動。這些在瀏覽器裡要靠模擬指標事件才試得出來,而那種測試會隨
 * 時序飄。
 *
 * ⚠️ 這支**不能 import 任何東西** —— 要能在 `node --test` 底下單獨載入。
 */

/** 把 `from` 搬到 `to`,回傳新陣列。越界的索引夾回範圍內。 */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
	const n = arr.length;
	if (n === 0) return [];
	const f = Math.min(Math.max(from, 0), n - 1);
	const t = Math.min(Math.max(to, 0), n - 1);
	const next = arr.slice();
	const [item] = next.splice(f, 1);
	next.splice(t, 0, item);
	return next;
}

/**
 * 指標在 `y` 時,被拖的那一項應該落在第幾個位置。
 *
 * @param mids 每一項**中線**的 y 座標,依目前畫面上的順序(含被拖的那一項)
 * @param y    指標的 y 座標
 * @param from 被拖的那一項現在在第幾個位置
 *
 * **門檻是鄰居的中線,不是自己的。** 這一條是實測出來的:握把在自己那一列的正
 * 中央,所以把自己的中線也算進去時,往下移 3px 就越過了 —— 手指還沒離開原本那
 * 一列,順序就跳了一次。排除自己之後,要真的蓋過下一項的一半才換位,兩個方向
 * 對稱。
 *
 * 用中線而不是上/下緣:用上緣的話,往下拖必須整個蓋過下一項才會換位,手感是
 * 「拖了很久都沒反應」。
 *
 * 清單外面一律夾到頭尾 —— 拖出選單再放開時,最不意外的結果是停在最近的一端,
 * 而不是彈回原位(那看起來像操作失敗)。
 */
export function dropIndex(mids: readonly number[], y: number, from: number): number {
	if (mids.length === 0) return 0;
	const others = mids.filter((_, i) => i !== from);
	let i = 0;
	while (i < others.length && y > others[i]) i++;
	// i 已經是「拿掉自己之後要插進去的位置」,也就是新陣列裡的索引。
	return Math.min(i, mids.length - 1);
}

/** 兩個順序一樣嗎?用來判斷這次拖曳要不要真的送出請求。 */
export function sameOrder(a: readonly number[], b: readonly number[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
