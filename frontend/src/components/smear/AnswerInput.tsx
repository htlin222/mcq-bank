import { useId, useState } from "react";
import { CircleHelp, Loader2 } from "lucide-react";

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
 */
export function AnswerInput({
	onSubmit,
	submitting,
	topicHint,
}: {
	onSubmit: (value: string, hintUsed?: string) => void;
	submitting: boolean;
	/** 分類提示的顯示文字。undefined = 這一題沒有提示可用。 */
	topicHint?: string;
}) {
	const [value, setValue] = useState("");
	const [hintShown, setHintShown] = useState(false);
	const inputId = useId();

	function submit() {
		const v = value.trim();
		if (!v || submitting) return;
		onSubmit(v, hintShown ? "topic" : undefined);
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
		</div>
	);
}
