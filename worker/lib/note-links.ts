// 筆記關聯連結 — 計算與 cron drain。全確定性 SQL,零 Workers AI 神經元。
// 純函式(抽詞、排序)在 note-terms.ts;這裡是 D1 存取層。
//
// 連結範圍:私人筆記 → 同一使用者自己的其他筆記(不跨人)+ 公開題目。
// 見 docs/plans/2026-07-21-note-link-suggestions-design.md

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import {
	plainTextFromDoc,
	extractTerms,
	mergeTopSuggestions,
	type Candidate,
} from "./note-terms";

export const NOTE_LINK_LIMIT = 5; // 每則筆記最多建議數(連結密度護欄)
export const NOTE_LINK_MIN_SCORE = 0.15; // 低於此分數不建議(寧缺勿濫)
const CANDIDATE_POOL = NOTE_LINK_LIMIT + 5; // 每來源先取多一點再合併

// 每晚 cron 的安全邊際:一次 drain 最多處理 N 則筆記 / 寫入 N 列。剩下的
// 維持 needs_relink=1 明天再做 → 突發的大量筆記自動分攤 2~3 個晚上,並替
// 白天 app 的 D1 額度(免費層 100k writes/日)永遠留餘裕。可依實際量調。
export const DRAIN_MAX_NOTES = 200;
export const DRAIN_MAX_WRITES = 20_000;

function safeParseArr(s: string | null | undefined): string[] {
	if (!s) return [];
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

// 受控詞表 = DISTINCT question_tags。詞數(數百)有界,故每次計算現拉即可,
// 永遠是最新的標籤集合(keyword_vocab 只負責提供 idf 權重)。
export async function loadVocab(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT DISTINCT tag FROM question_tags")
		.all<{ tag: string }>();
	return (results ?? []).map((r) => r.tag);
}

// 重建 keyword_vocab(df + idf)。idf 在 JS 算(不依賴 SQLite 的 ln());
// 聚合是 DISTINCT-tag 大小,極小。夜間 cron 每次先跑一次。
export async function rebuildVocab(db: D1Database): Promise<number> {
	const now = Date.now();
	const nRow = await db
		.prepare("SELECT COUNT(*) AS n FROM questions")
		.first<{ n: number }>();
	const N = Math.max(1, nRow?.n ?? 1);
	const { results } = await db
		.prepare("SELECT tag, COUNT(*) AS df FROM question_tags GROUP BY tag")
		.all<{ tag: string; df: number }>();
	const rows = results ?? [];
	if (!rows.length) {
		await db.prepare("DELETE FROM keyword_vocab").run();
		return 0;
	}
	const stmt = db.prepare(
		`INSERT INTO keyword_vocab (term, df, idf, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(term) DO UPDATE SET df=excluded.df, idf=excluded.idf, updated_at=excluded.updated_at`,
	);
	const ops: D1PreparedStatement[] = rows.map((r) => {
		// 常見詞 idf→0,不貢獻分數;floor 0.01 避免出現負分。
		const idf = Math.max(0.01, Math.log(N / (1 + r.df)));
		return stmt.bind(r.tag, r.df, idf, now);
	});
	// 清掉已不存在的 tag。
	const keep = rows.map(() => "?").join(",");
	ops.push(
		db
			.prepare(`DELETE FROM keyword_vocab WHERE term NOT IN (${keep})`)
			.bind(...rows.map((r) => r.tag)),
	);
	await db.batch(ops);
	return rows.length;
}

// 針對「某人在某一題的筆記」重算:抽詞 → 覆寫 note_terms → 依 idf 找候選
// (題目 + 同使用者自己的筆記)→ 合併取 top-N → 覆寫 note_link_suggestions →
// 清 needs_relink。整批以 db.batch() 原子寫入。回傳寫入列數供預算計數。
//
// 一題可以有多則筆記(migration 0036),所以吃的是一組文件:詞彙取聯集,
// 建議仍以「一題一組」產出 —— 逐則算會讓同一題的幾則筆記互相推薦,而它們
// 本來就並排在同一頁上。
export async function computeNoteSuggestions(
	db: D1Database,
	email: string,
	questionId: string,
	contentJson: string | string[],
	vocab: string[],
): Promise<{ suggestions: Candidate[]; writes: number }> {
	const docs = Array.isArray(contentJson) ? contentJson : [contentJson];
	const texts: string[] = [];
	for (const raw of docs) {
		try {
			texts.push(plainTextFromDoc(JSON.parse(raw)));
		} catch {
			// 壞掉的一則不該讓整題的建議消失 —— 跳過它,其餘照算。
		}
	}
	const terms = extractTerms(texts.join("\n"), vocab);

	const now = Date.now();
	const ops: D1PreparedStatement[] = [];
	let writes = 0;

	ops.push(
		db
			.prepare("DELETE FROM note_terms WHERE user_email=? AND question_id=?")
			.bind(email, questionId),
	);
	const termStmt = db.prepare(
		"INSERT OR IGNORE INTO note_terms (user_email, question_id, term) VALUES (?,?,?)",
	);
	for (const t of terms) {
		ops.push(termStmt.bind(email, questionId, t));
		writes++;
	}

	ops.push(
		db
			.prepare(
				"DELETE FROM note_link_suggestions WHERE user_email=? AND question_id=?",
			)
			.bind(email, questionId),
	);

	let merged: Candidate[] = [];
	if (terms.length) {
		const ph = terms.map(() => "?").join(",");

		// 候選題目:公開題目中帶有本筆記命中詞者(排除本題)。分數 = Σ idf。
		const qCand = await db
			.prepare(
				`SELECT qt.question_id AS target_id,
                SUM(COALESCE(v.idf, 0.5)) AS score,
                json_group_array(qt.tag) AS shared_terms
           FROM question_tags qt
           LEFT JOIN keyword_vocab v ON v.term = qt.tag
          WHERE qt.tag IN (${ph}) AND qt.question_id != ?
          GROUP BY qt.question_id
          ORDER BY score DESC
          LIMIT ?`,
			)
			.bind(...terms, questionId, CANDIDATE_POOL)
			.all<{ target_id: string; score: number; shared_terms: string }>();

		// 候選筆記:只在「同一 user_email」自己的其他筆記裡找(隱私紅線)。
		const nCand = await db
			.prepare(
				`SELECT nt.question_id AS target_id,
                SUM(COALESCE(v.idf, 0.5)) AS score,
                json_group_array(nt.term) AS shared_terms
           FROM note_terms nt
           LEFT JOIN keyword_vocab v ON v.term = nt.term
          WHERE nt.user_email = ? AND nt.term IN (${ph}) AND nt.question_id != ?
          GROUP BY nt.question_id
          ORDER BY score DESC
          LIMIT ?`,
			)
			.bind(email, ...terms, questionId, CANDIDATE_POOL)
			.all<{ target_id: string; score: number; shared_terms: string }>();

		const toCand = (
			rows: { target_id: string; score: number; shared_terms: string }[],
			kind: "note" | "question",
		): Candidate[] =>
			(rows ?? []).map((r) => ({
				targetKind: kind,
				targetId: r.target_id,
				score: r.score ?? 0,
				sharedTerms: safeParseArr(r.shared_terms),
			}));

		merged = mergeTopSuggestions(
			[
				...toCand(qCand.results, "question"),
				...toCand(nCand.results, "note"),
			],
			{ limit: NOTE_LINK_LIMIT, minScore: NOTE_LINK_MIN_SCORE },
		);

		const insSug = db.prepare(
			`INSERT INTO note_link_suggestions
         (user_email, question_id, target_kind, target_id, score, shared_terms, computed_at)
       VALUES (?,?,?,?,?,?,?)`,
		);
		for (const s of merged) {
			ops.push(
				insSug.bind(
					email,
					questionId,
					s.targetKind,
					s.targetId,
					s.score,
					JSON.stringify(s.sharedTerms),
					now,
				),
			);
			writes++;
		}
	}

	ops.push(
		db
			.prepare(
				"UPDATE personal_notes SET needs_relink=0 WHERE user_email=? AND question_id=?",
			)
			.bind(email, questionId),
	);
	writes++;

	await db.batch(ops);
	return { suggestions: merged, writes };
}

// 夜間 cron:把 needs_relink=1 的筆記依「最舊優先」(公平,避免某人一次
// 倒大量筆記把別人餓死)逐則重算,到達 note/write 預算就停,剩下的明晚再做。
export async function drainRelinkQueue(
	db: D1Database,
	opts: { maxNotes?: number; maxWrites?: number } = {},
): Promise<{ processed: number; writes: number; remaining: number }> {
	const maxNotes = opts.maxNotes ?? DRAIN_MAX_NOTES;
	const maxWrites = opts.maxWrites ?? DRAIN_MAX_WRITES;
	const vocab = await loadVocab(db);

	// 一題多則時要整題一起算,所以先取「還沒算的 (人, 題)」,再把那題的全部
	// 筆記撈齊 —— 逐列跑會讓同一題的幾則筆記彼此覆寫對方的結果。
	const { results } = await db
		.prepare(
			`SELECT user_email, question_id, MIN(updated_at) AS oldest
         FROM personal_notes
        WHERE needs_relink = 1
        GROUP BY user_email, question_id
        ORDER BY oldest ASC
        LIMIT ?`,
		)
		.bind(maxNotes)
		.all<{ user_email: string; question_id: string }>();

	let processed = 0;
	let writes = 0;
	for (const row of results ?? []) {
		if (writes >= maxWrites) break;
		const { results: docs } = await db
			.prepare(
				"SELECT content_json FROM personal_notes WHERE user_email = ? AND question_id = ? ORDER BY slot",
			)
			.bind(row.user_email, row.question_id)
			.all<{ content_json: string }>();
		const r = await computeNoteSuggestions(
			db,
			row.user_email,
			row.question_id,
			(docs ?? []).map((d) => d.content_json),
			vocab,
		);
		writes += r.writes;
		processed++;
	}

	const remainRow = await db
		.prepare("SELECT COUNT(*) AS n FROM personal_notes WHERE needs_relink = 1")
		.first<{ n: number }>();
	return { processed, writes, remaining: remainRow?.n ?? 0 };
}
