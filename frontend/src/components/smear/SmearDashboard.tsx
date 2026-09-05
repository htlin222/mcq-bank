import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
	AlertTriangle,
	BookOpen,
	History,
	Microscope,
	Scale,
	Timer,
	Video,
} from "lucide-react";
import { ModeCard } from "../../routes/Smear";
import {
	fetchSmearSessions,
	fetchSmearWrong,
	SMEAR_TOPIC_LABELS,
	type SmearHistoryItem,
	type SmearWrongItem,
} from "../../lib/smearApi";

// 首頁的抹片 dashboard —— 主力學習模式的落地頁(見 config.toml [home]
// primary_mode)。跟 `/smear` 的「練習」分頁不重複:那裡是「開始一場練習」,
// 這裡是「一眼看到整體表現 + 最快兩下進入練習」,並把手機唯一能到講義/
// 錯題/作答紀錄/答案挑戰/影片的路接住(見下面「捷徑列」的說明)。
//
// **統計全部從既有 `/api/smear/*` 端點算出,沒加新後端。** CLAUDE.md「抹片
// 練習」那節說得很清楚:首頁熱力圖/弱點地圖/成績頁一律不混入抹片 —— 這裡是
// 反過來的情況,是抹片**自己**的統計,跟筆試的數字完全不共用同一份查詢,
// 兩邊各自的真相不會互相污染。
export function SmearDashboard() {
	const navigate = useNavigate();
	const [sessions, setSessions] = useState<SmearHistoryItem[] | null>(null);
	const [wrong, setWrong] = useState<SmearWrongItem[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchSmearSessions()
			.then((r) => {
				if (!cancelled) setSessions(r.items);
			})
			.catch(() => {
				if (!cancelled) setSessions([]);
			});
		fetchSmearWrong()
			.then((r) => {
				if (!cancelled) setWrong(r.items);
			})
			.catch(() => {
				if (!cancelled) setWrong([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// 整體正確率算自「已完成場次」的 score/max_score 加總 —— 這兩個欄位本來
	// 就在 GET /api/smear/sessions 的清單回應裡(見 smearApi.ts 的
	// SmearHistoryItem),不必為了首頁多打一支逐場撈 breakdown 的端點。
	const finished = useMemo(
		() => (sessions ?? []).filter((s) => s.finished_at != null),
		[sessions],
	);
	const totalScore = finished.reduce((sum, s) => sum + (s.score ?? 0), 0);
	const totalMax = finished.reduce((sum, s) => sum + (s.max_score ?? 0), 0);
	const accuracyPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : null;

	// worst-first 前 5 個,同 /smear?tab=wrong 的排序依據(worker 端已經
	// worst-first 排好,這裡不重排)。
	const topWrong = (wrong ?? []).slice(0, 5);

	return (
		<div className="space-y-6">
			{/* 統計卡三格 —— 同首頁筆試 dashboard 的視覺語彙(StatBlock 那三格),
			    但這裡的數字完全是抹片自己的。 */}
			<section className="grid grid-cols-3 gap-3 sm:gap-4">
				{/* 標籤刻意跟原本筆試 dashboard 的 StatBlock 一樣短(2–3 字)—— 320px
				    下三欄格線一格只有 ~90px,「整體正確率」「待加強診斷」這種
				    5 字標籤會被迫斷成兩行斷在奇怪的地方(「整體正確/率」)。 */}
				<DashStat label="場次" value={finished.length} />
				<DashStat
					label="正確率"
					value={accuracyPct !== null ? `${accuracyPct}%` : "—"}
					sub={totalMax > 0 ? `${totalScore}/${totalMax}` : undefined}
					accent
				/>
				<DashStat label="待加強" value={wrong?.length ?? 0} />
			</section>

			{/* 兩張大卡直接開練 —— 複用 Smear.tsx 的 ModeCard + StartDialog,
			    不重寫第二份判定/送出邏輯。 */}
			<section className="space-y-3">
				<ModeCard
					icon={<Microscope size={18} aria-hidden="true" />}
					title="複習模式"
					desc="看一張抹片,寫出診斷。每題作答後立刻看判定、可接受寫法與詳解 —— 適合平常累積。"
					onClick={() => navigate("/smear/review")}
				/>
				<ModeCard
					icon={<Timer size={18} aria-hidden="true" />}
					title="全真模式"
					desc="連續作答,全程不揭曉正解;交卷後才看整體成績與逐題檢討 —— 適合考前自我測驗。"
					onClick={() => navigate("/smear/exam")}
				/>
			</section>

			{/* 錯題預覽 —— 只列前幾個,完整清單在 /smear?tab=wrong。 */}
			<section>
				<div className="flex items-center justify-between mb-3">
					<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100">
						待加強
					</h2>
					<Link
						to="/smear?tab=wrong"
						className="text-xs text-accent hover:text-accent-dark"
					>
						查看全部 →
					</Link>
				</div>
				{wrong === null ? (
					<p className="text-sm text-ink-400 dark:text-ink-500">載入中…</p>
				) : topWrong.length === 0 ? (
					<p className="text-sm text-ink-400 dark:text-ink-500">
						目前沒有需要加強的診斷,繼續保持!
					</p>
				) : (
					<ul className="space-y-2">
						{topWrong.map((it) => (
							<li key={it.dx_id}>
								<Link
									to={`/smear/dx/${it.dx_id}`}
									className="flex items-center justify-between gap-3 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-2.5 hover:border-accent transition"
								>
									<div className="min-w-0">
										<p className="text-sm text-ink-900 dark:text-ink-100 break-words">
											{it.canonical_long}
										</p>
										<span className="text-[11px] text-ink-500 dark:text-ink-400">
											{SMEAR_TOPIC_LABELS[it.topic] ?? it.topic}
										</span>
									</div>
									<span className="shrink-0 font-mono text-sm text-ink-500 dark:text-ink-400">
										{it.wrong_count} 次
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>

			{/* 完整抹片頁面(搜尋/收藏/投稿等)的入口。 */}
			<Link
				to="/smear"
				className="block text-center px-4 py-2.5 text-sm rounded-lg border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-accent hover:text-accent transition"
			>
				前往完整抹片頁面(搜尋 / 已收藏 / 投稿)
			</Link>

			{/* 捷徑列 —— 手機上整條頂部導覽是隱藏的(<md),這是講義/錯題/作答
			    紀錄/答案挑戰/影片唯一能到的路,搬自原本筆試 dashboard 的
			    quick-links 區塊。年度選擇沒有獨立入口頁(只有巢狀的
			    /year/:year),不放進來 —— 複習/全真模式本身就能選年度。 */}
			<section className="flex gap-4 flex-wrap text-sm pt-2 border-t border-ink-100 dark:border-ink-700">
				<Link
					to="/lectures"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<BookOpen size={14} /> 複習班講義
				</Link>
				<Link
					to="/wrong"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<AlertTriangle size={14} /> 筆試錯題回顧
				</Link>
				<Link
					to="/exam-history"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<History size={14} /> 筆試作答紀錄
				</Link>
				<Link
					to="/challenges"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<Scale size={14} /> 答案挑戰
				</Link>
				<Link
					to="/videos"
					className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark"
				>
					<Video size={14} /> 影片庫
				</Link>
			</section>
		</div>
	);
}

function DashStat({
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
		<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 shadow-paper text-center">
			<div className="text-xs text-ink-500 dark:text-ink-400 mb-1">{label}</div>
			<div
				className={
					"font-serif text-2xl sm:text-3xl " +
					(accent ? "text-accent" : "text-ink-900 dark:text-ink-100")
				}
			>
				{value}
			</div>
			{sub && (
				<div className="text-xs text-ink-400 dark:text-ink-500 mt-0.5">{sub}</div>
			)}
		</div>
	);
}
