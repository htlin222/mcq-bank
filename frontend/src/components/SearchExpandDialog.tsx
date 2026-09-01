import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Sparkles, X } from "lucide-react";
import { api } from "../lib/api";

/**
 * 「AI 進階搜尋」—— 把一個關鍵字展開成一排寫法變體,再用逗號串起來丟回搜尋框。
 *
 * 解的是這個題庫上每天都在發生的事:同一個東西有好幾種寫法,而全文檢索只認字面
 * —— 打 `AML` 找不到寫成 `acute myeloid leukemia` 的題目,打 `body` 找不到
 * `bodies`。**展開的結果不是另一種查詢語法**,就是逗號分隔的字串,貼回搜尋框
 * 之後跟手打的完全一樣(逗號在 `worker/lib/fts-query.ts` 就是 OR)。
 *
 * 三個判斷:
 *
 * - **產生出來的詞預設全選,但每一個都可以取消。** 模型偶爾會給出離題的同義詞,
 *   而一個離題的 OR 分支會把不相干的題目拉進結果 —— 那比少一個變體糟。
 * - **原查詢那一顆不能取消**(伺服器永遠把它排第一)。全部取消掉之後按套用會
 *   得到一個空的搜尋框,那不是任何人要的。
 * - **套用之後直接搜尋,不要讓使用者再按一次。** 他按這顆按鈕的意圖就是「用這些
 *   字去找」,中間多一步只是把成本轉嫁出去。
 */
export function SearchExpandDialog({
	query,
	onApply,
	onClose,
}: {
	/** 搜尋框現在的內容。 */
	query: string;
	/** 使用者選好的詞,已經用 `, ` 串好 —— 呼叫端只要填回輸入框並搜尋。 */
	onApply(next: string): void;
	onClose(): void;
}) {
	const [terms, setTerms] = useState<string[] | null>(null);
	const [off, setOff] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const closeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	// 焦點進來,Esc 才有人接、鍵盤走訪不會還停在後面的輸入框上。
	useEffect(() => {
		closeRef.current?.focus();
	}, []);

	useEffect(() => {
		let cancelled = false;
		setError(null);
		api
			.post<{ terms: string[] }>("/api/search/expand", { q: query })
			.then((r) => {
				if (!cancelled) setTerms(r.terms ?? []);
			})
			.catch((e: any) => {
				if (cancelled) return;
				// 503 = 模型掛了或額度用完。跟「模型覺得沒有別的寫法」是兩件事,
				// 所以要分開講 —— 後者是正常結果,前者該讓使用者知道可以自己手動
				// 加逗號。
				setError(
					e?.status === 503
						? "AI 這次沒有回應(可能是今天的額度用完了)。你也可以直接在搜尋框用逗號分隔:AML, acute myeloid leukemia"
						: `展開失敗:${e?.data?.error ?? e?.message ?? "請稍後再試"}`,
				);
			});
		return () => {
			cancelled = true;
		};
	}, [query]);

	const selected = (terms ?? []).filter((t, i) => i === 0 || !off.has(t));
	const next = selected.join(", ");

	return createPortal(
		<div
			className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-stretch justify-center sm:items-center sm:p-4"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="AI 進階搜尋"
				className="bg-white dark:bg-ink-800 w-full flex flex-col outline-none h-[100dvh] sm:h-auto sm:max-h-[calc(100dvh-4rem)] sm:max-w-lg sm:rounded-lg sm:border sm:border-ink-200 sm:dark:border-ink-700 sm:shadow-paper"
			>
				<header className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-ink-100 dark:border-ink-700">
					<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 inline-flex items-center gap-2">
						<Sparkles size={17} className="text-accent" />
						AI 進階搜尋
					</h2>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						aria-label="關閉"
						className="p-1 rounded text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
					>
						<X size={18} />
					</button>
				</header>

				<div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-4 text-sm">
					<p className="text-ink-600 dark:text-ink-300 leading-relaxed">
						把「
						<strong className="text-ink-900 dark:text-ink-100">{query}</strong>
						」展開成各種寫法(縮寫與全名、單複數、中英對照),一次全部搜。
					</p>

					{error && (
						<p className="text-rose-700 dark:text-rose-400 leading-relaxed">
							{error}
						</p>
					)}

					{!error && terms === null && (
						<p className="inline-flex items-center gap-2 text-ink-400 dark:text-ink-500">
							<Loader2 size={15} className="animate-spin" /> 想關鍵字中…
						</p>
					)}

					{terms !== null && terms.length <= 1 && !error && (
						<p className="text-ink-500 dark:text-ink-400">
							沒有找到其他常見寫法 —— 直接用原本的關鍵字搜就好。
						</p>
					)}

					{terms !== null && terms.length > 1 && (
						<>
							<div className="flex flex-wrap gap-1.5">
								{terms.map((t, i) => {
									// 第一顆是原查詢,不給取消 —— 全部取消掉之後套用會得到
									// 一個空的搜尋框。
									const locked = i === 0;
									const on = locked || !off.has(t);
									return (
										<button
											key={t}
											type="button"
											disabled={locked}
											aria-pressed={on}
											title={locked ? "你原本的關鍵字,一定會包含" : undefined}
											onClick={() =>
												setOff((prev) => {
													const nextOff = new Set(prev);
													if (nextOff.has(t)) nextOff.delete(t);
													else nextOff.add(t);
													return nextOff;
												})
											}
											className={
												"px-2.5 py-1 rounded-full border text-xs transition " +
												(on
													? "border-accent bg-accent/10 text-accent"
													: "border-ink-200 dark:border-ink-700 text-ink-400 dark:text-ink-500 line-through") +
												(locked ? " cursor-default" : "")
											}
										>
											{t}
										</button>
									);
								})}
							</div>
							{/* 直接把要送出去的字串攤開。這一步不是裝飾:使用者按下套用之後
							    搜尋框就是長這樣,先看到才不會覺得「它偷偷改了我的關鍵字」。 */}
							<p className="text-xs text-ink-400 dark:text-ink-500 break-words">
								搜尋框會變成:
								<span className="font-mono text-ink-600 dark:text-ink-300">
									{" "}
									{next}
								</span>
							</p>
						</>
					)}
				</div>

				<footer className="shrink-0 flex items-center justify-end gap-3 px-5 py-3 border-t border-ink-100 dark:border-ink-700">
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-2 rounded text-sm text-ink-600 dark:text-ink-300 hover:text-accent"
					>
						取消
					</button>
					<button
						type="button"
						disabled={terms === null || terms.length === 0}
						onClick={() => onApply(next)}
						className="bg-accent hover:bg-accent-dark text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-40"
					>
						套用並搜尋
					</button>
				</footer>
			</div>
		</div>,
		document.body,
	);
}
