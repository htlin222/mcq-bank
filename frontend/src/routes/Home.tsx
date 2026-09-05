import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, CalendarPlus } from "lucide-react";
import { config } from "../config";
import { loadLastPath, describePath } from "../lib/lastPath";
import { ResumeChip } from "../components/ResumeChip";
import { useMe } from "../hooks/useMe";
import { StudyPlanDialog } from "../components/StudyPlanDialog";
import { KeepAlive } from "../components/KeepAlive";
import { WrittenExamDashboard } from "../components/home/WrittenExamDashboard";
import { SmearDashboard } from "../components/smear/SmearDashboard";

// Exam start time — configured in /config.toml [exam].
const EXAM_DATE = new Date(config.exam.date_iso);

type Countdown = {
	days: number;
	hours: number;
	minutes: number;
	seconds: number;
	total_ms: number;
};

function countdownTo(target: Date): Countdown {
	const total_ms = Math.max(0, target.getTime() - Date.now());
	const totalSec = Math.floor(total_ms / 1000);
	const days = Math.floor(totalSec / 86_400);
	const hours = Math.floor((totalSec % 86_400) / 3_600);
	const minutes = Math.floor((totalSec % 3_600) / 60);
	const seconds = totalSec % 60;
	return { days, hours, minutes, seconds, total_ms };
}

// ── 首頁分頁:「抹片」/「筆試」 ──────────────────────────────────────────
//
// 主力學習模式從筆試(MCQ 題庫)換成抹片練習之後,首頁分兩個分頁:原本整個
// 首頁的內容搬進「筆試」分頁(WrittenExamDashboard,一行內容都沒變),新增
// 「抹片」分頁當作新的主力落地頁(SmearDashboard)。
//
// **兩個分頁永遠都在,不因為主力換了誰就砍掉另一邊。** 下一屆考生可能還是
// 筆試優先 —— 這正是 `config.toml [home] primary_mode` 存在的理由:它只決定
// 「預設開哪一頁」+「手機底部導覽複習/全真/搜尋/收藏四顆指向哪邊」
// (見 App.tsx 的 BottomNav),之後要整個換回筆試優先,改這一個值就好,不用
// 動任何元件邏輯。
//
// **分頁列不分手機/桌機顯示與否 —— 兩種螢幕都看得到,且都可以自由切換。**
// 差別只在預設打開哪一頁(`primary_mode`),不是「手機看不到另一邊」。
//
// **倒數卡是兩個分頁共用的東西,畫在分頁列之上,不重複畫兩次。** 它答的是
// 「考試還剩幾天」,跟練哪個模式無關;而「今天到期複習」那個 FSRS CTA 是
// 筆試 MCQ 題庫專屬的概念(抹片刻意不做 FSRS 排程,見 CLAUDE.md「抹片練習」
// 那節),所以留在 WrittenExamDashboard 裡,不搬上來。
type HomeTab = "exam" | "smear";
const TAB_LABEL: Record<HomeTab, string> = { exam: "筆試", smear: "抹片" };

function isHomeTab(v: string | null): v is HomeTab {
	return v === "exam" || v === "smear";
}

export function Home() {
	const { me } = useMe();
	const [searchParams, setSearchParams] = useSearchParams();
	const tabParam = searchParams.get("tab");
	const tab: HomeTab = isHomeTab(tabParam) ? tabParam : config.home.primary_mode;

	const setTab = (t: HomeTab) =>
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.set("tab", t);
				return next;
			},
			{ replace: true },
		);

	const [countdown, setCountdown] = useState<Countdown>(() =>
		countdownTo(EXAM_DATE),
	);
	// 「繼續上次」— read once on mount; dismissable for this visit.
	const [resume, setResume] = useState(() => loadLastPath());
	const [planOpen, setPlanOpen] = useState(false);

	useEffect(() => {
		// Tick once per second so the SS digits keep up. State updates are cheap
		// here — only the countdown card depends on it.
		const t = window.setInterval(
			() => setCountdown(countdownTo(EXAM_DATE)),
			1000,
		);
		return () => window.clearInterval(t);
	}, []);

	const daysLeft = countdown.days;
	const finished = countdown.total_ms <= 0;

	return (
		<div className="max-w-4xl lg:max-w-5xl xl:max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
			<header className="mb-6 flex items-baseline gap-x-3 gap-y-1 flex-wrap">
				<h1 className="font-serif text-2xl sm:text-3xl text-ink-900 dark:text-ink-100">
					{greeting()}{" "}
					{me?.display_name ? (
						<span className="text-accent">{me.display_name}</span>
					) : (
						""
					)}
				</h1>
				<p className="text-ink-500 dark:text-ink-400 text-sm sm:text-base">
					{config.brand.home_subtitle}
				</p>
			</header>

			{/* Resume where you left off — last visited page, same device. */}
			{resume && (
				<section className="mb-4">
					<ResumeChip
						prefix="上次停留"
						label={describePath(resume.path)}
						to={resume.path}
						onDismiss={() => setResume(null)}
					/>
				</section>
			)}

			{/* Countdown to exam — date and label come from /config.toml [exam].
			    共用區塊,不分分頁 —— 見上面的檔頭說明。 */}
			<section className="mb-8">
				<div className="bg-accent/5 dark:bg-accent/15 border border-accent/30 dark:border-accent/40 rounded-lg px-5 py-3 sm:px-6 flex items-baseline gap-x-3 gap-y-1 flex-wrap">
					<CalendarDays
						className="text-accent shrink-0 self-center"
						size={22}
						strokeWidth={1.5}
					/>
					<span className="text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400">
						{config.exam.countdown_label}
					</span>
					{finished ? (
						<span className="font-serif text-xl sm:text-2xl text-ink-700 dark:text-ink-200">
							考試已開始 — 加油!
						</span>
					) : (
						<>
							<span className="font-serif flex items-baseline gap-2">
								<span
									className={`text-3xl sm:text-4xl ${daysLeft <= 30 ? "text-rose-700 dark:text-rose-400" : daysLeft <= 60 ? "text-amber-700 dark:text-amber-400" : "text-accent dark:text-accent-light"}`}
								>
									{daysLeft}
								</span>
								<span className="text-ink-600 dark:text-ink-300 text-base">
									天
								</span>
							</span>
							<span
								className="font-mono tabular-nums text-ink-600 dark:text-ink-300 text-sm sm:text-base"
								aria-live="polite"
							>
								{String(countdown.hours).padStart(2, "0")}
								<span className="text-ink-400 dark:text-ink-500">:</span>
								{String(countdown.minutes).padStart(2, "0")}
								<span className="text-ink-400 dark:text-ink-500">:</span>
								{String(countdown.seconds).padStart(2, "0")}
							</span>
							<span className="text-ink-500 dark:text-ink-400 text-xs sm:text-sm">
								· {config.exam.date_label}
							</span>
							{/* 靠 ml-auto 推到卡片右緣;self-center 讓它脫離 baseline ——
                跟左邊 text-3xl 的天數對 baseline 會明顯錯位。ghost 樣式:
                這張卡已經有 accent 底色,再放一顆實心鈕會打架。 */}
							<button
								type="button"
								onClick={() => setPlanOpen(true)}
								className="ml-auto self-center inline-flex items-center gap-1.5 rounded-full border border-transparent px-3 py-1 text-xs sm:text-sm text-accent dark:text-accent-light hover:border-accent/50 hover:bg-accent/10 transition"
							>
								<CalendarPlus size={15} strokeWidth={1.75} />
								生成讀書計畫
							</button>
						</>
					)}
				</div>
				{planOpen && <StudyPlanDialog onClose={() => setPlanOpen(false)} />}
			</section>

			<div className="mb-6 inline-flex rounded border border-ink-200 dark:border-ink-700 overflow-hidden" role="tablist" aria-label="首頁分頁">
				{(["exam", "smear"] as const).map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						onClick={() => setTab(t)}
						className={
							"px-4 py-1.5 text-sm transition " +
							(tab === t
								? "bg-accent text-white"
								: "bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700")
						}
					>
						{TAB_LABEL[t]}
					</button>
				))}
			</div>

			<KeepAlive active={tab === "exam"}>
				<WrittenExamDashboard />
			</KeepAlive>
			<KeepAlive active={tab === "smear"}>
				<SmearDashboard />
			</KeepAlive>
		</div>
	);
}

function greeting(): string {
	const h = new Date().getHours();
	if (h < 5) return "凌晨好";
	if (h < 12) return "早安";
	if (h < 18) return "午安";
	return "晚安";
}
