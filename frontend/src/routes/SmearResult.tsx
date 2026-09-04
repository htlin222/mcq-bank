import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { ApiError } from "../lib/api";
import {
	finishSmearSession,
	fetchSmearSession,
	SMEAR_TOPIC_LABELS,
	SMEAR_MODE_LABELS,
	type SmearFinishResult,
	type SmearFinishBreakdownRow,
	type SmearSessionDetail,
	type SmearSessionQuestion,
	type SmearMode,
} from "../lib/smearApi";
import { SmearImage } from "../components/smear/SmearImage";
import { StartDialog } from "../components/smear/StartDialog";
import { TIER_META } from "../components/smear/GradeReveal";

// /smear/s/:id/result —— 成績 + 逐題檢討(D4)。單欄堆疊,同 SmearSession.tsx
// 的判斷:內容循序閱讀,不需要桌機兩欄。
//
// ── finish + GET /sessions/:id 兩支合併,不是新開一支端點 ──────────────
//
// POST /finish 的 breakdown 有判定(tier/score/canonical_long)但**沒有圖片
// 欄位** —— worker/routes/smear.ts 的 breakdown 只 select 判定相關欄位。
// 圖片 (image_key_view/full)、prompt、image_note 只有 GET /sessions/:id 有,
// 而它在 session 已 finish(或本來就是複習模式)之後才會揭曉 dx_id/my_tier ——
// 見那支路由的 `revealGrade` 註解。這一頁因此依序打兩支既有端點再用
// `question_id` 併起來,而不是為了「成績頁要圖」另開一支揉合過的端點:抄
// 兩份判定/揭曉邏輯只會讓兩處遲早走散(CLAUDE.md 反覆講的「兩份實作」)。
//
// **兩支依序打,不是 Promise.all。** finish 才是「讓伺服器真正寫入
// finished_at/score」的那一步;併發送出的話,GET /sessions/:id 有可能在
// finish 的 UPDATE 提交之前就先跑到,全真模式會因此拿到還沒揭曉的殼子
// (dx_id/my_tier 全部 undefined)。複習模式不受影響(revealGrade 本來就跟
// finished_at 無關),但全真模式一旦踩到就是「成績頁圖不見、正解也不見」,
// 而且是時序競賽,不會每次重現。
//
// **這支路由同時服務「剛交卷」與「回顧歷史」兩種入口。** finish 對已交卷的
// session 是唯讀的(worker 端 `if (!session.finished_at)` 才重算),所以
// 再打一次不會改變分數 —— 兩條入口因此可以共用同一個元件,不必分成
// 「剛交卷用這個」「歷史用那個」兩份幾乎一樣的畫面。

type BreakdownWithQuestion = SmearFinishBreakdownRow & {
	question?: SmearSessionQuestion;
};

function fmtTyped(typed: unknown[]): string {
	if (!Array.isArray(typed) || typed.length === 0) return "";
	return typed.map((t) => (typeof t === "string" ? t : String(t))).join(" ");
}

export function SmearResult() {
	const { id } = useParams<{ id: string }>();

	const [finish, setFinish] = useState<SmearFinishResult | null>(null);
	const [session, setSession] = useState<SmearSessionDetail | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [dialogMode, setDialogMode] = useState<SmearMode | null>(null);

	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		setFinish(null);
		setSession(null);
		setLoadError(null);

		(async () => {
			try {
				// 順序很重要 —— 見檔頭說明,finish 必須先完成寫入,GET /sessions/:id
				// 才有機會讀到已揭曉的資料。
				const fin = await finishSmearSession(id);
				if (cancelled) return;
				const sess = await fetchSmearSession(id);
				if (cancelled) return;
				setFinish(fin);
				setSession(sess);
			} catch (e) {
				if (cancelled) return;
				setLoadError(
					e instanceof ApiError && e.status === 404
						? "找不到這場作答紀錄。"
						: e instanceof ApiError
							? `讀取失敗 (${e.status})`
							: String(e),
				);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [id]);

	const questionMap = useMemo(() => {
		const map = new Map<string, SmearSessionQuestion>();
		for (const q of session?.questions ?? []) map.set(q.id, q);
		return map;
	}, [session]);

	const rows: BreakdownWithQuestion[] = useMemo(
		() =>
			(finish?.breakdown ?? []).map((row) => ({
				...row,
				question: questionMap.get(row.question_id),
			})),
		[finish, questionMap],
	);

	// 成績頁按主題分類拆開 —— 分數回答的是「認不認得」,拼字正確率回答的是
	// 「寫不寫得出來」,兩者刻意分開顯示,不折成一個數字(見上面成績卡)。
	// 主題分類同理:「哪個主題還弱」比一個總分更能指出下一步該練哪裡。
	// 順序沿用 SMEAR_TOPIC_LABELS 的宣告順序(同 worker 端 TOPICS 常數的順序),
	// 只列出這場作答裡真的出現過的主題。
	const topicStats = useMemo(() => {
		const stats = new Map<string, { score: number; max: number }>();
		for (const row of finish?.breakdown ?? []) {
			const key = row.topic ?? "other";
			const cur = stats.get(key) ?? { score: 0, max: 0 };
			cur.score += row.score;
			cur.max += 1;
			stats.set(key, cur);
		}
		return Object.keys(SMEAR_TOPIC_LABELS)
			.filter((t) => stats.has(t))
			.map((t) => ({ topic: t, ...stats.get(t)! }));
	}, [finish]);

	if (loadError) {
		return (
			<div className="max-w-md mx-auto px-4 py-20 text-center">
				<p className="text-accent break-words">{loadError}</p>
				<Link
					to="/smear"
					className="text-accent hover:text-accent-dark text-sm mt-4 inline-block"
				>
					← 回抹片練習
				</Link>
			</div>
		);
	}

	if (!finish || !session) {
		return (
			<div className="max-w-md mx-auto px-4 py-20 text-center text-ink-400 dark:text-ink-500">
				<Loader2 className="animate-spin mx-auto mb-3" size={22} />
				載入中…
			</div>
		);
	}

	const pct = finish.max_score > 0 ? Math.round((finish.score / finish.max_score) * 100) : 0;

	return (
		<div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 pb-20">
			<Link
				to="/smear"
				className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1 mb-4"
			>
				<ArrowLeft size={14} /> 回抹片練習
			</Link>

			{/* 成績卡 —— 分數與拼字正確率分開顯示(不折成一個數字),理由見檔頭。 */}
			<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mb-6 text-center">
				<div className="text-sm text-ink-500 dark:text-ink-400 mb-2">
					{SMEAR_MODE_LABELS[session.mode]} · {finish.question_count} 題
				</div>
				<div className="font-serif text-6xl text-ink-900 dark:text-ink-100 mb-2">
					{finish.score}
					<span className="text-ink-300 dark:text-ink-600 text-3xl">
						/{finish.max_score}
					</span>
				</div>
				<div className="text-lg font-medium text-ink-700 dark:text-ink-200">{pct}%</div>
				<div className="flex flex-wrap justify-center gap-x-5 gap-y-1 mt-4 text-sm text-ink-600 dark:text-ink-300">
					<span>拼字完全正確:{finish.spelling_ok} 題</span>
					<span>用了俗名:{finish.lay_count} 題</span>
				</div>
			</div>

			{/* 按主題拆開的成績 —— 直向清單,一個主題一條,窄螢幕不需要另外處理。 */}
			{topicStats.length > 0 && (
				<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 mb-6">
					<h2 className="text-xs uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-3">
						主題分類
					</h2>
					<div className="space-y-3">
						{topicStats.map(({ topic, score, max }) => {
							const topicPct = max > 0 ? Math.round((score / max) * 100) : 0;
							return (
								<div key={topic}>
									<div className="flex items-center justify-between text-sm text-ink-700 dark:text-ink-200 mb-1">
										<span>{SMEAR_TOPIC_LABELS[topic] ?? topic}</span>
										<span className="tabular-nums text-ink-500 dark:text-ink-400">
											{score}/{max}
										</span>
									</div>
									{/* 進度條:填色用 `bg-accent`(e-ink 中和層會撈回實心黑),
									    軌道補 `eink:border-black` —— 0% 時淡色軌道會被洗白,
									    同 PacingCard 本週進度條的作法,不另開第二套視覺語彙。 */}
									<div
										className="h-2 rounded-full bg-ink-100 dark:bg-ink-700 overflow-hidden eink:border eink:border-black"
										role="progressbar"
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={topicPct}
										aria-label={`${SMEAR_TOPIC_LABELS[topic] ?? topic} 正確率`}
									>
										<div
											className="h-full bg-accent"
											style={{ width: `${topicPct}%` }}
										/>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* 再練一次 / 回列表 */}
			<div className="flex flex-col sm:flex-row gap-3 mb-8">
				<button
					type="button"
					onClick={() => setDialogMode(session.mode)}
					className="flex-1 px-4 py-2.5 text-sm rounded-lg bg-accent text-white hover:bg-accent-dark transition"
				>
					再練一次
				</button>
				<Link
					to="/smear?tab=history"
					className="flex-1 text-center px-4 py-2.5 text-sm rounded-lg border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-accent hover:text-accent transition"
				>
					查看作答記錄
				</Link>
			</div>
			{dialogMode && (
				<StartDialog initialMode={dialogMode} onClose={() => setDialogMode(null)} />
			)}

			{/* 逐題檢討 */}
			<section>
				<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 mb-3">
					逐題檢討
				</h2>
				<div className="space-y-3">
					{rows.map((row, i) => (
						<ResultRow key={row.question_id + i} row={row} index={i} />
					))}
				</div>
			</section>
		</div>
	);
}

function ResultRow({ row, index }: { row: BreakdownWithQuestion; index: number }) {
	const meta = TIER_META[row.tier];
	const typedText = fmtTyped(row.typed);
	const q = row.question;

	return (
		<div className="border border-ink-200 dark:border-ink-700 rounded-lg p-4 flex flex-col sm:flex-row gap-4">
			{q && (
				<div className="w-full sm:w-32 shrink-0">
					<SmearImage
						viewKey={q.image_key_view}
						fullKey={q.image_key_full}
						alt={row.canonical_long ?? "抹片影像"}
					/>
				</div>
			)}
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2 mb-2">
					<span className="text-xs text-ink-400 dark:text-ink-500 font-mono">
						第 {index + 1} 題
					</span>
					<span
						className={
							"inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs " +
							meta.badgeCls
						}
					>
						<span aria-hidden="true">{meta.icon}</span>
						{meta.label}
					</span>
					<span className="text-xs text-ink-400 dark:text-ink-500">
						+{row.score} 分
					</span>
					{row.topic && (
						<span className="text-[11px] px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300">
							{SMEAR_TOPIC_LABELS[row.topic] ?? row.topic}
						</span>
					)}
				</div>

				<p className="text-sm text-ink-500 dark:text-ink-400 break-words">
					你的作答:
					<span className="text-ink-800 dark:text-ink-100">
						{typedText || "(未作答)"}
					</span>
				</p>

				{row.canonical_long && (
					<p className="text-sm text-ink-700 dark:text-ink-200 mt-1 break-words">
						正解:
						{row.dx_id ? (
							<Link
								to={`/smear/dx/${row.dx_id}`}
								className="font-medium text-accent hover:text-accent-dark break-words"
							>
								{row.canonical_long}
							</Link>
						) : (
							<span className="font-medium text-ink-900 dark:text-ink-100">
								{row.canonical_long}
							</span>
						)}
					</p>
				)}

				{row.spelling_errors.length > 0 && (
					<div className="text-xs border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded px-3 py-2 text-amber-800 dark:text-amber-300 mt-2 space-y-0.5">
						{row.spelling_errors.map((e, i) => {
							const err = e as { typed?: string; expected?: string };
							return (
								<p key={i} className="break-words">
									「{err.typed}」→ 正確拼法「{err.expected}」
								</p>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
