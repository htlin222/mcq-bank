import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, RefreshCcw } from "lucide-react";
import { api } from "../lib/api";
import { AnswerOptions } from "../components/AnswerOptions";
import { AnswerVerdict } from "../components/AnswerVerdict";
import { BookmarkBadge } from "../components/BookmarkBadge";
import { ExplanationPeek } from "../components/ExplanationPeek";
import { QuestionRowActions } from "../components/QuestionRowActions";
import { groupBadgeClass } from "../lib/groups";
import { type QuestionListRow, rowTitle } from "../lib/questionRow";

// 弱點概念地圖 — clusters the user's wrong questions into semantic themes and
// links each to an interleaved drill. A diagnostic surface (retrieval practice
// still does the actual learning), so it points back into 交錯練習.

type Cluster = {
	label: string;
	size: number;
	anchor: string;
	question_ids: string[];
};
// basis 說明這批群是怎麼分出來的:semantic 走 Vectorize 語意分群(品質較好),
// topic 走 tag_topics 白名單的確定性分群(索引沒涵蓋到時的保底)。舊版 Worker
// 不回這個欄位,所以是選填。
type Payload = {
	clusters: Cluster[];
	wrong_count: number;
	/**
	 * 這一頁那 60 題的列資料,鍵是題號。整批跟著地圖一起回來(伺服器那支
	 * `LIMIT 60`),所以展開一群是**零請求**的 —— 理由寫在 worker 的
	 * `weaknessQuestions`。舊版 Worker 不回這個欄位,所以是選填。
	 */
	questions?: Record<string, QuestionListRow>;
	basis?: "semantic" | "topic";
};

export function WeaknessMap() {
	const [data, setData] = useState<Payload | null>(null);
	const [loaded, setLoaded] = useState(false);
	// 展開的那幾群。**預設全收**:這一頁的價值是「一眼看到自己弱在哪」,
	// 一進來就攤開 60 題等於把那個總覽埋掉。
	const [openClusters, setOpenClusters] = useState<Set<string>>(new Set());
	// 選項的展開狀態,判準與另外三頁完全一致(見 components/AnswerOptions)。
	const [expandAll, setExpandAll] = useState(false);
	const [peek, setPeek] = useState<{ id: string; title: string } | null>(null);

	function toggleCluster(anchor: string) {
		setOpenClusters((prev) => {
			const next = new Set(prev);
			if (next.has(anchor)) next.delete(anchor);
			else next.add(anchor);
			return next;
		});
	}

	useEffect(() => {
		let cancelled = false;
		api
			.get<Payload>("/api/review/weakness-map")
			.then((r) => {
				if (!cancelled) setData(r);
			})
			.catch(() => {
				if (!cancelled) setData({ clusters: [], wrong_count: 0 });
			})
			.finally(() => {
				if (!cancelled) setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div className="max-w-3xl md:max-w-4xl mx-auto px-4 sm:px-6 py-8">
			<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-2">
				弱點概念地圖
			</h1>
			<p className="text-ink-500 dark:text-ink-400 text-sm mb-8">
				把你答錯的題目依語意分群,找出反覆栽跟頭的主題,再用交錯練習各個擊破。
			</p>

			{!loaded && (
				<p className="text-ink-500 dark:text-ink-400 py-12 text-center">
					載入中…
				</p>
			)}

			{loaded && data && data.clusters.length === 0 && (
				<div className="py-12 text-center text-ink-500 dark:text-ink-400">
					{data.wrong_count < 2 ? (
						<p>多做幾題(並累積一些錯題)再回來,這裡就會長出你的弱點分布。</p>
					) : (
						<>
							<p>你的 {data.wrong_count} 題錯題還沒有兩題落在同一個主題上。</p>
							<p className="text-sm mt-2">
								再多做一些,重複踩到的主題就會浮出來。
							</p>
						</>
					)}
				</div>
			)}

			{loaded && data && data.clusters.length > 0 && data.basis === "topic" && (
				<p className="text-xs text-ink-400 dark:text-ink-500 mb-4">
					依主題標籤分群(語意索引尚未涵蓋你最近的錯題)。
				</p>
			)}

			{loaded && data && data.clusters.length > 0 && (
				<>
					{/* 同另外三個清單頁的那顆。放在卡片格線之外,因為它管的是**所有**
					    展開中的題目,不屬於任何一群。 */}
					<div className="flex justify-end mb-3">
						<button
							type="button"
							onClick={() => setExpandAll((v) => !v)}
							aria-pressed={expandAll}
							className="text-xs px-2.5 py-1 rounded border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-ink-400 dark:hover:border-ink-500 transition"
						>
							{expandAll ? "收合全部選項" : "展開全部選項"}
						</button>
					</div>
					<div className="grid gap-4 sm:grid-cols-2 items-start">
						{data.clusters.map((cl) => {
							const open = openClusters.has(cl.anchor);
							// 展開的那一群吃滿整行:題幹 + 五個選項在半欄裡讀不動,而
							// 這一頁的兩欄格線是給「掃過去找弱點」用的,不是給閱讀用的。
							return (
								<div
									key={cl.anchor}
									className={`bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 flex flex-col ${
										open ? "sm:col-span-2" : ""
									}`}
								>
									<div className="flex items-baseline justify-between gap-2 mb-4">
										<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100">
											{cl.label}
										</h2>
										<span className="text-sm text-ink-500 dark:text-ink-400 shrink-0">
											{cl.size} 題
										</span>
									</div>

									{open && (
										<ul className="space-y-2 mb-4">
											{cl.question_ids.map((qid) => {
												const r = data.questions?.[qid];
												// 舊版 Worker 不回 questions,或索引與題庫不同步時
												// 撈不到那一列 —— 整列略過而不是畫一張空卡片。
												if (!r) return null;
												const title = rowTitle(r);
												return (
													<li key={qid}>
														{/* `relative group` 是 QuestionRowActions 的前提
														    (理由寫在那個檔)。**只包整列連結,不包
														    AnswerOptions**。 */}
														<div className="relative group">
															<Link
																to={`/q/${qid}`}
																className="flex gap-3 items-start bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 pr-28 hover:border-accent hover:shadow-paper transition"
															>
																<span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0 w-16 text-right">
																	{title}
																</span>
																<BookmarkBadge
																	questionId={qid}
																	className="mt-1"
																/>
																<span className="flex-1 min-w-0">
																	<span className="block text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed">
																		{r.stem}
																	</span>
																	{r.correct_answer && (
																		<span className="block text-xs text-ink-500 dark:text-ink-400 mt-1">
																			<AnswerVerdict
																				chosen={r.last_chosen ?? null}
																				correctAnswer={r.correct_answer}
																				correct={r.last_correct === 1}
																				seen={(r.times_seen ?? 0) > 0}
																			/>
																		</span>
																	)}
																</span>
																{r.group && (
																	<span
																		className={
																			"text-[11px] px-2 py-0.5 rounded shrink-0 self-center " +
																			groupBadgeClass(r.group)
																		}
																	>
																		{r.group}
																	</span>
																)}
															</Link>
															<QuestionRowActions
																questionId={qid}
																title={title}
																onPeek={() => setPeek({ id: qid, title })}
															/>
														</div>
														{r.correct_answer && (
															<AnswerOptions
																questionId={qid}
																options={r.options ?? {}}
																chosen={r.last_chosen ?? null}
																correctAnswer={r.correct_answer}
																expandAll={expandAll}
															/>
														)}
													</li>
												);
											})}
										</ul>
									)}

									<div className="mt-auto flex flex-wrap gap-2">
										<button
											type="button"
											onClick={() => toggleCluster(cl.anchor)}
											aria-expanded={open}
											className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 text-sm px-4 py-2 hover:border-ink-400 dark:hover:border-ink-500 transition"
										>
											{open ? (
												<ChevronDown size={14} />
											) : (
												<ChevronRight size={14} />
											)}
											{open ? "收合這組" : `看這 ${cl.size} 題`}
										</button>
										<Link
											to={`/drill/${cl.anchor}`}
											className="inline-flex items-center justify-center gap-1.5 rounded-full bg-accent hover:bg-accent-dark text-white text-sm px-4 py-2 transition"
										>
											<RefreshCcw size={14} /> 交錯練習這組
										</Link>
									</div>
								</div>
							);
						})}
					</div>
				</>
			)}

			{peek && (
				<ExplanationPeek
					questionId={peek.id}
					label={peek.title}
					onClose={() => setPeek(null)}
				/>
			)}
		</div>
	);
}
