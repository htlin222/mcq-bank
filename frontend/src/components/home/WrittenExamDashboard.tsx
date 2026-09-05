import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bookmark, History, AlertTriangle, Scale } from "lucide-react";
import { fetchYears } from "../../lib/yearsApi";
import { api } from "../../lib/api";
import { ActivityHeatmap } from "../ActivityHeatmap";
import { PacingCard } from "../PacingCard";
import { GROUPS, TOTAL_EXAM_COUNT } from "../../lib/groups";
import { formatDueAt, type DueSummary } from "../../lib/due";

type YearMeta = { year: number; count: number };
type Stats = {
	questions_attempted: number;
	total_correct: number;
	total_attempts: number;
	by_year: { year: number; seen: number; correct: number }[];
};

// 首頁「筆試」分頁 —— 原本整個首頁的內容,搬過來時只拿掉了兩塊:考試倒數卡
// (現在是分頁之上的共用區塊,見 Home.tsx)與抹片練習的 quick link(它現在有
// 自己的分頁,不需要在這裡再佔一個位置)。其餘完全不變。
export function WrittenExamDashboard() {
	const [years, setYears] = useState<YearMeta[]>([]);
	const [stats, setStats] = useState<Stats | null>(null);
	// 跨年份到期佇列摘要 — 決定要不要顯示「今天 N 張」CTA。FSRS 排程是筆試
	// MCQ 題庫專屬的概念(CLAUDE.md「抹片練習」那節:不做 FSRS 排程),所以
	// 這塊留在這裡,不搬去共用區塊。
	const [due, setDue] = useState<DueSummary | null>(null);

	useEffect(() => {
		fetchYears().then(setYears);
		api
			.get<Stats>("/api/review/stats")
			.then(setStats)
			.catch(() => setStats(null));
		api
			.get<DueSummary>("/api/review/due")
			.then(setDue)
			.catch(() => setDue(null));
	}, []);

	const totalQuestions = years.reduce((s, y) => s + y.count, 0);
	const seen = stats?.questions_attempted ?? 0;
	const overallPct = totalQuestions
		? Math.round((seen / totalQuestions) * 100)
		: 0;
	const correctPct =
		stats && stats.total_attempts
			? Math.round((stats.total_correct / stats.total_attempts) * 100)
			: 0;

	return (
		<div>
			{/* 跨年份「今天該複習什麼」入口。0 張時只留一行低調文字,不搶版面。 */}
			{due && due.due_total > 0 ? (
				<Link
					to="/due"
					className="mb-8 flex items-center justify-between gap-3 flex-wrap rounded-lg border border-accent/30 bg-accent/5 dark:bg-accent/15 px-4 py-3 hover:border-accent transition"
				>
					<span className="text-ink-800 dark:text-ink-100">
						今天{" "}
						<span className="font-mono text-accent text-lg">
							{due.due_total}
						</span>{" "}
						張到期
					</span>
					<span className="text-xs text-ink-500 dark:text-ink-400">
						到期 {due.due_review} · 學習中 {due.learning} · 新卡{" "}
						{due.new_remaining} →
					</span>
				</Link>
			) : due ? (
				<p className="mb-8 text-xs text-ink-400 dark:text-ink-500">
					今天沒有到期卡片
					{due.next_due_at ? ` · 下一張 ${formatDueAt(due.next_due_at)}` : ""}
				</p>
			) : null}

			{/* 讀書進度預估 — 把倒數與活動量接起來。天數用 API 的 days_left,
			    不是倒數卡的 countdown.days(ceil vs floor,會差一天)。 */}
			<section className="mb-8">
				<PacingCard />
			</section>

			{/* Activity heatmap + stats summary */}
			<section className="mb-10 flex flex-col lg:flex-row gap-4 sm:gap-5 lg:items-stretch">
				<div className="lg:shrink-0">
					<ActivityHeatmap />
				</div>
				<div className="flex-1 grid grid-cols-3 lg:grid-cols-1 lg:grid-rows-3 gap-3 sm:gap-4">
					<StatBlock label="總題數" value={totalQuestions} />
					<StatBlock
						label="已複習"
						value={seen}
						sub={`${overallPct}%`}
						accent
					/>
					<StatBlock
						label="準確率"
						value={`${correctPct}%`}
						sub={`${stats?.total_correct ?? 0}/${stats?.total_attempts ?? 0}`}
					/>
				</div>
			</section>

			{/* Mode cards */}
			<section className="grid sm:grid-cols-3 gap-4 mb-10">
				<Link
					to="/review"
					className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
				>
					<h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
						複習模式
					</h2>
					<p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
						一題一答即時對照詳解,可協作編輯共筆、留言討論、提及他人。
					</p>
				</Link>
				<Link
					to="/exam"
					className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
				>
					<h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
						全真作答
					</h2>
					<p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
						按年度作答模擬考 (
						{GROUPS.map((g) => `${g.count} ${g.label}`).join(" + ")},共{" "}
						{TOTAL_EXAM_COUNT} 題),完賽看分數與錯題回顧。
					</p>
				</Link>
				<Link
					to="/lectures"
					className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
				>
					<h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
						複習班講義
					</h2>
					<p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
						線上閱讀講義 PDF,可螢光標記、頁面筆記 (支援 @114-001
						引用題目)、選取文字 AI 解釋與截圖。
					</p>
				</Link>
			</section>

			{/* Year picker */}
			<section className="mb-10">
				<h2 className="font-serif text-xl text-ink-800 dark:text-ink-200 mb-4">
					依年度 (民國)
				</h2>
				{years.length === 0 ? (
					<p className="text-sm text-ink-400 dark:text-ink-500">
						尚無題目。請使用 import-questions 匯入 CSV。
					</p>
				) : (
					<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 sm:gap-3">
						{years.map((y) => {
							const s = stats?.by_year.find((x) => x.year === y.year);
							const seen = s?.seen ?? 0;
							const correct = s?.correct ?? 0;
							const seenPct =
								y.count > 0 ? Math.round((seen / y.count) * 100) : 0;
							const accPct =
								seen > 0 ? Math.round((correct / seen) * 100) : null;
							return (
								<Link
									key={y.year}
									to={`/year/${y.year}`}
									className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-3 hover:border-accent hover:shadow-paper transition"
								>
									<div className="flex items-baseline gap-2">
										<div className="font-serif text-2xl text-ink-900 dark:text-ink-100">
											{y.year}
											{y.year === 100 && (
												<span className="ml-1 text-xs text-ink-400 dark:text-ink-500 align-middle">
													(模擬)
												</span>
											)}
										</div>
										<div className="text-xs text-ink-500 dark:text-ink-400">
											{y.count} 題
										</div>
									</div>

									{/* eink:軌道補黑框,否則 0% 時整條被洗白、看不見 */}
									<div className="mt-2 h-1.5 rounded-full bg-ink-100 dark:bg-ink-700 overflow-hidden eink:border eink:border-black">
										<div
											className="h-full bg-accent transition-[width]"
											style={{ width: `${Math.min(100, seenPct)}%` }}
										/>
									</div>

									<div className="mt-1.5 flex items-center justify-between text-[11px]">
										<span className="text-ink-500 dark:text-ink-400">
											已複習{" "}
											<span className="font-mono text-ink-700 dark:text-ink-200">
												{seen}
											</span>
											<span className="text-ink-400 dark:text-ink-500">
												/{y.count}
											</span>
										</span>
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
												title="準確率 (本年最近一次作答)"
											>
												{accPct}%
											</span>
										)}
									</div>
								</Link>
							);
						})}
					</div>
				)}
			</section>

			{/* Quick links */}
			<section className="flex gap-4 flex-wrap text-sm">
				<Link
					to="/bookmarks"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<Bookmark size={14} /> 我的收藏
				</Link>
				<Link
					to="/wrong"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<AlertTriangle size={14} /> 錯題回顧
				</Link>
				<Link
					to="/exam-history"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<History size={14} /> 作答紀錄
				</Link>
				<Link
					to="/challenges"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<Scale size={14} /> 答案挑戰
				</Link>
			</section>
		</div>
	);
}

function StatBlock({
	label,
	value,
	sub,
	accent,
}: {
	label: string;
	value: number | string;
	sub?: string;
	accent?: boolean;
}) {
	return (
		<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 sm:p-5 lg:px-6 lg:py-3 shadow-paper flex flex-col justify-center text-center lg:flex-row lg:items-center lg:justify-between lg:text-left">
			<div className="text-xs text-ink-500 dark:text-ink-400 mb-1 lg:mb-0">
				{label}
			</div>
			<div className="lg:text-right">
				<div
					className={`font-serif text-2xl sm:text-3xl ${accent ? "text-accent" : "text-ink-900 dark:text-ink-100"}`}
				>
					{value}
					{/* 窄螢幕自成一行 —— 三欄格線下,值與 sub 併排會被擠出格子
              (「507」「46%」黏成 50746%)。lg 起才回到同一行。 */}
					{sub && (
						<span className="block font-sans text-xs text-ink-400 dark:text-ink-500 lg:inline lg:ml-2">
							{sub}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}
