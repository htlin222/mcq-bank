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
	type OwnerKind,
} from "./note-terms";

// 擁有者是題目筆記還是自由筆記,決定髒旗標寫回哪張表。
const OWNER_TABLE: Record<OwnerKind, string> = {
	question: "personal_notes",
	free: "free_notes",
};
const OWNER_ID_COL: Record<OwnerKind, string> = {
	question: "question_id",
	free: "id",
};

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

// 針對「一個筆記擁有者」重算:抽詞 → 覆寫 note_terms → 依 idf 找候選
// (題目 + 同使用者自己的筆記,含題目筆記與自由筆記)→ 合併取 top-N →
// 覆寫 note_link_suggestions → 清 needs_relink。整批以 db.batch() 原子寫入。
// 回傳寫入列數供預算計數。
//
// 擁有者有兩種(migration 0040):
//   ownerKind='question' → ownerId 是題號,一題可以有多則筆記(0036),所以吃
//     的是一組文件:詞彙取聯集,建議仍以「一題一組」產出 —— 逐則算會讓同一題
//     的幾則筆記互相推薦,而它們本來就並排在同一頁上。
//   ownerKind='free'     → ownerId 是 free_notes.id,一則就是一組。
export async function computeNoteSuggestions(
	db: D1Database,
	email: string,
	ownerKind: OwnerKind,
	ownerId: string,
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
			.prepare(
				"DELETE FROM note_terms WHERE user_email=? AND owner_kind=? AND owner_id=?",
			)
			.bind(email, ownerKind, ownerId),
	);
	const termStmt = db.prepare(
		"INSERT OR IGNORE INTO note_terms (user_email, owner_kind, owner_id, term) VALUES (?,?,?,?)",
	);
	for (const t of terms) {
		ops.push(termStmt.bind(email, ownerKind, ownerId, t));
		writes++;
	}

	ops.push(
		db
			.prepare(
				"DELETE FROM note_link_suggestions WHERE user_email=? AND owner_kind=? AND owner_id=?",
			)
			.bind(email, ownerKind, ownerId),
	);

	let merged: Candidate[] = [];
	if (terms.length) {
		const ph = terms.map(() => "?").join(",");

		// 候選題目:公開題目中帶有本筆記命中詞者。分數 = Σ idf。
		// 自由筆記沒有「本題」可排除,傳空字串 —— 題號永遠非空,故不會誤排。
		const selfQuestionId = ownerKind === "question" ? ownerId : "";
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
			.bind(...terms, selfQuestionId, CANDIDATE_POOL)
			.all<{ target_id: string; score: number; shared_terms: string }>();

		// 候選筆記:只在「同一 user_email」自己的其他筆記裡找(隱私紅線)。
		// 題目筆記與自由筆記同住一張 note_terms,所以一次查詢兩種都拿得到;
		// owner_kind 決定它在結果裡是 'note' 還是 'free'。
		const nCand = await db
			.prepare(
				`SELECT nt.owner_kind AS owner_kind,
                nt.owner_id   AS target_id,
                SUM(COALESCE(v.idf, 0.5)) AS score,
                json_group_array(nt.term) AS shared_terms
           FROM note_terms nt
           LEFT JOIN keyword_vocab v ON v.term = nt.term
          WHERE nt.user_email = ? AND nt.term IN (${ph})
            AND NOT (nt.owner_kind = ? AND nt.owner_id = ?)
          GROUP BY nt.owner_kind, nt.owner_id
          ORDER BY score DESC
          LIMIT ?`,
			)
			.bind(email, ...terms, ownerKind, ownerId, CANDIDATE_POOL)
			.all<{
				owner_kind: OwnerKind;
				target_id: string;
				score: number;
				shared_terms: string;
			}>();

		const toQuestionCand = (
			rows: { target_id: string; score: number; shared_terms: string }[],
		): Candidate[] =>
			(rows ?? []).map((r) => ({
				targetKind: "question" as const,
				targetId: r.target_id,
				score: r.score ?? 0,
				sharedTerms: safeParseArr(r.shared_terms),
			}));

		const toNoteCand = (
			rows: {
				owner_kind: OwnerKind;
				target_id: string;
				score: number;
				shared_terms: string;
			}[],
		): Candidate[] =>
			(rows ?? []).map((r) => ({
				// 'question' 擁有者 = 掛在某題下的個人筆記 → 目標種類 'note'。
				targetKind: r.owner_kind === "free" ? ("free" as const) : ("note" as const),
				targetId: r.target_id,
				score: r.score ?? 0,
				sharedTerms: safeParseArr(r.shared_terms),
			}));

		merged = mergeTopSuggestions(
			[...toQuestionCand(qCand.results), ...toNoteCand(nCand.results)],
			{ limit: NOTE_LINK_LIMIT, minScore: NOTE_LINK_MIN_SCORE },
		);

		const insSug = db.prepare(
			`INSERT INTO note_link_suggestions
         (user_email, owner_kind, owner_id, target_kind, target_id, score, shared_terms, computed_at)
       VALUES (?,?,?,?,?,?,?,?)`,
		);
		for (const s of merged) {
			ops.push(
				insSug.bind(
					email,
					ownerKind,
					ownerId,
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

	// 表名/欄名來自上面的常數對照,不是使用者輸入 —— ownerKind 的型別只有
	// 兩個字面值,拼不出別的東西。
	ops.push(
		db
			.prepare(
				`UPDATE ${OWNER_TABLE[ownerKind]} SET needs_relink=0
          WHERE user_email=? AND ${OWNER_ID_COL[ownerKind]}=?`,
			)
			.bind(email, ownerId),
	);
	writes++;

	await db.batch(ops);
	return { suggestions: merged, writes };
}

// 一則建議在 API 上的形狀。題目 / 題目筆記帶題目欄位,自由筆記帶標題。
export type NoteLink = {
	targetKind: "question" | "note" | "free";
	targetId: string;
	sharedTerms: string[];
	year?: number;
	number?: number;
	stem?: string;
	group?: string | null;
	title?: string;
};

// 讀出某個擁有者的建議。三種目標各有各的「還存在嗎」檢查:
//   question — JOIN questions(題目被刪就不該再出現)
//   note     — 目標題目仍有自己的個人筆記
//   free     — 目標自由筆記仍存在,且是自己的
// 這裡刻意不用單一 JOIN:原本的 `JOIN questions q ON q.id = s.target_id` 會把
// 自由筆記目標**靜默丟掉**(它的 target_id 不是題號),建議就少一種來源而且
// 完全無聲。
export async function loadSuggestions(
	db: D1Database,
	email: string,
	ownerKind: OwnerKind,
	ownerId: string,
): Promise<NoteLink[]> {
	const { results } = await db
		.prepare(
			`SELECT s.target_kind, s.target_id, s.score, s.shared_terms,
              q.year, q.number, q.stem, q."group" AS grp,
              f.title
         FROM note_link_suggestions s
         LEFT JOIN questions  q ON q.id = s.target_id
                                AND s.target_kind IN ('question','note')
         LEFT JOIN free_notes f ON f.id = s.target_id
                                AND s.target_kind = 'free'
                                AND f.user_email = s.user_email
        WHERE s.user_email = ? AND s.owner_kind = ? AND s.owner_id = ?
          AND (
            (s.target_kind = 'question' AND q.id IS NOT NULL)
            OR (s.target_kind = 'note' AND q.id IS NOT NULL
                AND EXISTS (SELECT 1 FROM personal_notes pn
                             WHERE pn.user_email = s.user_email
                               AND pn.question_id = s.target_id))
            OR (s.target_kind = 'free' AND f.id IS NOT NULL)
          )
        ORDER BY s.score DESC`,
		)
		.bind(email, ownerKind, ownerId)
		.all<{
			target_kind: NoteLink["targetKind"];
			target_id: string;
			shared_terms: string;
			year: number | null;
			number: number | null;
			stem: string | null;
			grp: string | null;
			title: string | null;
		}>();

	return (results ?? []).map((r) => {
		const base = {
			targetKind: r.target_kind,
			targetId: r.target_id,
			sharedTerms: safeParseArr(r.shared_terms),
		};
		if (r.target_kind === "free") {
			return { ...base, title: r.title ?? "" };
		}
		return {
			...base,
			year: r.year ?? undefined,
			number: r.number ?? undefined,
			stem: r.stem ?? undefined,
			group: r.grp,
		};
	});
}

// 把一段純文字包成最小的 TipTap 文件,好跟內文走同一條 plainTextFromDoc 路徑。
// 標題與 AI 標籤都是純文字,但抽詞應該看得到它們 —— 「AML 整理」這種只寫在
// 標題上的關鍵字,不包進來就完全不參與評分。
export function textAsDoc(text: string): string {
	return JSON.stringify({
		type: "doc",
		content: [{ type: "paragraph", content: [{ type: "text", text }] }],
	});
}

// 一個擁有者的全部可抽詞文件。題目筆記是該題的每一則;自由筆記是內文 +
// 標題 + 已有的標籤。
export async function loadOwnerDocs(
	db: D1Database,
	email: string,
	ownerKind: OwnerKind,
	ownerId: string,
): Promise<string[]> {
	if (ownerKind === "question") {
		const { results } = await db
			.prepare(
				"SELECT content_json FROM personal_notes WHERE user_email = ? AND question_id = ? ORDER BY slot",
			)
			.bind(email, ownerId)
			.all<{ content_json: string }>();
		return (results ?? []).map((d) => d.content_json);
	}

	const note = await db
		.prepare(
			"SELECT title, content_json FROM free_notes WHERE id = ? AND user_email = ?",
		)
		.bind(ownerId, email)
		.first<{ title: string; content_json: string }>();
	if (!note) return [];

	const { results: tags } = await db
		.prepare(
			"SELECT tag FROM free_note_tags WHERE note_id = ? AND source != 'hidden'",
		)
		.bind(ownerId)
		.all<{ tag: string }>();

	const docs = [note.content_json];
	if (note.title.trim()) docs.push(textAsDoc(note.title));
	const tagLine = (tags ?? []).map((t) => t.tag).join(" ");
	if (tagLine.trim()) docs.push(textAsDoc(tagLine));
	return docs;
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
	// 自由筆記一則就是一組,但排隊要跟題目筆記混在同一條「最舊優先」的隊伍
	// 裡 —— 兩條各自取 LIMIT 的話,筆記多的那一種會永遠優先。
	const { results } = await db
		.prepare(
			`SELECT * FROM (
         SELECT user_email, 'question' AS owner_kind, question_id AS owner_id,
                MIN(updated_at) AS oldest
           FROM personal_notes
          WHERE needs_relink = 1
          GROUP BY user_email, question_id
         UNION ALL
         SELECT user_email, 'free' AS owner_kind, id AS owner_id, updated_at AS oldest
           FROM free_notes
          WHERE needs_relink = 1
       )
        ORDER BY oldest ASC
        LIMIT ?`,
		)
		.bind(maxNotes)
		.all<{ user_email: string; owner_kind: OwnerKind; owner_id: string }>();

	let processed = 0;
	let writes = 0;
	for (const row of results ?? []) {
		if (writes >= maxWrites) break;
		const docs = await loadOwnerDocs(db, row.user_email, row.owner_kind, row.owner_id);
		const r = await computeNoteSuggestions(
			db,
			row.user_email,
			row.owner_kind,
			row.owner_id,
			docs,
			vocab,
		);
		writes += r.writes;
		processed++;
	}

	const remainRow = await db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM personal_notes WHERE needs_relink = 1)
              + (SELECT COUNT(*) FROM free_notes     WHERE needs_relink = 1) AS n`,
		)
		.first<{ n: number }>();
	return { processed, writes, remaining: remainRow?.n ?? 0 };
}
