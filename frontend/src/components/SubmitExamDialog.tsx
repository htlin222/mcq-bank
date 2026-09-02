import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Flag, Loader2 } from "lucide-react";

/**
 * 交卷確認。回報的原話是「有時候不小心就交卷出去了」。
 *
 * 舊版是:全部答完 → **一聲不響直接送出**;有未答題 → 一個原生 `confirm()`。
 * 兩條都不夠:
 *
 * - 交卷鈕就在計時列右上角、緊鄰「暫停」,而手機的拇指正好落在那一帶。單擊即
 *   不可逆,是這一頁唯一一個沒有回頭路的動作。
 * - 原生 `confirm()` 只講得出一句話。使用者在那一刻真正需要知道的是**哪幾題**
 *   沒答、**哪幾題**自己標記了要回頭看 —— 只給一個數字,他只能猜,而猜錯的代價
 *   是整場考試。
 *
 * 所以這裡把「還有什麼沒做完」攤開來,並且**讓每一個題號都是一條回去的路**。
 *
 * ⚠️ **有未答題時是兩段確認,不是把文案寫得更嚇人。** 多一段的成本只落在真的
 * 要提早交卷的人身上(而那是少數);把警語加粗加紅則是每個人都要讀,而讀久了
 * 就不會讀 —— 誤觸照樣發生。
 *
 * **焦點一律落在「安全」的那顆按鈕上。** 這個對話框存在的理由就是有人不小心送
 * 出了,預設焦點放在確認鈕上等於讓一個 Enter 把它整個抵銷掉。
 *
 * **時間到的自動交卷不經過這裡。** 那條路徑沒有「要不要」可以問,而彈一個問完
 * 沒有人回答的對話框,只會讓考卷卡在畫面上送不出去。
 */

export type ExamQuestionRef = {
	/** 卷內索引,點下去就跳到那一題。 */
	idx: number;
	/** 畫面上顯示的題號(自訂測驗跨年份時是卷內序號)。 */
	label: string;
};

const CHIP =
	"aspect-square min-w-8 px-1 text-xs font-mono rounded border transition inline-flex items-center justify-center";

export function SubmitExamDialog({
	stage,
	answered,
	total,
	unanswered,
	marked,
	submitting,
	onJump,
	onAdvance,
	onBack,
	onConfirm,
	onCancel,
	gamepad,
}: {
	/** 1 = 攤開現況;2 = 有未答題時的最終確認。 */
	stage: 1 | 2;
	answered: number;
	total: number;
	unanswered: ExamQuestionRef[];
	marked: ExamQuestionRef[];
	submitting: boolean;
	onJump: (idx: number) => void;
	onAdvance: () => void;
	onBack: () => void;
	onConfirm: () => void;
	onCancel: () => void;
	/** 有手把連著。說明畫在對話框裡面,不進 GamepadFab —— 那顆是 z-30,
	    被這裡的 z-50 遮罩蓋住,寫在那份清單裡等於寫在看不見的地方。 */
	gamepad: boolean;
}) {
	const safeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			// 送出途中不給關 —— 關掉之後畫面上沒有任何東西在說「還在送」,
			// 使用者會再按一次交卷。
			if (e.key === "Escape" && !submitting) onCancel();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onCancel, submitting]);

	// 換段落時重新對焦:第二段的安全鈕是「返回」,跟第一段不是同一顆。
	useEffect(() => {
		safeRef.current?.focus();
	}, [stage]);

	const missing = unanswered.length;
	const title =
		stage === 2
			? `這 ${missing} 題會以 0 分計算`
			: missing > 0
				? "還有題目沒有作答"
				: "確定要交卷?";

	return createPortal(
		<div
			className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-stretch justify-center sm:items-center sm:p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget && !submitting) onCancel();
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="交卷確認"
				className="bg-white dark:bg-ink-800 w-full flex flex-col outline-none h-[100dvh] sm:h-auto sm:max-h-[calc(100dvh-4rem)] sm:max-w-md sm:rounded-lg sm:border sm:border-ink-200 sm:dark:border-ink-700 sm:shadow-paper"
			>
				<header className="dialog-sheet-top shrink-0 flex items-center gap-2 px-5 py-3 border-b border-ink-100 dark:border-ink-700">
					{missing > 0 ? (
						<AlertTriangle size={17} className="shrink-0 text-amber-600" />
					) : (
						<CheckCircle2 size={17} className="shrink-0 text-accent" />
					)}
					<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100">
						{title}
					</h2>
				</header>

				<div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-4 text-sm">
					<p className="text-ink-700 dark:text-ink-200">
						已作答{" "}
						<strong className="text-ink-900 dark:text-ink-100 tabular-nums">
							{answered} / {total}
						</strong>{" "}
						題
						{missing > 0 && (
							<span className="text-amber-700 dark:text-amber-300">
								{" "}
								· 還有 {missing} 題空白
							</span>
						)}
					</p>

					{stage === 2 ? (
						<p className="text-ink-700 dark:text-ink-200 leading-relaxed">
							交卷之後不能再作答,也不能取消。沒有作答的
							<strong className="text-ink-900 dark:text-ink-100">
								{" "}
								{missing} 題{" "}
							</strong>
							會直接算錯。
						</p>
					) : (
						<>
							{missing > 0 && (
								<section>
									<h3 className="text-xs uppercase tracking-wide text-ink-400 mb-2">
										未作答 · 點題號回去作答
									</h3>
									<div className="flex flex-wrap gap-1.5">
										{unanswered.map((q) => (
											<button
												key={q.idx}
												type="button"
												onClick={() => onJump(q.idx)}
												className={`${CHIP} border-ink-300 dark:border-ink-600 text-ink-600 dark:text-ink-300 hover:border-accent hover:text-accent`}
												title={`回到第 ${q.label} 題`}
											>
												{q.label}
											</button>
										))}
									</div>
								</section>
							)}

							{/* 標記題單獨列一區。它們是使用者**自己**說「待會要回來看」的,
							    而交卷是那個「待會」的最後一刻 —— 只講未答題會漏掉這一半。 */}
							{marked.length > 0 && (
								<section>
									<h3 className="text-xs uppercase tracking-wide text-ink-400 mb-2 inline-flex items-center gap-1">
										<Flag size={11} className="fill-amber-500 text-amber-600" />
										已標記待檢查 {marked.length} 題
									</h3>
									<div className="flex flex-wrap gap-1.5">
										{marked.map((q) => (
											<button
												key={q.idx}
												type="button"
												onClick={() => onJump(q.idx)}
												className={`${CHIP} border-amber-500 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 hover:border-accent`}
												title={`回到第 ${q.label} 題`}
											>
												{q.label}
											</button>
										))}
									</div>
								</section>
							)}

							{missing === 0 && marked.length === 0 && (
								<p className="text-ink-500 dark:text-ink-400 leading-relaxed">
									全部作答完畢,也沒有標記待檢查的題目。交卷之後不能再作答。
								</p>
							)}
						</>
					)}

					{gamepad && (
						<p className="pt-1 text-[11px] text-ink-400 dark:text-ink-500">
							<span className="font-mono">START / FACE ▼</span>{" "}
							{stage === 2 || missing === 0 ? "確定交卷" : "仍要交卷"} ·{" "}
							<span className="font-mono">FACE ▶</span>{" "}
							{stage === 2 ? "返回" : "關掉這個對話框"}
						</p>
					)}
				</div>

				<footer className="dialog-sheet-bottom shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t border-ink-100 dark:border-ink-700">
					{stage === 2 ? (
						<>
							<button
								ref={safeRef}
								type="button"
								onClick={onBack}
								disabled={submitting}
								className="px-3 py-2 rounded text-sm text-ink-600 dark:text-ink-300 hover:text-accent disabled:opacity-40"
							>
								返回
							</button>
							<button
								type="button"
								onClick={onConfirm}
								disabled={submitting}
								className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-dark text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-40"
							>
								{submitting && <Loader2 size={14} className="animate-spin" />}
								{submitting ? "交卷中…" : "確定交卷"}
							</button>
						</>
					) : missing > 0 ? (
						<>
							{/* 低調的那一顆才是「仍要交卷」—— 主按鈕留給回去作答。 */}
							<button
								type="button"
								onClick={onAdvance}
								disabled={submitting}
								className="px-3 py-2 rounded text-sm text-ink-500 dark:text-ink-400 border border-ink-200 dark:border-ink-700 hover:border-ink-400 disabled:opacity-40"
							>
								仍要交卷
							</button>
							<button
								ref={safeRef}
								type="button"
								onClick={() => onJump(unanswered[0].idx)}
								className="bg-accent hover:bg-accent-dark text-white px-4 py-2 rounded text-sm font-medium"
							>
								回去作答
							</button>
						</>
					) : (
						<>
							<button
								ref={safeRef}
								type="button"
								onClick={onCancel}
								disabled={submitting}
								className="px-3 py-2 rounded text-sm text-ink-600 dark:text-ink-300 hover:text-accent disabled:opacity-40"
							>
								再檢查一下
							</button>
							<button
								type="button"
								onClick={onConfirm}
								disabled={submitting}
								className="inline-flex items-center gap-1.5 bg-accent hover:bg-accent-dark text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-40"
							>
								{submitting && <Loader2 size={14} className="animate-spin" />}
								{submitting ? "交卷中…" : "確定交卷"}
							</button>
						</>
					)}
				</footer>
			</div>
		</div>,
		document.body,
	);
}
