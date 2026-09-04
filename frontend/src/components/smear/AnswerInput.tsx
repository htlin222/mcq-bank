import { useId, useState } from "react";
import { CircleHelp, Loader2 } from "lucide-react";
import type { SmearMode } from "../../lib/smearApi";

/**
 * 單一自由輸入框,取代「每個字一格」的設計 —— 見 SmearSession.tsx 檔頭那段
 * 安全性理由(格數會洩漏答案的字數,在 103 個診斷的題庫裡就足以縮小範圍)。
 * `gradeSmear()` 本來就把 boxes join 成一個字串再判定,單一輸入框產生的
 * 判定結果跟多格逐字輸入完全相同。
 *
 * 手機文字輸入的細節:`autoComplete/autoCapitalize/autoCorrect/spellCheck`
 * 全部關掉 —— 醫學名詞(例如 Döhle、Auer rod)不關的話會被手機鍵盤自動
 * 校正/大寫成別的字,而使用者往往不會注意到。Enter/Go 鍵與明確的按鈕
 * 兩條路都能送出 —— 有些鍵盤在這種輸入框不會給方便的送出鍵。
 *
 * ── 「直接看答案」只在複習模式存在 ──────────────────────────────────
 *
 * 全真模式的判定要到 /finish 才揭曉(見 SmearSession.tsx 檔頭與
 * worker/routes/smear.ts 的 revealGrade 註解那整套對抗性審查)——
 * 讓使用者在全真模式提前看答案等於繞過那整條防線。所以這顆鈕用
 * `mode === "review"` 直接條件式 render(不掛載,不是 CSS 藏起來),
 * `mode` 由呼叫端(SmearSession.tsx)沿用它已經有的 `session.mode` 傳下來,
 * 跟 `topicHint`/`submitting` 同一種「頁面算好、往下傳純資料」的作法,
 * 不另外接 context 或第二套機制。
 *
 * 送出的是空字串,不是使用者當下打到一半的內容 —— 那正是
 * `gradeSmear()` 對「未作答」的既有判定路徑(`tier: 'miss'`,但
 * `canonical` 仍然照給,見該函式的測試),所以後端完全不用改。
 * `hintUsed: 'reveal_answer'` 讓它在 `smear_answers.hint_used` 裡跟
 * 「用了分類提示」(`'topic'`)、「單純猜錯」(`null`)分得開,純粹是
 * 分析用的旗標,不影響判分。
 */
export function AnswerInput({
	onSubmit,
	submitting,
	topicHint,
	mode,
}: {
	onSubmit: (value: string, hintUsed?: string) => void;
	submitting: boolean;
	/** 分類提示的顯示文字。undefined = 這一題沒有提示可用。 */
	topicHint?: string;
	/** 複習/全真 —— 「直接看答案」只在複習模式 render。 */
	mode: SmearMode;
}) {
	const [value, setValue] = useState("");
	const [hintShown, setHintShown] = useState(false);
	const inputId = useId();

	function submit() {
		const v = value.trim();
		if (!v || submitting) return;
		onSubmit(v, hintShown ? "topic" : undefined);
	}

	// 無視輸入框目前打了什麼(哪怕才打兩個字),一律送空字串 —— 「放棄」
	// 跟「打了一半的猜測」混在一起送出去,判定會很難懂。
	function revealAnswer() {
		if (submitting) return;
		onSubmit("", "reveal_answer");
	}

	return (
		<div className="space-y-3">
			<label htmlFor={inputId} className="sr-only">
				你的答案
			</label>
			<input
				id={inputId}
				type="text"
				inputMode="text"
				autoComplete="off"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				enterKeyHint="done"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						submit();
					}
				}}
				placeholder="輸入診斷或細胞名稱…"
				disabled={submitting}
				className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded-lg px-4 py-3 text-base text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent disabled:opacity-60"
			/>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={submit}
					disabled={submitting || !value.trim()}
					className="flex-1 sm:flex-none px-5 py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
				>
					{submitting && <Loader2 size={14} className="animate-spin" />}
					提交答案
				</button>
				{topicHint && !hintShown && (
					<button
						type="button"
						onClick={() => setHintShown(true)}
						disabled={submitting}
						className="px-3 py-2.5 rounded-lg border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 text-sm hover:border-ink-400 inline-flex items-center gap-1 disabled:opacity-40"
					>
						<CircleHelp size={14} />
						提示
					</button>
				)}
			</div>
			{hintShown && topicHint && (
				<p className="text-xs text-ink-500 dark:text-ink-400">
					分類提示:{topicHint}
				</p>
			)}
			{mode === "review" && (
				// 文字連結,不是同重量的按鈕 —— 這是刻意的退場路徑,不是預設路徑
				// (逼自己先試著答一次才是這個功能的教學重點)。仍然保留跟其他
				// 按鈕一樣的內距(py-2.5)當觸控熱區,不做成沒有邊界的行內文字。
				<button
					type="button"
					onClick={revealAnswer}
					disabled={submitting}
					className="block w-full sm:w-auto px-3 py-2.5 rounded-lg text-left text-sm text-ink-500 dark:text-ink-400 underline decoration-dotted underline-offset-4 hover:text-accent hover:no-underline disabled:opacity-40 disabled:cursor-not-allowed"
				>
					不會嗎？直接看答案
				</button>
			)}
		</div>
	);
}
