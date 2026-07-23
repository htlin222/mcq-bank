import { Hono } from "hono";
import type { AppContext } from "../types";
import { TEXT_MODEL } from "../lib/ai-models";

// ── 教科書引用 lookup ────────────────────────────────────────────────
//
// 「選字問 Wintrobe」:App 任何地方選取一段文字 → 這個端點在教科書逐頁
// 全文索引(lecture_pages_fts,WHERE kind='textbook',migration 0033)裡
// 找最相關的頁,回 (slug, page) + snippet,前端據此跳到 /lectures/:slug?page=N。
//
// 查詢策略(見 docs/plans/2026-07-23-textbook-citations-design.md §2,
// 並經 pilot 實測校準):
//   1. 連字符家族(U+00AD 軟連字符等)正規化成 ASCII '-',與匯入端一致,
//      使 "T-cell" 兩側分詞相同(unicode61 以 '-' 為邊界)。
//   2. 去英文停用詞 + 過短 token。
//   3. **以 OR 串接** token(不是 AND):意圖是「跳到最相關的一頁」,
//      bm25 會把命中最多 / 最罕見詞的頁排前面。實測顯示 OR 嚴格優於 AND —
//      AND 對 "Auer rods"(頁面作 "Auer rod" 單數)、長句選取、"CRAB criteria"
//      皆回空,OR 都能回正確頁且 top-1 命中。
//
// Phase 1 = 純 FTS,零 Workers AI / 零 Vectorize,亞毫秒級。回饋加權 re-rank
// 與語意層是 Phase 2/3(設計 §4/§5),由回饋數據決定是否需要。
export const textbookRoutes = new Hono<AppContext>();

// GET /api/textbook/chapters → [{ slug, title, sort_order, page_count }]
//
// Flat list of Wintrobe 章節 (kind='textbook', migration 0033) ordered by
// sort_order (= chapter number). The 講義索引頁「Wintrobe's」分頁 groups these
// into Parts client-side (WINTROBE_PARTS in Lectures.tsx). No per-user
// annotation/note counts here — textbook chapters are read-only reference.
textbookRoutes.get("/chapters", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT slug, title, sort_order, page_count
         FROM lecture_docs
        WHERE kind = 'textbook'
        ORDER BY sort_order`,
	).all();
	return c.json(results ?? []);
});

// 英文停用詞 — 讓常見虛詞不主導 bm25。醫學術語(疾病/藥物/基因)一律保留。
const STOPWORDS = new Set(
	(
		"a an the of to in on at for and or but with without within from by as is are was " +
		"were be been being this that these those it its into due requiring required develop " +
		"developed developing patient patients using use used can may might will would should " +
		"their there here about over under between among across per via not no nor more most " +
		"less least than then also such other others another which who whom whose what when " +
		"where why how any all some each both either neither one two we they he she you i " +
		"have has had do does did done get got make made give given show shown case cases"
	).split(" "),
);

// Selected text → distinct content tokens (hyphen-normalised, stopwords &
// too-short dropped, deduped, capped). The building block for both the rule
// query and the AI-refined query.
function tokenize(raw: string): string[] {
	const seen = new Set<string>();
	const toks: string[] = [];
	for (const t of raw
		.replace(/[­‐‑‒–—−]/g, "-") // hyphen/dash family → '-'
		.toLowerCase()
		.replace(/["()*:]/g, " ") // strip FTS operator chars
		.split(/\s+/)) {
		const tok = t.trim();
		if (tok.length < 2 || STOPWORDS.has(tok)) continue;
		if (seen.has(tok)) continue;
		seen.add(tok);
		toks.push(tok);
		if (toks.length >= 40) break; // bound query size for pathological long selections
	}
	return toks;
}

// Tokens → FTS5 MATCH expression. Each token is a quoted phrase (so "bcr-abl"
// tokenises internally but can't inject FTS operators); OR between them so bm25
// ranks by coverage/rarity. Returns '' when nothing usable remains.
function toFtsQuery(toks: string[]): string {
	return toks.map((t) => '"' + t + '"').join(" OR ");
}

// POST /api/textbook/lookup  { text, limit? } → { hits: [{ slug, page, title, snippet, score }] }
//
// POST (not GET) because selected text can be long. Read-only; caller identity
// is c.var.email (Access-verified upstream) though this endpoint returns only
// shared textbook content, nothing per-user.
textbookRoutes.post("/lookup", async (c) => {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}
	const rec = (body ?? {}) as Record<string, unknown>;
	const text = typeof rec.text === "string" ? rec.text.trim() : "";
	const limit = Math.min(
		10,
		Math.max(1, parseInt(String(rec.limit ?? 5), 10) || 5),
	);

	if (text.length < 2)
		return c.json({ textbook: [], lecture: [], refined: false });

	const tokens = tokenize(text);
	const ftsQuery = toFtsQuery(tokens);
	if (ftsQuery.length === 0)
		return c.json({ textbook: [], lecture: [], refined: false });

	const lecLimit = Math.min(3, limit);

	// ── 1) Rule pass (always) — two independent FTS passes, one per kind, so each
	// corpus is ranked on its own bm25 scale (the terse Chinese 複習講義 slides and
	// the dense English Wintrobe pages aren't comparable on one shared score).
	// Both share lecture_pages_fts; only the kind filter differs. The 複習講義 side
	// is the same corpus the lecture reader's own search hits.
	let [textbook, lecture] = await Promise.all([
		queryPages(c.env.DB, ftsQuery, "textbook", limit),
		queryPages(c.env.DB, ftsQuery, "lecture", lecLimit),
	]);

	// ── 2) AI補一手 — only when the rule pass looks weak: a LONG selection (OR of
	// many tokens is noisy) or a LOW-confidence textbook result (no hits, or the
	// best bm25 is barely negative). Distil the selection to a few canonical
	// medical terms and re-run the SAME rule pipeline with them. Never let AI
	// errors surface — fall back to the rule results.
	const LONG_TOKENS = 12;
	const WEAK_TOP_SCORE = -2.0; // bm25: more negative = better; > this ≈ marginal
	const top = textbook[0] as { score?: number } | undefined;
	const isLong = tokens.length >= LONG_TOKENS;
	const isWeak =
		textbook.length === 0 ||
		(typeof top?.score === "number" && top.score > WEAK_TOP_SCORE);

	let refined = false;
	if (c.env.AI && (isLong || isWeak)) {
		try {
			const terms = await refineTerms(c.env.AI, text);
			const refinedQuery = toFtsQuery(tokenize(terms.join(" ")));
			if (refinedQuery && refinedQuery !== ftsQuery) {
				const [tb2, lec2] = await Promise.all([
					queryPages(c.env.DB, refinedQuery, "textbook", limit),
					queryPages(c.env.DB, refinedQuery, "lecture", lecLimit),
				]);
				// Prefer the AI-refined results when non-empty. We only get here because
				// the rule pass was weak/long, so the distilled query is the more
				// trustworthy one — and bm25 is NOT comparable across two different
				// queries (the many-term rule query always scores "more negative"), so
				// we must not score-compare rule vs AI. Fall back to rule per-group only
				// where AI found nothing.
				const usedTb = tb2.length > 0;
				const usedLec = lec2.length > 0;
				if (usedTb) textbook = tb2;
				if (usedLec) lecture = lec2;
				refined = usedTb || usedLec;
			}
		} catch {
			// AI unavailable / model error / bad JSON — silently keep rule results.
		}
	}

	return c.json({ textbook, lecture, refined });
});

// Distil a (possibly long / messy) selection into a few canonical hematology
// search terms via Workers AI. Returns [] on any failure so the caller falls
// back to the rule query. Kept tight (few tokens, temperature 0) for speed.
async function refineTerms(ai: Ai, text: string): Promise<string[]> {
	const out = await ai.run(TEXT_MODEL, {
		max_tokens: 120,
		temperature: 0,
		response_format: {
			type: "json_schema",
			json_schema: {
				type: "object",
				properties: {
					terms: {
						type: "array",
						minItems: 1,
						maxItems: 6,
						items: { type: "string" },
					},
				},
				required: ["terms"],
				additionalProperties: false,
			},
		},
		messages: [
			{
				role: "system",
				content:
					"You extract search keywords for a hematology textbook full-text index. " +
					"Given a passage or phrase, return the 2–5 most salient, specific medical " +
					"search terms: disease names, drug names, gene/protein names, lab findings, " +
					"classifications. Prefer canonical terms and well-known abbreviations " +
					"(e.g. 'chronic myeloid leukemia' → also 'BCR-ABL'). Drop generic filler " +
					'words. Output strictly as JSON {"terms": string[]}.',
			},
			{ role: "user", content: text.slice(0, 2000) },
		],
	});
	const raw = (out as { response?: unknown }).response;
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		const m = raw.match(/\{[\s\S]*\}/);
		parsed = m ? JSON.parse(m[0]) : {};
	}
	const terms = (parsed as { terms?: unknown })?.terms;
	if (!Array.isArray(terms)) return [];
	return terms.filter((t): t is string => typeof t === "string").slice(0, 6);
}

// One FTS pass over lecture_pages_fts scoped to a single doc kind.
// snippet() column index 2 = text (slug=0, page=1, text=2). char(1)/char(2)
// markers → HighlightedSnippet renders them as React <mark> (never
// dangerouslySetInnerHTML).
function queryPages(
	db: D1Database,
	ftsQuery: string,
	kind: "textbook" | "lecture",
	limit: number,
) {
	const sql = `SELECT
      p.slug AS slug,
      CAST(p.page AS INTEGER) AS page,
      d.title AS title,
      d.instructor AS instructor,
      bm25(lecture_pages_fts) AS score,
      snippet(lecture_pages_fts, 2, char(1), char(2), '…', 18) AS snippet
    FROM lecture_pages_fts p
    JOIN lecture_docs d ON d.slug = p.slug
    WHERE lecture_pages_fts MATCH ?1
      AND d.kind = ?2
    ORDER BY bm25(lecture_pages_fts)
    LIMIT ?3`;
	return db
		.prepare(sql)
		.bind(ftsQuery, kind, limit)
		.all()
		.then((r) => r.results ?? []);
}
