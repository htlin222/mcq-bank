import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { choicePct, type StatsPayload } from "../lib/choiceStats";
import { createGate } from "../lib/requestQueue";

/**
 * 一題的**選項全文 + 選項分布**,可展開收合。
 *
 * 原本只長在成績頁上(`ExamResult.tsx` 的 `AnswerDetail`)。錯題回顧要的是同一件
 * 事 —— 檢討一題錯在哪,第一個問題永遠是「那另外四個是什麼」—— 所以抽出來共用,
 * 而不是在第二個地方再寫一份。**兩份的代價不是行數,是漂移**:e-ink 那三種語意
 * (正解=整列反白 / 選錯=粗框+刪除線 / 其他=細框)、`min-w-0 + break-words`、
 * 分布長條在 1-bit 下改畫成貼底黑槓 —— 每一條都是踩過才長出來的,而抄漏任何一條
 * 的症狀都只是「另外那一頁看起來怪怪的」。
 *
 * 選項文字**跟著清單一起回來**(`/api/exam/:sid` 與 `/api/review/wrong` 都有),
 * 所以展開是即時的、不打任何請求;分布仍然懶載入 —— 200 題全部預抓等於 200 個
 * request,所以只在展開該題時才打 `/stats`(每題最多一次)。
 *
 * 兩者合成同一列而不是各畫一區:分開的話同一個字母會在畫面上出現兩次,讀者得
 * 自己把「B 寫的是什麼」跟「B 有幾成人選」對起來 —— 那正是檢討時最不想做的事。
 *
 * 列的來源是**題目的選項**,不是 stats 回來的 letters:人數不足 / 未作答 /
 * 載入失敗時都沒有分布,但選項仍然要看得到,那才是展開的主要目的。
 */

// 選項分布的請求閘門。「展開全部選項」會讓所有展開區同時打開,而 HTTP/2 沒有
// 瀏覽器那條「每個 origin 最多 6 條連線」的天然上限 —— 不排隊的話一次點擊就是
// 兩百個 fetch 同時飛出去。**模組層共用一個**,因為要限的是整頁的同時在飛數;
// 每個頁面各開一個閘門,就等於同時開著兩頁時上限翻倍。
const statsGate = createGate(6);

export function AnswerOptions({
	questionId,
	options,
	chosen,
	correctAnswer,
	expandAll,
	toolbar,
}: {
	questionId: string;
	/** 字母 → 選項全文。 */
	options: Record<string, string>;
	/** 這個人上次選的(成績頁是這一場的作答,錯題回顧是 `last_chosen`)。 */
	chosen: string | null;
	correctAnswer: string;
	/** 頁面層級的「展開全部選項」。切換的那一刻同步過來,之後這一題仍可單獨開關。 */
	expandAll: boolean;
	/** 接在「展開選項」右邊的額外動作(成績頁的「登記進複習進度」)。 */
	toolbar?: ReactNode;
}) {
	// 初始值就吃 expandAll —— 換篩選會讓新出現的卡片重新掛載,少了它,展開全部之後
	// 切到「全部」會看到新的那幾題是收合的,而按鈕還寫著「收合全部選項」。
	const [open, setOpen] = useState(expandAll);
	const [stats, setStats] = useState<StatsPayload | null>(null);
	const [failed, setFailed] = useState(false);

	// 全部展開/收合。**只在 expandAll 真的變了才同步**(靠 deps),不是每次 render
	// 都推 —— 否則單獨收合某一題會立刻被推回去(expandAll 還是 true),看起來像
	// 那顆按鈕壞了。
	useEffect(() => {
		setOpen(expandAll);
	}, [expandAll]);

	useEffect(() => {
		if (!open || stats) return;
		let cancelled = false;
		// 排隊送,不要一次全部飛出去(見 lib/requestQueue.ts)。已經排進隊伍的請求
		// 在收合之後仍然會送出 —— 這裡只擋 setState,不取消請求:要取消得把
		// AbortController 一路傳進 api.get(),而這支的回應本來就會留著當快取。
		void statsGate(() =>
			api.get<StatsPayload>(`/api/questions/${questionId}/stats`),
		)
			.then((r) => {
				if (!cancelled) setStats(r);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [open, stats, questionId]);

	const fromQuestion = Object.keys(options);
	// 舊 session 或 options_json 壞掉時退回 stats 的 letters —— 至少畫得出分布,
	// 不會整個展開區空白。
	const letters =
		fromQuestion.length > 0
			? fromQuestion
			: stats?.choices_state === "ok"
				? Object.keys(stats.choice_pct ?? {})
				: [];

	return (
		<div className="px-3 pb-1">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-controls={`opts-${questionId}`}
				className="text-xs text-ink-400 dark:text-ink-500 hover:text-accent py-1"
			>
				{open ? "收合選項" : "展開選項"}
			</button>
			{toolbar}
			{open && (
				<div id={`opts-${questionId}`} className="pb-2 space-y-1">
					<ul className="space-y-1">
						{letters.map((L) => {
							const pct = choicePct(stats, L);
							const isCorrect = L === correctAnswer;
							const picked = L === chosen;
							// 顏色沒了之後語意要換一個維度重講(同 QuestionCard 的選項列):
							//   正解      → 整列反白
							//   選錯的    → 粗框 + 選項文字刪除線
							//   其他      → 細框
							const cls = isCorrect
								? "border-emerald-500 bg-emerald-50 dark:bg-emerald-500/15 eink-invert"
								: picked
									? "border-rose-500 bg-rose-50 dark:bg-rose-500/15 eink:border-2"
									: "border-ink-200 dark:border-ink-700";
							return (
								<li
									key={L}
									className={`relative flex items-start gap-2 overflow-hidden rounded border px-2 py-1.5 text-xs ${cls}`}
								>
									{pct !== null && (
										<span
											aria-hidden
											className={
												"absolute inset-y-0 left-0 pointer-events-none " +
												(isCorrect
													? "bg-accent/15"
													: "bg-ink-200/60 dark:bg-ink-600/40") +
												// 淡色填充在 1-bit 下會被洗白 → 整條消失。改成貼底的細
												// 黑槓:資訊還在,又不會跟「正解=整列反白」搶同一個維度。
												// 正解列不加 —— 黑槓畫在黑底上看不見。
												(isCorrect
													? ""
													: " eink:inset-y-auto eink:bottom-0 eink:h-px eink:bg-black")
											}
											style={{ width: `${pct}%` }}
										/>
									)}
									<span className="relative font-mono font-semibold text-ink-700 dark:text-ink-300 shrink-0">
										{L}
									</span>
									{/* min-w-0 + break-words 兩個一起才有用:選項裡的
                      DEK::NUP214 這種整串不可斷,少了前者會把右側標籤擠出去。 */}
									<span
										className={
											"relative min-w-0 flex-1 break-words leading-relaxed text-ink-800 dark:text-ink-200" +
											(picked && !isCorrect ? " eink:line-through" : "")
										}
									>
										{options[L] ?? ""}
									</span>
									<span className="relative shrink-0 self-center inline-flex items-center gap-1.5 text-ink-500 dark:text-ink-400">
										{pct !== null && <span className="tabular-nums">{pct}%</span>}
										{isCorrect && (
											<span className="whitespace-nowrap">✓ 正解</span>
										)}
										{picked && !isCorrect && (
											<span className="whitespace-nowrap">你選的</span>
										)}
									</span>
								</li>
							);
						})}
					</ul>
					{/* 分布的狀態訊息放在選項**之後**:選項是展開的主要目的,把
              「作答人數不足」擺在最上面會讓人以為整區沒有東西可看。 */}
					<div className="text-xs text-ink-500 dark:text-ink-400">
						{failed && <p>選項分布載入失敗</p>}
						{!failed && !stats && <p>分布載入中…</p>}
						{stats?.choices_state === "not_answered" && (
							<p>本題你未作答,作答後才會顯示分布</p>
						)}
						{stats?.choices_state === "below_threshold" && (
							<p>作答人數不足,暫不顯示選項分布</p>
						)}
						{stats?.choices_state === "ok" && <p>{stats.choice_responders} 人作答</p>}
					</div>
				</div>
			)}
		</div>
	);
}
