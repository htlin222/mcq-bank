import { useEffect, useState } from "react";
import {
	fetchSmearUsage,
	SMEAR_HINT_LABELS,
	SMEAR_TOPIC_LABELS,
	type SmearUsage,
} from "../../lib/smearApi";

const EMPTY: SmearUsage = {
	hints: Object.keys(SMEAR_HINT_LABELS).map((hint_used) => ({ hint_used, n: 0 })),
	lay_hits: 0,
	review_spelling: { correct: 0, graded: 0 },
	topics: [],
};

function isUsage(v: unknown): v is SmearUsage {
	if (!v || typeof v !== "object") return false;
	const o = v as SmearUsage;
	return (
		Array.isArray(o.hints) &&
		typeof o.lay_hits === "number" &&
		!!o.review_spelling &&
		typeof o.review_spelling.correct === "number" &&
		typeof o.review_spelling.graded === "number" &&
		Array.isArray(o.topics)
	);
}

export function SmearUsageCard() {
	const [data, setData] = useState<SmearUsage | null>(null);

	useEffect(() => {
		let alive = true;
		fetchSmearUsage()
			.then((u) => alive && setData(isUsage(u) ? u : EMPTY))
			.catch(() => alive && setData(EMPTY));
		return () => {
			alive = false;
		};
	}, []);

	const usage = data ?? EMPTY;
	const { correct, graded } = usage.review_spelling;

	return (
		<section
			id="profile-smear"
			className="scroll-mt-[calc(var(--header-h)+1.5rem)] bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6"
		>
			<h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">抹片使用</h2>
			<p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed mb-5">
				只算你自己的作答。進行中的全真不計。複習拼字正確率不含看選項與直接看答案;
				全真的拼字正確數只出現在交卷成績。
			</p>

			<h3 className="text-sm font-medium text-ink-800 dark:text-ink-100 mb-2">提示</h3>
			<table className="w-full text-sm mb-5">
				<tbody>
					{usage.hints.map((h) => (
						<tr key={h.hint_used || "none"} className="border-t border-ink-100 dark:border-ink-700">
							<td className="py-1.5 text-ink-700 dark:text-ink-200">
								{SMEAR_HINT_LABELS[h.hint_used] ?? h.hint_used}
							</td>
							<td className="py-1.5 text-right tabular-nums text-ink-900 dark:text-ink-100">
								{h.n}
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<p className="text-sm text-ink-800 dark:text-ink-100 mb-1">
				俗名層命中 <span className="tabular-nums">{usage.lay_hits}</span>
			</p>
			<p className="text-sm text-ink-800 dark:text-ink-100 mb-5">
				複習拼字完全正確{" "}
				<span className="tabular-nums">
					{correct} / {graded}
				</span>
			</p>

			<h3 className="text-sm font-medium text-ink-800 dark:text-ink-100 mb-2">主題</h3>
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left text-ink-500 dark:text-ink-400">
						<th className="font-medium py-1">主題</th>
						<th className="font-medium py-1 text-right">題量</th>
						<th className="font-medium py-1 text-right">作答</th>
					</tr>
				</thead>
				<tbody>
					{usage.topics.length === 0 ? (
						<tr>
							<td className="py-1.5 text-ink-500" colSpan={3}>
								題量 0、作答 0
							</td>
						</tr>
					) : (
						usage.topics.map((t) => (
							<tr key={t.topic} className="border-t border-ink-100 dark:border-ink-700">
								<td className="py-1.5 text-ink-700 dark:text-ink-200">
									{SMEAR_TOPIC_LABELS[t.topic] ?? t.topic}
								</td>
								<td className="py-1.5 text-right tabular-nums">{t.question_count}</td>
								<td className="py-1.5 text-right tabular-nums">{t.answer_count}</td>
							</tr>
						))
					)}
				</tbody>
			</table>
			{data === null && (
				<p className="mt-3 text-xs text-ink-400">載入中…</p>
			)}
		</section>
	);
}
