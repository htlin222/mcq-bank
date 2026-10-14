// 個人頁「抹片使用」的形狀。數字由路由查完再交進來,這裡只負責:
// 沒出現的提示種類補 0、主題沒人作答也補 0、複習拼字正確率排除
// 「沒有打字」的兩種提示。全真交卷的 spelling_ok 不進這份結果。

export const SMEAR_HINT_KINDS = [
	"",
	"topic",
	"initial",
	"initial,topic",
	"mc_choice",
	"reveal_answer",
] as const;

/** 複習拼字正確率只算自己打出來的。看選項、直接看答案都沒有打字。 */
export function reviewSpellingEligible(hint: string | null | undefined): boolean {
	return hint !== "mc_choice" && hint !== "reveal_answer";
}

/** 嵌進 SQL 的 NOT IN 清單。只從常數來,不收任何使用者輸入。 */
export function reviewSpellingExcludedSql(): string {
	return SMEAR_HINT_KINDS.filter((k) => k && !reviewSpellingEligible(k))
		.map((k) => `'${k}'`)
		.join(", ");
}

export type SmearUsage = {
	hints: { hint_used: string; n: number }[];
	lay_hits: number;
	review_spelling: { correct: number; graded: number };
	topics: { topic: string; question_count: number; answer_count: number }[];
};

function n(v: unknown): number {
	const x = Number(v);
	if (!Number.isFinite(x) || x < 0) return 0;
	return Math.trunc(x);
}

export function buildSmearUsage(
	input: {
		hintRows?: { hint_used?: string | null; n?: unknown }[] | null;
		layHits?: unknown;
		reviewSpelling?: { correct?: unknown; graded?: unknown } | null;
		topicQuestions?: { topic?: string | null; question_count?: unknown }[] | null;
		topicAnswers?: { topic?: string | null; answer_count?: unknown }[] | null;
	},
	topicOrder: readonly string[],
): SmearUsage {
	const hintN = new Map<string, number>();
	for (const row of input.hintRows ?? []) {
		const key = row.hint_used ?? "";
		hintN.set(key, (hintN.get(key) ?? 0) + n(row.n));
	}
	const hints: SmearUsage["hints"] = SMEAR_HINT_KINDS.map((hint_used) => ({
		hint_used,
		n: hintN.get(hint_used) ?? 0,
	}));
	for (const key of [...hintN.keys()].filter((k) => !SMEAR_HINT_KINDS.includes(k as (typeof SMEAR_HINT_KINDS)[number])).sort()) {
		hints.push({ hint_used: key, n: hintN.get(key) ?? 0 });
	}

	const qN = new Map<string, number>();
	const aN = new Map<string, number>();
	for (const row of input.topicQuestions ?? []) {
		if (!row.topic) continue;
		qN.set(row.topic, (qN.get(row.topic) ?? 0) + n(row.question_count));
	}
	for (const row of input.topicAnswers ?? []) {
		if (!row.topic) continue;
		aN.set(row.topic, (aN.get(row.topic) ?? 0) + n(row.answer_count));
	}
	const seen = new Set<string>();
	const topics: SmearUsage["topics"] = [];
	for (const topic of [...topicOrder, ...[...qN.keys(), ...aN.keys()].sort()]) {
		if (seen.has(topic)) continue;
		seen.add(topic);
		topics.push({
			topic,
			question_count: qN.get(topic) ?? 0,
			answer_count: aN.get(topic) ?? 0,
		});
	}

	const correct = n(input.reviewSpelling?.correct);
	const graded = n(input.reviewSpelling?.graded);
	return {
		hints,
		lay_hits: n(input.layHits),
		review_spelling: { correct: Math.min(correct, graded), graded },
		topics,
	};
}
