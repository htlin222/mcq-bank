import type { SmearAcceptedTerm, SmearSpellingError, SmearTier } from "../../lib/smearApi";

/**
 * 作答後的判定結果 —— 只能在複習模式使用(全真模式全程不揭曉,見
 * SmearSession.tsx 的 ExamAnswerAck)。
 *
 * **語意不只靠顏色。** 四層(full/half/lay/miss)各自有獨立的字元
 * (✓/◐/~/✗)承載意思,顏色只是加強 —— 同 `AnswerVerdict.tsx` 的作法與
 * CLAUDE.md 電子紙那節「顏色沒了之後,語意要換一個維度重講」。full 用
 * `bg-accent` 實心填色(e-ink 中和層會把它撈回實心黑,搭配白字),
 * half/lay/miss 用外框 —— half/miss 是實線,lay 是虛線,在 1-bit 下
 * 至少把「俗名不計分」跟另外兩種分開;half 與 miss 最終還是要靠字元
 * (◐ vs ✗)分辨,這點與 `AnswerVerdict` 完全依賴 ✓/✗ 字元的作法一致。
 *
 * 欄位全部是 optional,除了 tier/score —— 從 GET /sessions/:id reload 恢復
 * 進度時,伺服器只給得出 my_tier/my_score(見 worker/routes/smear.ts 的
 * `revealGrade` 註解),沒有 canonical/acceptedTerms/spellingErrors。這個
 * 元件因此要能在「只有 tier+score」與「完整判定」兩種輸入下都正常顯示,
 * 而不是分成兩個元件各寫一份。
 */
export interface SmearGradeDisplay {
	tier: SmearTier | "miss";
	score: number;
	canonical?: string | null;
	spellingErrors?: SmearSpellingError[];
	acceptedTerms?: SmearAcceptedTerm[];
}

const TIER_META: Record<
	SmearTier | "miss",
	{ icon: string; label: string; badgeCls: string; chipCls: string }
> = {
	full: {
		icon: "✓",
		label: "完全正確",
		badgeCls: "bg-accent text-white border border-accent",
		chipCls: "bg-accent text-white border border-accent",
	},
	half: {
		icon: "◐",
		label: "部分正確(半分)",
		badgeCls:
			"bg-white dark:bg-ink-800 border-2 border-accent text-accent dark:border-accent-light dark:text-accent-light",
		chipCls:
			"bg-white dark:bg-ink-800 border border-accent text-accent dark:border-accent-light dark:text-accent-light",
	},
	lay: {
		icon: "~",
		label: "俗名用法(不計分)",
		badgeCls:
			"bg-white dark:bg-ink-800 border-2 border-dashed border-ink-400 dark:border-ink-500 text-ink-600 dark:text-ink-300",
		chipCls:
			"bg-white dark:bg-ink-800 border border-dashed border-ink-400 dark:border-ink-500 text-ink-600 dark:text-ink-300",
	},
	miss: {
		icon: "✗",
		label: "未命中",
		badgeCls:
			"bg-white dark:bg-ink-800 border-2 border-rose-600 dark:border-rose-400 text-rose-700 dark:text-rose-400",
		chipCls:
			"bg-white dark:bg-ink-800 border border-rose-600 dark:border-rose-400 text-rose-700 dark:text-rose-400",
	},
};

const TERM_TIER_ORDER: SmearTier[] = ["full", "half", "lay"];

export function GradeReveal({ grade }: { grade: SmearGradeDisplay }) {
	const meta = TIER_META[grade.tier];
	const grouped: Record<SmearTier, SmearAcceptedTerm[]> = { full: [], half: [], lay: [] };
	for (const t of grade.acceptedTerms ?? []) grouped[t.tier]?.push(t);
	const hasTerms = (grade.acceptedTerms?.length ?? 0) > 0;

	return (
		<div
			className="border border-ink-200 dark:border-ink-700 rounded-lg p-4 space-y-3"
			data-testid="grade-reveal"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span
					className={
						"inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium " +
						meta.badgeCls
					}
				>
					<span aria-hidden="true">{meta.icon}</span>
					{meta.label}
				</span>
				<span className="text-sm text-ink-500 dark:text-ink-400">
					+{grade.score} 分
				</span>
			</div>

			{grade.spellingErrors && grade.spellingErrors.length > 0 && (
				<div className="text-xs border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded px-3 py-2 text-amber-800 dark:text-amber-300 space-y-0.5">
					<p className="font-medium">拼字提醒</p>
					{grade.spellingErrors.map((e, i) => (
						<p key={i}>
							「{e.typed}」→ 正確拼法「{e.expected}」
						</p>
					))}
				</div>
			)}

			{grade.canonical && (
				// break-words —— canonical / acceptedTerms 都是題庫的自由文字欄位,不保證
				// 有空白或連字號可斷行(同 CLAUDE.md「min-w-0 + break-words 兩個一起才擋
				// 得住 DEK::NUP214」那條:融合基因這類命名法完全可能沒有天然斷行點)。
				<p className="text-sm text-ink-700 dark:text-ink-200 break-words">
					正解:
					<span className="font-medium text-ink-900 dark:text-ink-100">
						{grade.canonical}
					</span>
				</p>
			)}

			{hasTerms && (
				<div className="text-xs text-ink-500 dark:text-ink-400">
					<p className="mb-1.5">可接受的寫法:</p>
					<div className="flex flex-wrap gap-1.5">
						{TERM_TIER_ORDER.flatMap((tier) =>
							grouped[tier].map((t) => (
								<span
									key={tier + t.text}
									className={
										"px-2 py-0.5 rounded text-[11px] max-w-full break-words " +
										TIER_META[tier].chipCls
									}
								>
									<span aria-hidden="true">{TIER_META[tier].icon}</span> {t.text}
								</span>
							)),
						)}
					</div>
				</div>
			)}
		</div>
	);
}
