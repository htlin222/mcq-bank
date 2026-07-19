import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCcw } from "lucide-react";
import { api } from "../lib/api";

// 弱點概念地圖 — clusters the user's wrong questions into semantic themes and
// links each to an interleaved drill. A diagnostic surface (retrieval practice
// still does the actual learning), so it points back into 交錯練習.

type Cluster = {
	label: string;
	size: number;
	anchor: string;
	question_ids: string[];
};
type Payload = { clusters: Cluster[]; wrong_count: number };

export function WeaknessMap() {
	const [data, setData] = useState<Payload | null>(null);
	const [loaded, setLoaded] = useState(false);

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
				<p className="text-ink-500 dark:text-ink-400 py-12 text-center">載入中…</p>
			)}

			{loaded && data && data.clusters.length === 0 && (
				<div className="py-12 text-center text-ink-500 dark:text-ink-400">
					{data.wrong_count < 2 ? (
						<p>多做幾題(並累積一些錯題)再回來,這裡就會長出你的弱點分布。</p>
					) : (
						<>
							<p>目前分不出明顯的弱點群。</p>
							<p className="text-sm mt-2">
								(語意索引可能尚未建立,或你的錯題主題太分散。)
							</p>
						</>
					)}
				</div>
			)}

			{loaded && data && data.clusters.length > 0 && (
				<div className="grid gap-4 sm:grid-cols-2">
					{data.clusters.map((cl) => (
						<div
							key={cl.anchor}
							className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 flex flex-col"
						>
							<div className="flex items-baseline justify-between gap-2 mb-4">
								<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100">
									{cl.label}
								</h2>
								<span className="text-sm text-ink-500 dark:text-ink-400 shrink-0">
									{cl.size} 題
								</span>
							</div>
							<Link
								to={`/drill/${cl.anchor}`}
								className="mt-auto inline-flex items-center justify-center gap-1.5 rounded-full bg-accent hover:bg-accent-dark text-white text-sm px-4 py-2 transition"
							>
								<RefreshCcw size={14} /> 交錯練習這組
							</Link>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
