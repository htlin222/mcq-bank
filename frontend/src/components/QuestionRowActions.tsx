import { Link } from "react-router-dom";
import { ExternalLink, Info } from "lucide-react";
import { questionCache } from "../lib/questionCache";

/**
 * 清單上一列的兩顆「不離開這一頁」的出口:**在新分頁開啟** 與 **查看詳解**。
 *
 * ⚠️ **必須是整列連結的兄弟,不能放進去。** 巢狀 `<a>` 是無效 HTML,瀏覽器解析時
 * 會把內層拉到外層之外,於是那顆按鈕會跑到列的上面、而且點了不一定去對的地方。
 * 所以呼叫端要多包一層 `relative group`,而且**只包整列連結**,不包底下展開的
 * 選項區 —— 否則絕對定位的基準會變成「連同展開的選項」那一整塊,按鈕會飄在很下面。
 *
 * 兩顆的可見性判準**刻意不一樣**,這是這個元件唯一難的地方:
 *
 * - 「在新分頁開啟」hover 才現身(同 NoteSwitcher 的刪除鈕)。檢討時每一列都會看,
 *   但另開分頁不是每一列都要,不該和題號一樣顯眼。觸控裝置上等於看不見 ——
 *   **那是可以接受的**,因為長按整列本來就有系統的「在新分頁開啟」。
 * - 「查看詳解」**預設看得見**,只有真的有指標的裝置才收起來等 hover。它沒有任何
 *   平台等價物,藏起來等於手機上根本沒有這個功能 —— 而手機正是「不想離開清單」
 *   最強烈的地方。
 *
 * **不吃 router state**(成績頁整列連結帶的 `{ fromExam }`):新分頁是一次全新的
 * document,SPA 的 history state 到不了對面 —— 傳了只是讓呼叫端以為有效。
 *
 * `focus:opacity-100` 讓鍵盤走得到。底色要**不透明**(不是 `bg-white/90`):它會蓋
 * 在題幹上,而且 e-ink 那層的顏色掃描要求可見元素的 alpha 必須是 1。
 */
export function QuestionRowActions({
	questionId,
	title,
	onPeek,
}: {
	questionId: string;
	/** 這一列的稱呼,已經含量詞:成績頁是「第 12 題」,錯題回顧是「113-050」。 */
	title: string;
	onPeek(): void;
}) {
	return (
		<>
			<Link
				to={`/q/${questionId}`}
				target="_blank"
				rel="noreferrer"
				title="在新分頁開啟這一題"
				aria-label={`在新分頁開啟${title}`}
				className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 px-2 py-1 text-xs text-ink-500 dark:text-ink-400 opacity-0 transition hover:text-accent hover:border-accent focus:opacity-100 group-hover:opacity-100"
			>
				<ExternalLink size={12} /> 在新分頁開啟
			</Link>
			<button
				type="button"
				onClick={onPeek}
				// 指標一碰就開抓,等於在點擊前偷到一個 RTT。走 questionCache 的
				// prefetch(),所以在飛的、還沒過期的都會自己 no-op。
				//
				// 刻意只掛在**這顆按鈕**上,不掛整列:整列是每一題都會滑過的,
				// 那等於把兩百題全預抓一遍,而 questionCache 的 LRU 只有 40 筆
				// —— 洗掉的正是使用者真的要看的那幾題。碰按鈕是明確的意圖。
				//
				// 觸控沒有 pointerenter,但 pointerdown 仍然早於 click(手指抬起
				// 那段),所以還是偷得到。
				onPointerEnter={() => questionCache.prefetch(questionId)}
				onPointerDown={() => questionCache.prefetch(questionId)}
				onFocus={() => questionCache.prefetch(questionId)}
				title="不離開清單,快速看這一題的詳解"
				aria-label={`查看${title}的詳解`}
				className="absolute right-2 top-10 inline-flex items-center gap-1 rounded border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 px-2 py-1 text-xs text-ink-500 dark:text-ink-400 opacity-100 transition hover:text-accent hover:border-accent focus:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
			>
				<Info size={12} /> 查看詳解
			</button>
		</>
	);
}
