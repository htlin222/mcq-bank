import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Layers, Loader2 } from "lucide-react";
import { StartDialog } from "../components/smear/StartDialog";
import {
	fetchSmearMeta,
	fetchSmearTopicStats,
	fetchSmearWrong,
	SMEAR_TOPIC_LABELS,
	type SmearMeta,
	type SmearTopicStat,
	type SmearWrongItem,
} from "../lib/smearApi";

// /smear/review —— 複習模式的獨立落地頁,主題式卡片分類。「複習」在手機底部
// 導覽與各處入口一律導來這裡,不再是點下去就直接彈出通用的開始練習對話框
// (那個對話框裡的主題篩選是一排 checkbox,適合微調,不適合當第一個畫面)。
//
// **全真模式沒有對應頁面。** 全真模式的語意是照題庫實際比例抽樣、模擬真考卷
// (見 CLAUDE.md「抹片練習」設計:分層抽樣、PO 不進全真),主題式挑選跟它的
// 用途矛盾 —— 考卷不能讓你只挑會的主題來考。它留在原地,一顆按鈕直接開對話框。
//
// **卡片點下去開的是同一顆 StartDialog,帶 `initialTopics=[該主題]`。**
// 不是另外做一條「立刻用預設值開一場」的捷徑:StartDialog 本來就有題數/
// 作答寫法/題源可調,拿掉這一步等於在某些主題題數很少時讓使用者措手不及。
// 這跟 WrongTab / SmearResult 的「只練這幾個主題」是同一份程式碼路徑
// (見 StartDialog.tsx 的 initialTopics prop),不是抄第二份。
export function SmearReview() {
	const [meta, setMeta] = useState<SmearMeta | null>(null);
	const [metaError, setMetaError] = useState<string | null>(null);
	const [wrong, setWrong] = useState<SmearWrongItem[] | null>(null);
	const [topicStats, setTopicStats] = useState<SmearTopicStat[] | null>(null);
	const [dialogTopics, setDialogTopics] = useState<string[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchSmearMeta()
			.then((m) => {
				if (cancelled) return;
				// 跨 API 邊界的資料要驗過形狀才能用 —— 同 StartDialog.tsx 的教訓:
				// `m.topics` 不是陣列的話,下面的 `.filter()` 會直接把整頁炸掉,
				// 不能等到使用者點進某張卡片、StartDialog 自己的防呆才發現。
				if (!Array.isArray(m.topics)) {
					setMetaError("主題資料格式不正確");
					return;
				}
				setMeta(m);
			})
			.catch((e) => {
				if (!cancelled) setMetaError(String(e));
			});
		fetchSmearWrong()
			.then((r) => {
				if (!cancelled) setWrong(r.items);
			})
			.catch(() => {
				if (!cancelled) setWrong([]);
			});
		fetchSmearTopicStats()
			.then((r) => {
				if (!cancelled) setTopicStats(r.items);
			})
			.catch(() => {
				if (!cancelled) setTopicStats([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// 待加強次數按主題聚合 —— 卡片上只需要一個數字,不需要逐一列出診斷。
	const wrongByTopic = useMemo(() => {
		const m = new Map<string, number>();
		for (const it of wrong ?? []) m.set(it.topic, (m.get(it.topic) ?? 0) + 1);
		return m;
	}, [wrong]);

	const statsByTopic = useMemo(() => {
		const m = new Map<string, SmearTopicStat>();
		for (const s of topicStats ?? []) m.set(s.topic, s);
		return m;
	}, [topicStats]);

	const topics = useMemo(() => {
		if (!meta) return [];
		return Object.keys(SMEAR_TOPIC_LABELS).filter((t) => meta.topics.includes(t));
	}, [meta]);

	return (
		<div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 pb-20">
			<Link
				to="/smear"
				className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1 mb-4"
			>
				<ArrowLeft size={14} /> 回抹片練習
			</Link>

			<h1 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-1">
				複習模式 —— 選擇主題
			</h1>
			<p className="text-ink-500 dark:text-ink-400 text-sm mb-6">
				選一個主題開始;每題作答後立刻看判定與詳解,適合平常累積。
			</p>

			{metaError ? (
				<p className="text-accent text-sm text-center py-10">
					讀取失敗:{metaError}
				</p>
			) : !meta ? (
				<p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500 py-10">
					<Loader2 size={15} className="animate-spin" /> 載入中…
				</p>
			) : (
				<div className="space-y-3">
					{/* 全部主題 —— 不想篩選的人不必離開這一頁。 */}
					<button
						type="button"
						onClick={() => setDialogTopics([])}
						className="w-full text-left bg-white dark:bg-ink-800 border border-dashed border-ink-300 dark:border-ink-600 rounded-lg p-4 hover:border-accent transition"
					>
						<div className="flex items-center gap-2">
							<Layers size={16} className="text-accent" aria-hidden="true" />
							<span className="font-medium text-ink-900 dark:text-ink-100">
								全部主題
							</span>
						</div>
						<p className="text-xs text-ink-500 dark:text-ink-400 mt-1">
							共 {meta.dxCount} 個診斷,不篩選主題
						</p>
					</button>

					{topics.map((t) => {
						const estCount = Math.round(meta.dxCount * (meta.topicWeights[t] ?? 0));
						const wrongN = wrongByTopic.get(t) ?? 0;
						const stat = statsByTopic.get(t);
						const accPct =
							stat && stat.attempts > 0
								? Math.round((stat.score / stat.attempts) * 100)
								: null;
						return (
							<button
								key={t}
								type="button"
								onClick={() => setDialogTopics([t])}
								className="w-full text-left bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 shadow-paper hover:shadow-md hover:border-accent transition"
							>
								<div className="flex items-center justify-between gap-2">
									<span className="font-serif text-lg text-ink-900 dark:text-ink-100">
										{SMEAR_TOPIC_LABELS[t] ?? t}
									</span>
									{wrongN > 0 && (
										<span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
											{wrongN} 個待加強
										</span>
									)}
								</div>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-ink-500 dark:text-ink-400">
									<span>約 {estCount} 個診斷</span>
									{accPct !== null && (
										<span
											className={
												"font-mono " +
												(accPct >= 70
													? "text-emerald-700 dark:text-emerald-300"
													: accPct >= 50
														? "text-amber-700 dark:text-amber-300"
														: "text-rose-700 dark:text-rose-300")
											}
										>
											正確率 {accPct}%
										</span>
									)}
									{stat?.last_answered_at && (
										<span>
											上次{" "}
											{new Date(stat.last_answered_at).toLocaleDateString("zh-TW")}
										</span>
									)}
								</div>
							</button>
						);
					})}
				</div>
			)}

			{dialogTopics && (
				<StartDialog
					initialMode="review"
					initialTopics={dialogTopics.length > 0 ? dialogTopics : undefined}
					onClose={() => setDialogTopics(null)}
				/>
			)}
		</div>
	);
}
