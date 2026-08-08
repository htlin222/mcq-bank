import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

// 信心校準面板 — shows per-confidence-bucket accuracy and the recent
// 高信心卻答錯 (hypercorrection candidate) list. A well-calibrated learner's
// bars climb left→right; a high "有把握" bar that isn't near 100% is the
// blind spot worth chasing.

type Bucket = {
	confidence: 1 | 2 | 3;
	n: number;
	correct: number;
	accuracy: number | null;
};
type HighConfWrong = {
	question_id: string;
	year: number;
	number: number;
	stem: string;
	at: number;
};
type Payload = { buckets: Bucket[]; high_conf_wrong: HighConfWrong[] };

const LABEL: Record<1 | 2 | 3, string> = { 1: "猜", 2: "普通", 3: "有把握" };

export function ConfidenceCalibration() {
	const [data, setData] = useState<Payload | null>(null);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		api
			.get<Payload>("/api/review/calibration")
			.then((r) => {
				if (!cancelled) setData(r);
			})
			.catch(() => {
				/* best-effort panel */
			})
			.finally(() => {
				if (!cancelled) setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const total = data?.buckets.reduce((s, b) => s + b.n, 0) ?? 0;
	if (!loaded) return null;
	if (total === 0) {
		return (
			<div className="text-sm text-ink-500 dark:text-ink-400">
				作答時選一下「信心」,這裡就會顯示你的信心校準曲線與高信心錯題。
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				{data!.buckets.map((b) => {
					const pct = b.accuracy === null ? 0 : Math.round(b.accuracy * 100);
					return (
						<div key={b.confidence} className="flex items-center gap-3">
							<span className="w-14 shrink-0 text-sm text-ink-600 dark:text-ink-300">
								{LABEL[b.confidence]}
							</span>
							<div className="flex-1 h-3 rounded-full bg-ink-100 dark:bg-ink-700 overflow-hidden eink:border eink:border-black">
								<div
									className="h-full bg-accent rounded-full transition-all"
									style={{ width: `${pct}%` }}
								/>
							</div>
							<span className="w-24 shrink-0 text-right text-xs text-ink-500 dark:text-ink-400 tabular-nums">
								{b.n === 0 ? "—" : `${pct}% (${b.correct}/${b.n})`}
							</span>
						</div>
					);
				})}
			</div>

			{data!.high_conf_wrong.length > 0 && (
				<div>
					<h3 className="text-sm font-medium text-ink-700 dark:text-ink-200 mb-2">
						你標「有把握」卻答錯 ({data!.high_conf_wrong.length})
					</h3>
					<ul className="space-y-1">
						{data!.high_conf_wrong.map((q) => (
							<li key={`${q.question_id}:${q.at}`}>
								<Link
									to={`/q/${q.question_id}`}
									className="flex items-baseline gap-2 text-sm hover:text-accent"
								>
									<span className="font-mono text-xs text-ink-400 dark:text-ink-500 shrink-0">
										{q.year}-{String(q.number).padStart(3, "0")}
									</span>
									<span className="line-clamp-1 text-ink-700 dark:text-ink-200">
										{q.stem}
									</span>
								</Link>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
