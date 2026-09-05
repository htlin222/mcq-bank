import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { ApiError } from "../lib/api";
import {
	fetchSmearSession,
	submitSmearAnswer,
	finishSmearSession,
	SMEAR_TOPIC_LABELS,
	type SmearSessionDetail,
	type SmearSessionQuestion,
	type SmearGradeResponse,
} from "../lib/smearApi";
import { SmearImage } from "../components/smear/SmearImage";
import { AnswerInput } from "../components/smear/AnswerInput";
import { GradeReveal, type SmearGradeDisplay } from "../components/smear/GradeReveal";
import { SmearDxPanel } from "../components/smear/SmearDxPanel";

// /smear/s/:id —— 作答頁。手機是這個功能最主要的使用情境(CLAUDE.md
// 「MOBILE IS THE PRIORITY」),版面刻意單欄堆疊到所有寬度(圖 → 提示 →
// 輸入框 → 判定 → 下一題),不做桌機兩欄 —— 這一頁每題內容遠比 /q/:id 少
// (沒有詳解/筆記/討論串要並排),硬做兩欄只是留白。
//
// ── 為什麼是單一輸入框,不是每字一格 ──────────────────────────────────
//
// 原設計要依正解字數畫出對應格數(例如「Microangiopathic hemolytic
// anemia」畫三格)。這是外洩:前端要先知道正解字數才能畫格子,而在 103 個
// 診斷的題庫裡,光字數就足以縮小候選範圍 —— 跟 Task C1 對抗性審查抓到的
// 三個外洩(id 內嵌答案、dx_id 揭曉閘漏洞、finish 前的 /wrong 外洩)是同一
// 類問題。`gradeSmear()`(worker/lib/smear-grade.ts)本來就把 boxes join
// 成一個字串再判定 —— 見它自己的測試「格子數不硬閘」,所以單一輸入框與
// 多格逐字輸入的判定結果完全相同,不是妥協,是更好的設計:同時避開外洩,
// 也避開「手機鍵盤沒有 Tab 鍵」這個問題。送給 API 的 `boxes` 因此固定是
// `[singleValue]` 這種一個元素的陣列。

type ResultState =
	| { kind: "grade"; display: SmearGradeDisplay }
	| { kind: "exam-ack" };

function fmtRemaining(ms: number): string {
	const sec = Math.floor(ms / 1000);
	const mm = Math.floor(sec / 60);
	const ss = sec % 60;
	return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function SmearSession() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();

	const [session, setSession] = useState<SmearSessionDetail | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [currentIdx, setCurrentIdx] = useState(0);
	const [results, setResults] = useState<Record<string, ResultState>>({});
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [finishing, setFinishing] = useState(false);
	const [autoFinishNotice, setAutoFinishNotice] = useState<string | null>(null);
	const finishingRef = useRef(false);

	// 載入 session。**Reload 恢復進度**:已作答的題目從 `answered`/`my_tier`/
	// `my_score`(複習模式全程揭曉;全真模式要 finish 之後才揭曉,見
	// worker/routes/smear.ts 的 `revealGrade`)重建成摘要版判定 —— 沒有
	// canonical/acceptedTerms/spellingErrors,因為這支端點本來就不回這些
	// (要嘛再打一次 dx 詳情,要嘛接受摘要;這裡選後者,GradeReveal 的欄位
	// 全部是 optional 正是為了同時撐得住「剛作答」與「重整恢復」兩種輸入)。
	// 停在**第一個未作答的題目**,全部作答完就停在最後一題(方便直接查看成績)。
	//
	// **已 finish 的 session 直接導去成績頁**(下一個任務的範圍)——
	// 這一頁的介面(輸入框、送出、下一題)全部假設「還在作答中」。
	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		finishingRef.current = false;
		setSession(null);
		setLoadError(null);
		setSubmitError(null);
		setAutoFinishNotice(null);

		fetchSmearSession(id)
			.then((s) => {
				if (cancelled) return;
				if (s.finished_at) {
					navigate(`/smear/s/${s.id}/result`, { replace: true });
					return;
				}
				setSession(s);
				const initial: Record<string, ResultState> = {};
				for (const q of s.questions) {
					if (!q.answered) continue;
					if (s.mode === "review" && q.my_tier) {
						initial[q.id] = {
							kind: "grade",
							display: { tier: q.my_tier, score: q.my_score ?? 0 },
						};
					} else {
						initial[q.id] = { kind: "exam-ack" };
					}
				}
				setResults(initial);
				const firstUnanswered = s.questions.findIndex((q) => !q.answered);
				setCurrentIdx(
					firstUnanswered === -1 ? Math.max(0, s.questions.length - 1) : firstUnanswered,
				);
			})
			.catch((e) => {
				if (cancelled) return;
				setLoadError(e instanceof ApiError ? `讀取失敗 (${e.status})` : String(e));
			});

		return () => {
			cancelled = true;
		};
	}, [id, navigate]);

	// 換題捲回頂端 —— 每一題的圖/輸入框高度不同,不捲的話容易停在上一題
	// 讀到一半的位置。
	useEffect(() => {
		window.scrollTo({ top: 0 });
	}, [currentIdx]);

	const limitSec = session?.config?.limitSec;
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!limitSec || !session || session.finished_at) return;
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [limitSec, session]);

	const remainingMs =
		limitSec != null && session ? limitSec * 1000 - (now - session.started_at) : null;

	async function handleFinish() {
		if (!session || finishingRef.current) return;
		finishingRef.current = true;
		setFinishing(true);
		try {
			await finishSmearSession(session.id);
			navigate(`/smear/s/${session.id}/result`);
		} catch (e) {
			setSubmitError(e instanceof ApiError ? `交卷失敗 (${e.status})` : String(e));
			finishingRef.current = false;
			setFinishing(false);
		}
	}

	// 時間到 —— 只有設了 limitSec(全真模式才會有,StartDialog 目前還沒有這個
	// 欄位,留給之後的任務接上 UI)才會走到這裡。首版只做「時間到自動交卷 +
	// 一句提示」,不做 CLAUDE.md「交卷確認」那節的兩段式對話框 —— 那是給
	// MCQ 全真模式手動交卷用的,這裡是自動觸發,沒有「要不要」可以問。
	useEffect(() => {
		if (remainingMs === null || remainingMs > 0 || finishingRef.current) return;
		setAutoFinishNotice("時間到,自動交卷…");
		void handleFinish();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [remainingMs]);

	async function handleSubmit(
		q: SmearSessionQuestion,
		value: string,
		hintUsed?: string,
	) {
		if (!session) return;
		setSubmitting(true);
		setSubmitError(null);
		try {
			// 單一輸入框 → 一個元素的陣列,見檔頭設計說明。
			const res = await submitSmearAnswer(session.id, q.id, [value], hintUsed);
			setResults((prev) => ({
				...prev,
				[q.id]:
					session.mode === "review"
						? { kind: "grade", display: res as SmearGradeResponse }
						: { kind: "exam-ack" },
			}));
		} catch (e) {
			setSubmitError(e instanceof ApiError ? `送出失敗 (${e.status})` : String(e));
		} finally {
			setSubmitting(false);
		}
	}

	function handleEarlyFinish() {
		if (!session) return;
		const answeredCount = session.questions.filter((q) => !!results[q.id]).length;
		if (answeredCount < session.questions.length) {
			const ok = window.confirm(
				`還有 ${session.questions.length - answeredCount} 題未作答,確定要提前交卷查看成績嗎?`,
			);
			if (!ok) return;
		}
		void handleFinish();
	}

	if (loadError) {
		return (
			<div className="max-w-md mx-auto px-4 py-20 text-center">
				<p className="text-accent">{loadError}</p>
				<Link
					to="/smear"
					className="text-accent hover:text-accent-dark text-sm mt-4 inline-block"
				>
					← 回抹片練習
				</Link>
			</div>
		);
	}

	const total = session?.questions.length ?? 0;
	const current = session?.questions[currentIdx];

	if (!session || !current) {
		return (
			<div className="max-w-md mx-auto px-4 py-20 text-center text-ink-400 dark:text-ink-500">
				<Loader2 className="animate-spin mx-auto mb-3" size={22} />
				載入中…
			</div>
		);
	}

	const currentResult = results[current.id];
	const isLast = currentIdx === total - 1;

	function goPrev() {
		setCurrentIdx((i) => Math.max(0, i - 1));
	}
	function goNext() {
		if (isLast) {
			void handleFinish();
		} else {
			setCurrentIdx((i) => Math.min(total - 1, i + 1));
		}
	}

	return (
		<div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 pb-20">
			<div className="flex items-center justify-between mb-4">
				<Link
					to="/smear"
					className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1"
				>
					<ArrowLeft size={14} /> 退出
				</Link>
				<div className="flex items-center gap-2 text-sm">
					<span
						className={
							"px-2 py-0.5 rounded-full text-xs border " +
							(session.mode === "review"
								? "border-accent text-accent"
								: "border-ink-400 dark:border-ink-500 text-ink-600 dark:text-ink-300")
						}
					>
						{session.mode === "review" ? "複習模式" : "全真模式"}
					</span>
					<span className="text-ink-600 dark:text-ink-300 font-mono" data-testid="smear-progress">
						{currentIdx + 1} / {total}
					</span>
				</div>
			</div>

			{limitSec != null && remainingMs != null && (
				// 停靠點是 `--chrome-top`,不是 0 —— 同 Exam.tsx 計時列的理由
				// (CLAUDE.md「考試計時列」):header 是 fixed 且不透明,sticky
				// top-0 會讓這條列停在 header 底下而不是下緣。
				<div className="chrome-follow sticky top-[var(--chrome-top)] z-10 -mx-4 sm:-mx-6 mb-4 bg-white dark:bg-ink-800 border-b border-ink-200 dark:border-ink-700 px-4 sm:px-6 py-2 flex items-center justify-between text-sm">
					<span
						className={
							"font-mono " +
							(remainingMs < 60_000
								? "text-rose-700 dark:text-rose-400"
								: "text-ink-900 dark:text-ink-100")
						}
					>
						剩餘 {fmtRemaining(Math.max(0, remainingMs))}
					</span>
					<button
						type="button"
						onClick={handleEarlyFinish}
						className="text-xs text-ink-500 dark:text-ink-400 hover:text-accent"
					>
						提前交卷
					</button>
				</div>
			)}

			{autoFinishNotice && (
				<p className="text-sm text-amber-700 dark:text-amber-400 mb-3">{autoFinishNotice}</p>
			)}

			<SmearImage
				viewKey={current.image_key_view}
				fullKey={current.image_key_full}
				alt={current.prompt ?? "抹片影像"}
			/>

			{current.image_note && (
				// break-words —— image_note 是自由文字,不保證有空白可斷行(同 CLAUDE.md
				// 「min-w-0 + break-words 兩個一起才擋得住 DEK::NUP214」那條的教訓)。
				<p className="text-xs text-ink-500 dark:text-ink-400 mt-2 break-words">
					{current.image_note}
				</p>
			)}

			<p className="text-base text-ink-900 dark:text-ink-100 font-medium mt-4 mb-3">
				{current.prompt ?? (current.qtype === "cell" ? "這是什麼細胞?" : "這是什麼診斷?")}
			</p>

			{!currentResult ? (
				<AnswerInput
					key={current.id}
					submitting={submitting}
					topicHint={SMEAR_TOPIC_LABELS[current.topic] ?? current.topic}
					mode={session.mode}
					onSubmit={(value, hintUsed) => void handleSubmit(current, value, hintUsed)}
				/>
			) : currentResult.kind === "grade" ? (
				<>
					<GradeReveal grade={currentResult.display} />
					{/* 只有複習模式的「已揭曉」判定會走到這裡（`currentResult.kind ===
					    'grade'` 只在 session.mode === 'review' 時才會被設成這個值，見上面
					    handleSubmit / reload 的初始化邏輯）—— 全真模式全程只會拿到
					    'exam-ack'，這個分支永遠碰不到，`current.dx_id` 在那個模式下也
					    確實沒有被伺服器揭曉過（worker/routes/smear.ts 的 revealGrade
					    閘）。這裡仍然多寫一次 `session.mode === "review"` 明確判斷，
					    不只依賴 kind 是不是剛好對——兩道閘疊起來，以後改動
					    handleSubmit 的邏輯也不會意外把成績模式的正解洩漏到這裡。 */}
					{session.mode === "review" && current.dx_id && (
						<div className="mt-6 pt-6 border-t border-ink-100 dark:border-ink-700">
							<SmearDxPanel dxId={current.dx_id} />
						</div>
					)}
				</>
			) : (
				<ExamAnswerAck />
			)}

			{submitError && <p className="text-accent text-sm mt-3">{submitError}</p>}

			<div className="flex items-center justify-between mt-6 pt-4 border-t border-ink-100 dark:border-ink-700">
				<button
					type="button"
					onClick={goPrev}
					disabled={currentIdx === 0}
					className="px-4 py-2 text-sm rounded-lg border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 disabled:opacity-30 disabled:cursor-not-allowed hover:border-ink-400"
				>
					上一題
				</button>
				{limitSec == null && (
					<button
						type="button"
						onClick={handleEarlyFinish}
						className="text-xs text-ink-400 dark:text-ink-500 hover:text-accent"
					>
						提前結束
					</button>
				)}
				<button
					type="button"
					onClick={goNext}
					disabled={!currentResult || finishing}
					className="px-5 py-2 text-sm rounded-lg bg-accent text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent-dark inline-flex items-center gap-1.5"
				>
					{finishing && <Loader2 size={14} className="animate-spin" />}
					{isLast ? "查看成績" : "下一題"}
				</button>
			</div>
		</div>
	);
}

/**
 * 全真模式作答後的中性確認 —— **刻意不用任何打勾/打叉一類的圖示**,連
 * 一個 ✓ 都不行:那本身就是判定資訊,會直接繞過「全真模式全程不揭曉」
 * 這條規則。純文字 + 中性邊框(ink,不是 accent/emerald/rose)。
 */
function ExamAnswerAck() {
	return (
		<div className="border border-ink-200 dark:border-ink-700 rounded-lg p-4 text-sm text-ink-600 dark:text-ink-300">
			已作答 —— 全真模式全程不揭曉判定,交卷後才會看到成績與逐題檢討。
		</div>
	);
}
