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
	onRequestMcOptions,
}: {
	onSubmit: (value: string, hintUsed?: string) => void;
	submitting: boolean;
	/** 分類提示的顯示文字。undefined = 這一題沒有提示可用。 */
	topicHint?: string;
	/** 複習/全真 —— 「直接看答案」只在複習模式 render。 */
	mode: SmearMode;
	/**
	 * 「看選項」提示 —— 打 POST /mc-options 拿 5 個洗牌過的選項文字。只在
	 * 複習模式由呼叫端(SmearSession.tsx)傳入;undefined 時整顆按鈕不 render
	 * (同「直接看答案」用 `mode === 'review'` 條件式 render 的理由:全真
	 * 模式要整個不在 DOM 裡,不是被 CSS 藏起來)。
	 *
	 * 這個元件不自己 import lib/smearApi —— API 呼叫留在 SmearSession.tsx,
	 * AnswerInput 維持純展示元件,跟其他 prop(onSubmit/topicHint)同一種
	 * 「頁面算好、往下傳純資料/callback」的作法。
	 */
	onRequestMcOptions?: () => Promise<string[]>;
}) {
	const [value, setValue] = useState("");
	const [hintShown, setHintShown] = useState(false);
	const inputId = useId();

	// 「看選項」——選了選項之後整個輸入框換成單選清單,不是並存(見下面
	// render 那段的條件判斷)。三態:還沒觸發 / 載入中 / 已經拿到選項。
	// mcError 獨立於 submitError(送出答案失敗)之外,因為這是拿選項失敗,
	// 使用者這時候還沒送出任何答案。
	type McState =
		| { status: "hidden" }
		| { status: "loading" }
		| { status: "loaded"; options: string[] }
		| { status: "error" };
	const [mc, setMc] = useState<McState>({ status: "hidden" });
	const [mcChoice, setMcChoice] = useState<string | null>(null);

	async function requestMcOptions() {
		if (!onRequestMcOptions || submitting || mc.status === "loading") return;
		setMc({ status: "loading" });
		try {
			const options = await onRequestMcOptions();
			setMc({ status: "loaded", options });
			setMcChoice(null);
		} catch {
			setMc({ status: "error" });
		}
	}

	function backToTyping() {
		setMc({ status: "hidden" });
		setMcChoice(null);
	}

	function submit() {
		if (submitting) return;
		if (mc.status === "loaded") {
			if (!mcChoice) return;
			onSubmit(mcChoice, "mc_choice");
			return;
		}
		const v = value.trim();
		if (!v) return;
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
			{mc.status === "loaded" ? (
				<>
					{/* 單選清單 —— name 相同的原生 radio group 本來就支援方向鍵在
					    選項間移動 + Enter/Space 選取,不需要另外接手把/鍵盤邏輯就有
					    基本的鍵盤互動。視覺語彙(圓角框線/選中變 accent 邊框)跟
					    QuestionCard 的選項列同一套語言,但這裡是獨立的小元件 ——
					    QuestionCard 綁死 MCQ 題目的資料形狀(收藏/信心/管理員編輯),
					    直接重用會把兩個完全不同的資料模型綁在一起。 */}
					<fieldset className="space-y-2">
						<legend className="sr-only">選一個診斷</legend>
						{mc.options.map((opt, i) => (
							<label
								key={`${i}-${opt}`}
								className={
									"flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition " +
									(mcChoice === opt
										? "border-accent bg-accent/5 dark:bg-accent/15 eink:border-2"
										: "border-ink-200 dark:border-ink-700 hover:border-ink-400 dark:hover:border-ink-500")
								}
							>
								<input
									type="radio"
									name="smear-mc-choice"
									className="mt-1 accent-[#a8442a]"
									checked={mcChoice === opt}
									onChange={() => setMcChoice(opt)}
									disabled={submitting}
								/>
								<span className="text-ink-900 dark:text-ink-100 break-words min-w-0">
									{opt}
								</span>
							</label>
						))}
					</fieldset>
					<button
						type="button"
						onClick={backToTyping}
						disabled={submitting}
						className="text-xs text-ink-500 dark:text-ink-400 underline decoration-dotted underline-offset-4 hover:text-accent disabled:opacity-40"
					>
						改用輸入
					</button>
				</>
			) : (
				<>
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
				</>
			)}
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={submit}
					disabled={
						submitting ||
						(mc.status === "loaded" ? !mcChoice : !value.trim())
					}
					className="flex-1 sm:flex-none px-5 py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
				>
					{submitting && <Loader2 size={14} className="animate-spin" />}
					提交答案
				</button>
				{topicHint && !hintShown && mc.status === "hidden" && (
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
				{mode === "review" &&
					onRequestMcOptions &&
					(mc.status === "hidden" || mc.status === "error" || mc.status === "loading") && (
						<button
							type="button"
							onClick={requestMcOptions}
							disabled={submitting || mc.status === "loading"}
							className="px-3 py-2.5 rounded-lg border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 text-sm hover:border-ink-400 inline-flex items-center gap-1 disabled:opacity-40"
						>
							{mc.status === "loading" && (
								<Loader2 size={14} className="animate-spin" />
							)}
							{mc.status === "error" ? "看選項(重試)" : "看選項"}
						</button>
					)}
			</div>
			{mc.status === "error" && (
				<p className="text-xs text-accent">載入選項失敗,請重試。</p>
			)}
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
