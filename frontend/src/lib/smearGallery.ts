// 首頁抹片輪播卡的排程邏輯。**故意不 import 任何東西** —— 同
// `lib/autoHideChrome.ts`,這樣它在 `node --test` 底下載得起來,而元件那層
// 只負責接線(計時器、事件、DOM)。
//
// 這裡回答兩個問題,兩個都是「看起來像壞掉」的來源:
//   1. 下一張是誰(以及什麼時候該去要下一批)
//   2. 這一刻到底該不該自己往前跳

/** 自動輪播間隔。**二十秒**,不是十秒 —— 十秒讀不完一段說明(全螢幕畫的是共筆
 *  詳解全文,平均 1363 字),而讀到一半被換走比等久一點難受得多。 */
export const AUTO_ADVANCE_MS = 20_000;

/** 一批的大小。純文字,一批約十幾 KB —— 見 worker/routes/smear.ts 的說明。 */
export const BATCH_SIZE = 24;

/** 距離批次尾端還剩幾張時就去要下一批。四張 = 40 秒,足夠一趟 RTT 回來,
 *  而且不會在剛進首頁時就多打一支請求。 */
export const PREFETCH_LEAD = 4;

export interface GalleryState<T> {
	/** 目前正在播的這一批。 */
	batch: T[];
	/** 目前在 batch 的第幾張。 */
	index: number;
	/** 已經抓好、等著接上的下一批。沒有就是 null。 */
	next: T[] | null;
}

export function initialGallery<T>(batch: T[] = []): GalleryState<T> {
	return { batch, index: 0, next: null };
}

/**
 * 往前一張。批次播完就換上預抓好的下一批(從頭開始)。
 *
 * ⚠️ **下一批沒抓回來時原地不動,而不是回頭從第一張重播。** 回頭重播看起來
 * 就像「同一批圖一直循環」,而使用者無從分辨那是設計還是壞掉;原地不動至少
 * 只是「停住了」,而下一批一到就會自己接上。
 */
export function advance<T>(s: GalleryState<T>): GalleryState<T> {
	if (s.batch.length === 0) return s;
	if (s.index + 1 < s.batch.length) return { ...s, index: s.index + 1 };
	if (s.next && s.next.length > 0)
		return { batch: s.next, index: 0, next: null };
	return s;
}

/** 往回一張。**不跨批**(上一批已經丟掉了),停在第一張。 */
export function retreat<T>(s: GalleryState<T>): GalleryState<T> {
	return s.index > 0 ? { ...s, index: s.index - 1 } : s;
}

/** 剩下不到 PREFETCH_LEAD 張、而且手上還沒有下一批時,該去要一批了。 */
export function shouldPrefetch<T>(s: GalleryState<T>): boolean {
	if (s.batch.length === 0) return false;
	if (s.next !== null) return false;
	return s.batch.length - s.index <= PREFETCH_LEAD;
}

/** 收下一批預抓回來的結果。**空批次不收** —— 收了會讓 `advance` 以為接得上,
 *  然後換到一個沒有東西的批次上,畫面整個空掉。 */
export function receivePrefetch<T>(
	s: GalleryState<T>,
	items: T[],
): GalleryState<T> {
	if (items.length === 0) return s;
	return { ...s, next: items };
}

export interface AutoAdvanceGate {
	/** 使用者自己按了暫停。 */
	paused: boolean;
	/** 電子紙模式。 */
	eink: boolean;
	/** `document.hidden` —— 分頁在背景。 */
	documentHidden: boolean;
	/** 指標停在卡片上,或卡片裡有東西拿著焦點。 */
	interacting: boolean;
	/** 這一批有東西可播嗎。 */
	hasItems: boolean;
}

/**
 * 這一刻該不該自己往前跳。**四道閘各擋掉一種「看起來像壞掉」:**
 *
 * | 閘             | 擋的是                                                     |
 * | -------------- | ---------------------------------------------------------- |
 * | `eink`         | 電子紙的殘影 + 每次換圖全屏刷新 —— 自動輪播在那上面是災難  |
 * | `documentHidden` | 背景分頁一路換圖、一路載圖,使用者看不到卻在燒流量        |
 * | `interacting`  | 正在讀說明時被換走 —— 這是最容易被回報成「它自己跳掉了」   |
 * | `hasItems`     | 空批次上跑計時器,只是每十秒重跑一次沒有效果的 setState     |
 *
 * ⚠️ `eink` 那道閘讓暫停鈕變成一顆按了沒反應的鍵,所以**元件在 e-ink 下不畫
 * 那顆鈕**(見 SmearGalleryCard)—— 同 CLAUDE.md 手把那節「按下去沒反應的鍵
 * 最傷」。
 */
export function shouldAutoAdvance(g: AutoAdvanceGate): boolean {
	if (!g.hasItems) return false;
	if (g.eink) return false;
	if (g.paused) return false;
	if (g.documentHidden) return false;
	if (g.interacting) return false;
	return true;
}

// ── 暫停偏好 ────────────────────────────────────────────────────────────────
// 裝置的屬性,不是使用者的屬性(同 lib/theme.ts)—— 在會議室大螢幕上想讓它
// 自己跑,在自己筆電上想按著看,兩者不該互相覆蓋。故 localStorage,不進 D1。

const PAUSED_KEY = "smear-gallery-paused";

export function readGalleryPaused(): boolean {
	try {
		return localStorage.getItem(PAUSED_KEY) === "1";
	} catch {
		// Safari 私密瀏覽會讓 localStorage 存取直接 throw
		return false;
	}
}

export function writeGalleryPaused(paused: boolean): void {
	try {
		localStorage.setItem(PAUSED_KEY, paused ? "1" : "0");
	} catch {
		/* 存不進去就算了,當次仍然生效 */
	}
}

// ── 倒數 ────────────────────────────────────────────────────────────────────

/**
 * 距離下一次自動換圖還有幾秒。`deadline` 為 null(自動輪播沒在跑)時回 null,
 * 呼叫端據此決定不畫。
 *
 * **回的是秒數不是毫秒,而且是 `ceil`。** 用 `floor` 的話一設好就顯示 9 —— 十秒
 * 的倒數從 9 開始數,看起來像少了一秒;`ceil` 讓它從 10 開始、在真正換圖的那一
 * 刻才到 0。夾在 0 以上:分頁被丟到背景又切回來時 `now` 可能已經過了 deadline,
 * 負數會閃一下再歸零。
 */
export function secondsLeft(deadline: number | null, now: number): number | null {
	if (deadline === null) return null;
	return Math.max(0, Math.ceil((deadline - now) / 1000));
}
