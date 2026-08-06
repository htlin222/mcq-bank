import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { questionCache } from "../lib/questionCache";
import { useQuestion } from "../hooks/useQuestion";
import { QuestionCard } from "../components/QuestionCard";

// 交錯練習 (interleaving) — walk a set of semantically-related questions,
// mixed across exam years, one at a time. The set comes from
// GET /api/drill/interleave; each question renders through the same
// QuestionCard as 複習模式, so answering + reveal + stats all just work.

type DrillCard = { id: string; year: number; number: number };
type DrillResponse = { anchor: string; questions: DrillCard[] };

export function Drill() {
	const { anchor } = useParams<{ anchor: string }>();
	const navigate = useNavigate();
	const [ids, setIds] = useState<string[] | null>(null);
	const [pos, setPos] = useState(0);
	const [answered, setAnswered] = useState<Record<string, boolean>>({});

	useEffect(() => {
		if (!anchor) return;
		let cancelled = false;
		api
			.get<DrillResponse>(`/api/drill/interleave?anchor=${encodeURIComponent(anchor)}&n=5`)
			.then((r) => {
				if (!cancelled) setIds(r.questions.map((q) => q.id));
			})
			.catch(() => {
				if (!cancelled) setIds([]);
			});
		return () => {
			cancelled = true;
		};
	}, [anchor]);

	const currentId = ids && ids.length > 0 ? ids[pos] : undefined;
	const { data, error, reload } = useQuestion(currentId);

	// 這一組的 id 一開始就全知道,所以左右鄰居可以先抓進 questionCache —— 按下
	// 「下一題」時 useQuestion 同步就讀得到,不必再等一趟網路。
	useEffect(() => {
		if (!ids) return;
		questionCache.prefetch(ids[pos + 1]);
		questionCache.prefetch(ids[pos - 1]);
	}, [ids, pos]);
	const total = ids?.length ?? 0;
	const done = useMemo(
		() => total > 0 && Object.keys(answered).length >= total,
		[answered, total],
	);

	if (!anchor) return null;

	return (
		<div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-32">
			<div className="flex items-center justify-between mb-4">
				<h1 className="text-lg font-medium text-ink-800 dark:text-ink-100">
					交錯練習
					{total > 0 && (
						<span className="ml-2 text-sm text-ink-500 dark:text-ink-400">
							第 {Math.min(pos + 1, total)} / {total} 題
						</span>
					)}
				</h1>
				<Link
					to={`/q/${anchor}`}
					className="text-sm text-accent hover:text-accent-dark"
				>
					← 回原題
				</Link>
			</div>

			{ids === null && (
				<p className="text-ink-500 dark:text-ink-400 py-12 text-center">載入中…</p>
			)}

			{ids !== null && total === 0 && (
				<div className="py-12 text-center text-ink-500 dark:text-ink-400">
					<p>目前找不到可交錯的相似題。</p>
					<p className="text-sm mt-2">
						(語意索引尚未建立,或這題暫時沒有夠近的鄰居。)
					</p>
				</div>
			)}

			{total > 0 && !done && (
				<>
					{error && (
						<p className="text-red-600 dark:text-red-400 py-8 text-center">
							載入題目失敗。
						</p>
					)}
					{data && (
						<QuestionCard
							key={data.id}
							question={data}
							onAnswered={() =>
								setAnswered((a) => ({ ...a, [data.id]: true }))
							}
							onProgressCleared={reload}
						/>
					)}
					<div className="mt-6 flex justify-between">
						<button
							type="button"
							disabled={pos === 0}
							onClick={() => setPos((p) => Math.max(0, p - 1))}
							className="px-4 py-2 rounded border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 disabled:opacity-40"
						>
							上一題
						</button>
						<button
							type="button"
							onClick={() => setPos((p) => Math.min(total - 1, p + 1))}
							disabled={pos >= total - 1}
							className="px-5 py-2 rounded bg-accent hover:bg-accent-dark text-white font-medium disabled:opacity-40"
						>
							下一題
						</button>
					</div>
				</>
			)}

			{done && (
				<div className="py-12 text-center">
					<p className="text-ink-800 dark:text-ink-100 text-lg mb-4">
						完成這組交錯練習 🎉
					</p>
					<button
						type="button"
						onClick={() => navigate(`/q/${anchor}`)}
						className="px-5 py-2 rounded bg-accent hover:bg-accent-dark text-white font-medium"
					>
						回原題
					</button>
				</div>
			)}
		</div>
	);
}
