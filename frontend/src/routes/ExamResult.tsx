import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Flag } from "lucide-react";
import { api } from "../lib/api";
import { AnswerOptions } from "../components/AnswerOptions";
import { BookmarkBadge } from "../components/BookmarkBadge";
import { QuestionRowActions } from "../components/QuestionRowActions";
import { describeFilters } from "../lib/customTestLabel";
import { readExamResultView, writeExamResultView } from "../lib/examResultView";
import { markProgrammaticScroll } from "../lib/autoHideChrome";
import { ExportButton } from "../components/ExportDialog";
import { ExplanationPeek } from "../components/ExplanationPeek";

type Result = {
	session: {
		id: string;
		year: number;
		started_at: number;
		finished_at: number;
		score: number;
		duration_sec: number;
		/** migration 0026;舊列走 DEFAULT 'year'。判斷種類看 kind,不要看 year。 */
		kind?: "year" | "custom";
		filter_json?: string | null;
	};
	answers: {
		question_id: string;
		chosen: string | null;
		is_correct: 0 | 1 | null;
		number: number;
		correct_answer: string;
		stem: string;
		/** null for sessions predating the attempts log (migration 0023). */
		elapsed_ms: number | null;
		/** 選項全文,字母 → 內容。展開卡片時就地顯示,不再另外打一支端點。 */
		options?: Record<string, string>;
		/** 複習進度目前記著的答案(review_progress.last_chosen)。
		 *  模擬考不寫那張表,所以它可能停在一個月前的複習作答 —— 「登記進複習進度」
		 *  按的就是這個差距。 */
		review_last_chosen?: string | null;
		/** 標記待回頭檢查(migration 0028)。舊列 DEFAULT 0。 */
		flagged: 0 | 1;
		flagged_at: number | null;
	}[];
};

type Pacing = {
	n: number;
	first_half_avg_ms: number | null;
	second_half_avg_ms: number | null;
	delta_pct: number | null;
	median_ms: number | null;
	slowest: { question_id: string; number: number; ms: number }[];
};

/** mm:ss — matches the 分/秒 style used elsewhere on this page. */
function fmtMs(ms: number): string {
	const sec = Math.round(ms / 1000);
	return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * 還原捲動位置的補正視窗。頁面高度會在資料到齊之後才長到最終值(配速卡、
 * 展開的選項分布),所以要多等幾幀 —— 但也不能無限等下去,否則一個永遠長不到
 * 那麼高的頁面會讓這段邏輯一直跑。
 */
const RESTORE_WINDOW_MS = 1500;

/** 使用者一動手就放棄還原 —— 被程式碼拉回去比沒有還原更難用。 */
const USER_SCROLL_EVENTS = [
	"wheel",
	"touchstart",
	"keydown",
	"pointerdown",
] as const;

export function ExamResult() {
	const { sid } = useParams<{ sid: string }>();
	const [data, setData] = useState<Result | null>(null);
	// 「我剛才看到哪裡」。點進某一題再走回來時要落在同一個畫面上,所以篩選、
	// 展開全部、捲動位置是**一組**的 —— 理由寫在 lib/examResultView.ts。
	const [saved] = useState(() => readExamResultView(sid));
	const [filter, setFilter] = useState<"all" | "wrong" | "right" | "flagged">(
		saved.filter,
	);
	// 全部展開/收合。切換之後每一題仍然可以單獨開關 —— 這顆只是把所有卡片推到
	// 同一個狀態,不是把個別的開關鎖住。
	const [expandAll, setExpandAll] = useState(saved.expandAll);
	const [pacing, setPacing] = useState<Pacing | null>(null);
	// 「查看詳解」開起來的那一題。存 id + 題號而不是整列:對話框只需要這兩個,
	// 而存整列的話「登記進複習進度」就地改寫 data 之後,手上這份就過期了。
	const [peek, setPeek] = useState<{ id: string; number: number } | null>(null);
	const [applying, setApplying] = useState(false);
	const [applyMsg, setApplyMsg] = useState<string | null>(null);

	useEffect(() => {
		if (!sid) return;
		api.get<Result>(`/api/exam/${sid}`).then(setData);
		api
			.get<Pacing>(`/api/exam/${sid}/pacing`)
			.then(setPacing)
			.catch(() => {
				/* pacing is best-effort — never block the result page */
			});
	}, [sid]);

	// ⚠️ **要存的是捲動途中記下來的位置,不能在卸載時才讀 `window.scrollY`。**
	// React 的清理函式跑在 DOM 變動**之後**:這一頁的節點已經拔掉了,文件高度
	// 塌成一屏,瀏覽器順手把 scrollY 夾到 0 —— 於是每次存進去的都是 0,而畫面上
	// 的症狀是「還原功能好像沒做」。實測值:離開前 550,卸載時讀到 0。
	//
	// 被動監聽器只寫一個 ref,不碰 sessionStorage(同步寫入,每幀一次是拿捲動的
	// 順暢度去換一個沒有人在看的中間狀態)。真正的寫入只發生在卸載與 pagehide。
	const yRef = useRef(0);
	useEffect(() => {
		const onScroll = () => {
			yRef.current = window.scrollY;
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);

	// `data` 進 deps 是承重的:資料還沒到的時候整頁只有「載入中…」,那時存下去
	// 等於把使用者上次的位置清掉。
	useEffect(() => {
		if (!sid || !data) return;
		const save = () =>
			writeExamResultView(sid, { filter, expandAll, y: yRef.current });
		window.addEventListener("pagehide", save);
		return () => {
			window.removeEventListener("pagehide", save);
			save();
		};
	}, [sid, data, filter, expandAll]);

	// 還原捲動位置。
	//
	// ⚠️ **「等 data 到了」是不夠的。** 這一頁的高度還取決於配速卡(另一支請求)
	// 與展開中的選項分布,它們比題目清單晚到 —— 早一步 `scrollTo` 會被夾在當時
	// 的最大值上,而症狀是「有時候還原得到、有時候差一截」(實測目標 550、
	// 當下上限只有 405)。這種時序差會隨 bundle 大小飄,所以不能靠「剛好夠快」。
	//
	// 因此在資料進來之後的一小段時間內逐幀補正,碰得到目標就收工。碰不到就停在
	// 頁尾 —— 那本來就是能給的最好答案。使用者一動手就整段放棄:被程式碼拉回去
	// 比沒有還原更難用。
	const restored = useRef(false);
	useLayoutEffect(() => {
		if (restored.current || !data || saved.y <= 0) return;
		restored.current = true;
		const deadline = Date.now() + RESTORE_WINDOW_MS;
		let raf = 0;
		let stopped = false;
		const stop = () => {
			stopped = true;
			if (raf) cancelAnimationFrame(raf);
			for (const ev of USER_SCROLL_EVENTS) window.removeEventListener(ev, stop);
		};
		const tick = () => {
			raf = 0;
			if (stopped) return;
			const maxY = Math.max(
				0,
				document.documentElement.scrollHeight - window.innerHeight,
			);
			const target = Math.min(saved.y, maxY);
			if (Math.abs(window.scrollY - target) > 1) {
				markProgrammaticScroll();
				window.scrollTo(0, target);
			}
			// 還原完就地補上 ref —— 使用者可能一動都不動就離開,那時 ref 還是 0,
			// 存回去會把剛剛還原的位置清掉。
			yRef.current = target;
			if (maxY >= saved.y || Date.now() > deadline) return stop();
			raf = requestAnimationFrame(tick);
		};
		for (const ev of USER_SCROLL_EVENTS)
			window.addEventListener(ev, stop, { passive: true, once: true });
		tick();
		return stop;
	}, [data, saved.y]);

	// 「登記進複習進度」—— 模擬考只寫 exam_answers / attempts,從不碰
	// review_progress,而 /q/:id 的「我的作答」讀的是後者。所以考完之後打開題目,
	// 看到的是上一次在複習模式答的那個。這顆按鈕把考對的那些搬過去。
	//
	// 只搬考對的:複習紀錄因此維持「目前最好的狀態」,不會因為一次考差把以前答對
	// 的拉下來。規則寫在 worker/lib/apply-exam-to-review.ts,前端只負責算出「按下去
	// 會改變幾題」——**要跟伺服器同一套判準**,否則按鈕上的數字跟結果對不起來。
	async function applyToReview(ids?: string[]) {
		if (!sid || applying) return;
		setApplying(true);
		setApplyMsg(null);
		try {
			const r = await api.post<{ applied: string[]; skipped_already: number }>(
				`/api/exam/${sid}/apply-to-review`,
				ids ? { question_ids: ids } : {},
			);
			// 就地改寫,不重抓整份成績 —— 這一頁的其他東西(配速、篩選)都沒變。
			const done = new Set(r.applied);
			setData((d) =>
				d
					? {
							...d,
							answers: d.answers.map((a) =>
								done.has(a.question_id)
									? { ...a, review_last_chosen: a.chosen }
									: a,
							),
						}
					: d,
			);
			setApplyMsg(
				r.applied.length > 0
					? `已登記 ${r.applied.length} 題`
					: "沒有需要登記的題目",
			);
		} catch (e: any) {
			setApplyMsg("登記失敗:" + (e?.data?.error ?? e?.message ?? "請稍後再試"));
		} finally {
			setApplying(false);
		}
	}

	if (!data)
		return (
			<div className="p-8 text-center text-ink-400 dark:text-ink-500">
				載入中…
			</div>
		);

	const total = data.answers.length;
	const correct = data.session.score;
	const pct = total ? Math.round((correct / total) * 100) : 0;
	const mins = Math.floor(data.session.duration_sec / 60);
	const secs = data.session.duration_sec % 60;

	const flaggedCount = data.answers.filter((a) => a.flagged === 1).length;

	// 「按下去會改變幾題」——**跟伺服器同一套判準**(考對 + 複習紀錄還不是這個答案)。
	// 把已經一樣的算進去的話,使用者會按完發現數字沒動。
	const pendingApply = data.answers.filter(
		(a) => a.is_correct === 1 && a.chosen && a.review_last_chosen !== a.chosen,
	);

	const visible = data.answers.filter((a) => {
		if (filter === "all") return true;
		if (filter === "wrong") return a.is_correct !== 1;
		if (filter === "flagged") return a.flagged === 1;
		return a.is_correct === 1;
	});

	return (
		<div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
			<header className="mb-8 flex items-center justify-between gap-4">
				<Link
					to="/exam"
					className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent"
				>
					← 全真作答
				</Link>
				<div className="flex items-center gap-2">
					<ExportButton scope={{ kind: "exam", session_id: data.session.id }} />
					<ExportButton
						scope={{
							kind: "exam",
							session_id: data.session.id,
							only_wrong: true,
						}}
						label="只匯出答錯的"
					/>
				</div>
			</header>

			{/* Score banner */}
			<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mb-8 text-center">
				<div className="text-sm text-ink-500 dark:text-ink-400 mb-2">
					{data.session.kind === "custom" ? (
						<>
							自訂測驗
							{describeFilters(data.session.filter_json) && (
								<span className="block text-xs mt-0.5">
									{describeFilters(data.session.filter_json)}
								</span>
							)}
						</>
					) : (
						<>{data.session.year} 年度模擬考</>
					)}
				</div>
				<div className="font-serif text-6xl text-ink-900 dark:text-ink-100 mb-3">
					{correct}
					<span className="text-ink-300 dark:text-ink-600 text-3xl">
						/{total}
					</span>
				</div>
				{/* 及格與否**只**寫在 emerald/rose 裡 —— 數字本身不帶判斷。1-bit 下
            顏色沒了就什麼都不剩,所以補一個只在電子紙顯示的 ✓ / ✗。 */}
				<div
					className={`text-lg font-medium ${pct >= 60 ? "text-emerald-700 dark:text-emerald-400 eink-mark-ok" : "text-rose-700 dark:text-rose-400 eink-mark-bad"}`}
				>
					{pct}%
				</div>
				<div className="text-xs text-ink-400 dark:text-ink-500 mt-3">
					用時 {mins} 分 {secs} 秒 ·{" "}
					{new Date(data.session.finished_at).toLocaleString("zh-TW")}
				</div>
			</div>

			{/* 登記進複習進度。放在分數卡與逐題清單之間 —— 它是「看完成績之後要不要
          把成果收進複習」的動作,屬於整份成績,不屬於任何一題。 */}
			{(pendingApply.length > 0 || applyMsg) && (
				<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 shadow-paper mb-8 flex flex-wrap items-center gap-3">
					<div className="min-w-0 flex-1 text-sm text-ink-600 dark:text-ink-300">
						{/* 做完之後整段換掉,而不是把數字變成 0 ——「有 0 題這次考對了,但
                複習進度還記著舊答案」在做完之後是一句沒有意義的話,而且看起來
                像沒成功。 */}
						{applyMsg && pendingApply.length === 0 ? (
							<>
								<p>已經把這次考對的登記進複習進度了。</p>
								<p className="text-xs text-ink-400 dark:text-ink-500 mt-0.5">
									題目頁的「我的作答」現在顯示這次的答案,也不會再被當成錯題丟回來。
								</p>
							</>
						) : (
							<>
								<p>
									有 <span className="font-medium">{pendingApply.length}</span>{" "}
									題這次考對了,但複習進度還記著舊答案。
								</p>
								<p className="text-xs text-ink-400 dark:text-ink-500 mt-0.5">
									登記之後,題目頁的「我的作答」會顯示這次的答案,也不會再被當成錯題丟回來。
									考錯的不會動。
								</p>
							</>
						)}
					</div>
					<button
						type="button"
						onClick={() => applyToReview()}
						disabled={applying || pendingApply.length === 0}
						className="shrink-0 rounded bg-accent hover:bg-accent-dark text-white px-3 py-1.5 text-sm disabled:opacity-40"
					>
						{/* 按完之後 pendingApply 會歸零,而「全部登記 (0)」那個 0 沒有意義,
                看起來還像沒成功。做完就直接說做完了。
                判準是「按過(applyMsg 有值)而且已經沒有待登記的」—— 只看
                pendingApply 為 0 的話,一進頁面就沒東西可登記時也會顯示
                「登記完成」,而那時使用者根本沒按過任何東西。 */}
						{applying
							? "登記中…"
							: applyMsg && pendingApply.length === 0
								? "✓ 登記完成"
								: `全部登記 (${pendingApply.length})`}
					</button>
					{applyMsg && (
						<p className="w-full text-xs text-ink-500 dark:text-ink-400">
							{applyMsg}
						</p>
					)}
				</div>
			)}

			{/* Pacing card */}
			{pacing && (
				<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 sm:p-5 shadow-paper mb-8">
					{pacing.n === 0 ? (
						<p className="text-sm text-ink-400 dark:text-ink-500">
							本場沒有逐題計時資料(舊場次)
						</p>
					) : (
						<>
							<div className="text-xs text-ink-500 dark:text-ink-400 mb-2">
								配速
							</div>
							<p className="text-sm text-ink-700 dark:text-ink-300 leading-relaxed">
								前半段平均 {fmtMs(pacing.first_half_avg_ms ?? 0)} · 後半段平均{" "}
								{fmtMs(pacing.second_half_avg_ms ?? 0)}
								{pacing.delta_pct !== null && (
									<>
										{" "}
										·{" "}
										<span
											className={
												pacing.delta_pct > 25
													? "font-medium text-rose-700 dark:text-rose-400"
													: pacing.delta_pct < -25
														? "font-medium text-emerald-700 dark:text-emerald-400"
														: "font-medium text-ink-800 dark:text-ink-200"
											}
										>
											{pacing.delta_pct >= 0
												? `後段慢了 ${pacing.delta_pct}%`
												: `後段快了 ${-pacing.delta_pct}%`}
										</span>
									</>
								)}
							</p>
							{pacing.slowest.length > 0 && (
								<div className="text-xs text-ink-500 dark:text-ink-400 mt-2 flex flex-wrap gap-x-3 gap-y-1">
									<span>最慢五題:</span>
									{pacing.slowest.map((s) => (
										<Link
											key={s.question_id}
											to={`/q/${s.question_id}`}
											state={{ fromExam: sid }}
											className="hover:text-accent"
										>
											第 {s.number} 題 {fmtMs(s.ms)}
										</Link>
									))}
								</div>
							)}
						</>
					)}
				</div>
			)}

			{/* Filter tabs */}
			{/* `flex-wrap` 是必要的:多了右邊那顆之後,窄螢幕四顆篩選 + 展開全部一定
          排不下,不換行就是整頁被撐出水平捲軸。換行之後 `ml-auto` 仍然把它推到
          自己那一行的最右邊。 */}
			<div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
				{(["wrong", "right", "flagged", "all"] as const).map((f) => (
					<button
						key={f}
						onClick={() => setFilter(f)}
						// 沒有標記題時不給點,避免點進空清單。
						disabled={f === "flagged" && flaggedCount === 0}
						className={`px-3 py-1.5 rounded border transition ${
							filter === f
								? "bg-ink-900 dark:bg-ink-700 text-white border-ink-900 dark:border-ink-700"
								: "border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-ink-400 dark:hover:border-ink-500"
						} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-ink-200 dark:disabled:hover:border-ink-700`}
					>
						{f === "all" && `全部 (${total})`}
						{f === "right" && `答對 (${correct})`}
						{f === "wrong" && `答錯/未答 (${total - correct})`}
						{f === "flagged" && `標記 (${flaggedCount})`}
					</button>
				))}
				{/* 檢討整份考卷時,一題一題點開選項是一百次點擊。這顆刻意靠右:它跟左邊
            那組不是同一件事 —— 那組換的是**看哪些題**,這顆換的是**每一題看多細**。 */}
				<button
					type="button"
					onClick={() => setExpandAll((v) => !v)}
					aria-pressed={expandAll}
					className="ml-auto px-3 py-1.5 rounded border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-ink-400 dark:hover:border-ink-500 transition"
				>
					{expandAll ? "收合全部選項" : "展開全部選項"}
				</button>
			</div>

			{/* Per-question list */}
			<ul className="space-y-2">
				{visible.map((a) => {
					const right = a.is_correct === 1;
					const unanswered = !a.chosen;
					return (
						<li key={a.question_id}>
							{/* `relative group` 是 QuestionRowActions 的前提(理由寫在那個檔)。
                  **只包整列連結,不包 AnswerOptions** —— 否則絕對定位的基準會
                  變成「連同展開的選項」那一整塊,按鈕會飄在很下面。 */}
							<div className="relative group">
								<Link
									to={`/q/${a.question_id}`}
									state={{ fromExam: sid }}
									className="flex gap-3 items-start bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent hover:shadow-paper transition"
								>
									<span
										// 三種底色在 1-bit 下會一起變白 → 全部長一樣。改成
										// 對=反白 / 錯=粗實框 / 未作答=虛線框。
										className={`shrink-0 w-9 h-9 rounded-full grid place-items-center font-mono text-sm ${
											right
												? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 eink-invert"
												: unanswered
													? "bg-ink-100 dark:bg-ink-700 text-ink-500 dark:text-ink-400 eink:border eink:border-dashed eink:border-black"
													: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 eink:border-2 eink:border-black"
										}`}
									>
										{a.number}
									</span>
									{/* 標記過的題目:與考試中同一組 amber 視覺 */}
									{a.flagged === 1 && (
										<Flag
											size={11}
											className="shrink-0 mt-1 fill-amber-500 text-amber-600"
											aria-label="已標記"
										/>
									)}
									<div className="flex-1 min-w-0">
										<p className="text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed inline-flex items-start gap-1.5">
											<BookmarkBadge
												questionId={a.question_id}
												className="mt-1"
											/>
											<span>{a.stem}</span>
										</p>
										<div className="text-xs text-ink-500 dark:text-ink-400 mt-1">
											{unanswered ? (
												<span>未作答 · 正解 {a.correct_answer}</span>
											) : right ? (
												<span className="text-emerald-700 dark:text-emerald-400">
													✓ {a.chosen}
												</span>
											) : (
												<span className="text-rose-700 dark:text-rose-400">
													✗ 你選 {a.chosen} · 正解 {a.correct_answer}
												</span>
											)}
											<span>
												{" "}
												· 用時{" "}
												{a.elapsed_ms === null ? "—" : fmtMs(a.elapsed_ms)}
											</span>
										</div>
									</div>
								</Link>
								<QuestionRowActions
									questionId={a.question_id}
									title={`第 ${a.number} 題`}
									onPeek={() =>
										setPeek({ id: a.question_id, number: a.number })
									}
								/>
							</div>
							<AnswerOptions
								questionId={a.question_id}
								options={a.options ?? {}}
								chosen={a.chosen}
								correctAnswer={a.correct_answer}
								expandAll={expandAll}
								toolbar={
									<ApplyToReview
										state={
											a.is_correct !== 1 || !a.chosen
												? "n/a"
												: a.review_last_chosen === a.chosen
													? "done"
													: "pending"
										}
										applying={applying}
										onApply={() => applyToReview([a.question_id])}
									/>
								}
							/>
						</li>
					);
				})}
			</ul>

			{peek && (
				<ExplanationPeek
					questionId={peek.id}
					label={`第 ${peek.number} 題`}
					fromExam={sid}
					onClose={() => setPeek(null)}
				/>
			)}
		</div>
	);
}

/**
 * 逐題登記。只有「考對了但複習進度還是舊答案」時才出現 —— 一顆按了不會有任何
 * 變化的按鈕,比沒有這顆更糟。已登記的留一行灰字當回饋,不留的話按完只是按鈕
 * 消失,看起來像壞掉。
 *
 * 它接在共用的「展開選項」右邊(`AnswerOptions` 的 `toolbar`)。**沒有把它塞進
 * 那個共用元件裡**:錯題回顧沒有「這一場考對了」這個概念,傳一個永遠是 'n/a'
 * 的 prop 只是把成績頁的形狀強加給另一頁。
 */
function ApplyToReview({
	state,
	applying,
	onApply,
}: {
	/** 'n/a' = 考錯或未作答(依規則不登記)· 'pending' = 可登記 · 'done' = 已一致 */
	state: "n/a" | "pending" | "done";
	applying: boolean;
	onApply(): void;
}) {
	if (state === "pending") {
		return (
			<button
				type="button"
				onClick={onApply}
				disabled={applying}
				className="ml-3 text-xs text-accent hover:underline disabled:opacity-40"
			>
				登記進複習進度
			</button>
		);
	}
	if (state === "done") {
		return (
			<span className="ml-3 text-xs text-ink-400 dark:text-ink-500">
				已登記進複習
			</span>
		);
	}
	return null;
}
