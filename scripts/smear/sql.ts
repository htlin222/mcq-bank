/**
 * 抹片匯入的 SQL 產生器 —— 純函式,不碰檔案系統也不呼叫 wrangler,所以測得動。
 *
 * ⚠️ 這支存在的理由:舊版 import.ts 是 delete-then-insert,**會清掉使用者資料**。
 *    上線前無所謂(沒有真人紀錄),但這個模組現在對 20 個人開著,而修一個
 *    拼錯的 alias、補一份詳解、加一批新圖都要重跑匯入。
 *
 * 舊版的刪除清單還比它自己宣稱的更寬:它寫著清掉 sessions / answers /
 * term_votes,但 `DELETE FROM smear_dx` 會沿 0044 的 ON DELETE CASCADE 一併帶走
 * `smear_notes` / `smear_comments` / `smear_dx_bookmarks` —— 那三張表是 0044
 * 才加的,而刪除清單停留在 0043 的年代。同一句還會在有投稿被歸類到那個診斷時
 * 直接 FK 失敗(`smear_submissions.matched_dx_id` 沒有 ON DELETE)。
 *
 * 所以這裡的分界是:
 *
 *   內容表(匯入擁有)  smear_dx / smear_terms / smear_questions / smear_dx_notes / smear_fts
 *   使用者表(匯入不碰) 見 USER_TABLES
 *
 * 內容表一律 upsert。但內容表裡**也有社群寫進去的列**(提報通過的寫法、核准的
 * 投稿題、站上編輯過的詳解),每一種各有一道 `WHERE` 閘擋住覆寫 —— 少了任何
 * 一道,症狀都是「我加的東西重跑一次匯入就不見了」,而且無聲。
 */

/** 匯入絕對不能出現在 SQL 裡的表。註解寫在上面。 */
export const USER_TABLES = [
	"smear_sessions",
	"smear_answers",
	"smear_term_votes",
	"smear_dx_bookmarks",
	"smear_notes",
	"smear_comments",
	"smear_submissions",
] as const;

/**
 * 社群寫進 `smear_questions` 的來源 —— 清過期題目時一律排除。
 *
 * ⚠️ 刻意不是反過來寫一份「匯入自己的來源」白名單(`exam`/`ash`/`po`)。
 *    那份清單會腐爛:`po` 在設計裡是計畫中的來源、`worker/routes/smear.ts`
 *    的 SOURCES 也收了它,但匯入目前根本不產 `po` —— 於是任何一筆 po 題目
 *    都不會出現在保留名單裡,第一次 `--prune` 就被當成過期刪掉,連同那題
 *    的作答歷史(smear_answers 對它是 ON DELETE CASCADE)。
 *    改成「只清這次真的產出過的來源」,清單自己跟著匯入走。
 */
export const COMMUNITY_SOURCES = ["submission"] as const;

/** 複合鍵的分隔符。normalizeTerm() 把 ':' 換成空白,而 dx_id 是 [a-z0-9_]
 *  的 slug —— 兩邊都不可能含有它,所以這個鍵沒有歧義。 */
export const KEY_SEP = "::";

/**
 * 詞條的主鍵。**由 (dx_id, norm) 決定,不是由它在 dx.json 陣列裡的位置。**
 *
 * ⚠️ 位置式 id(`${dx_id}-t${idx}`)在「改一個錯字」或「插一個詞」之後,
 *    同一個 id 會配到不同的 norm。那時 INSERT 撞的是 PRIMARY KEY,而 upsert
 *    的衝突目標是 UNIQUE(dx_id, norm) —— 目標不同,SQLite 直接報錯而不是
 *    更新,整批匯入中斷在半路。**原樣重跑不會壞**(兩個鍵指向同一列),
 *    所以手測與 CI 都看不到,只有真的去改詞表的人會撞上 —— 而那正是這支
 *    腳本改成可重跑之後,大家第一件要做的事。
 */
export function termKey(dxId: string, norm: string): string {
	if (dxId.includes(":") || norm.includes(":")) {
		throw new Error(
			`smear import: dx_id / norm 不能含有 ':'(拿到 dx_id=${dxId} norm=${norm})—— ` +
				`複合鍵會變得有歧義,而症狀是靜默刪錯列`,
		);
	}
	return `${dxId}${KEY_SEP}${norm}`;
}

export type Tier = "full" | "half" | "lay";
export type Form = "long" | "abbrev";

export interface DxInput {
	dx_id: string;
	canonical_long: string;
	canonical_abbrev: string | null;
	topic: string;
	qtype: "cell" | "disease";
}
export interface TermInput {
	dx_id: string;
	text: string;
	norm: string;
	tier: Tier;
	form: Form;
}
export interface QuestionInput {
	id: string;
	dx_id: string;
	source: string;
	source_ref: string | null;
	source_url: string | null;
	attribution: string | null;
	image_key_view: string;
	image_key_full: string;
	prompt: string | null;
	image_note: string | null;
}
export interface NoteInput {
	dx_id: string;
	content_json: unknown;
	related_dx_ids?: string[] | null;
}

export interface BuildOpts {
	dx: DxInput[];
	terms: TermInput[];
	questions: QuestionInput[];
	notes: NoteInput[];
	now: number;
	/**
	 * 刪掉來源檔裡已經沒有的診斷與題目。**預設關閉**,因為這兩種刪除都會
	 * 沿 CASCADE 帶走使用者資料(診斷 → 筆記/討論/收藏;題目 → 作答歷史)。
	 * 內容真的下架時才明講,並照 CLAUDE.md §5.1 的規矩先在 local 看過受影響列數。
	 */
	prune?: boolean;
}

export function esc(s: string): string {
	return s.replace(/'/g, "''");
}

/** SQL literal for a nullable string column: NULL or a quoted/escaped string. */
export function sqlStr(s: string | null | undefined): string {
	return s == null ? "NULL" : `'${esc(s)}'`;
}

const list = (xs: readonly string[]) => xs.map((x) => `'${esc(x)}'`).join(", ");

export function buildImportStatements(opts: BuildOpts): string[] {
	const { dx, terms, questions, notes, now, prune = false } = opts;
	const out: string[] = [];

	// ---- smear_dx ----
	// created_at 只在第一次寫入時給值 —— 更新時保留原本的,否則每次重跑
	// 整批診斷的「建立時間」都會跳到今天。
	for (const d of dx) {
		out.push(
			`INSERT INTO smear_dx (id, canonical_long, canonical_abbrev, topic, qtype, created_at) VALUES ` +
				`('${esc(d.dx_id)}', '${esc(d.canonical_long)}', ${sqlStr(d.canonical_abbrev)}, '${esc(d.topic)}', '${esc(d.qtype)}', ${now}) ` +
				`ON CONFLICT(id) DO UPDATE SET canonical_long = excluded.canonical_long, ` +
				`canonical_abbrev = excluded.canonical_abbrev, topic = excluded.topic, qtype = excluded.qtype;`,
		);
	}

	// ---- smear_terms ----
	// 唯一鍵是 (dx_id, norm),不是 id —— 同一個寫法可能已經由社群提報過,
	// 那一列的 id 是提報時產生的。衝突時保留對方的 id 與 status,只有在
	// 那是匯入自己的列(proposed_by IS NULL)時才更新顯示文字與 tier。
	for (const t of terms) {
		out.push(
			`INSERT INTO smear_terms (id, dx_id, text, norm, tier, form, status, rationale, proposed_by, created_at, resolved_at) VALUES ` +
				`('${esc(termKey(t.dx_id, t.norm))}', '${esc(t.dx_id)}', '${esc(t.text)}', '${esc(t.norm)}', '${esc(t.tier)}', '${esc(t.form)}', 'accepted', NULL, NULL, ${now}, NULL) ` +
				`ON CONFLICT(dx_id, norm) DO UPDATE SET text = excluded.text, tier = excluded.tier, form = excluded.form ` +
				`WHERE smear_terms.proposed_by IS NULL;`,
		);
	}

	// 過期的匯入詞條:留著一個拼錯的 alias,使用者打錯字會被判成答對 ——
	// 那是判定錯誤,不是資料陳舊,所以不等 --prune。三個範圍限制缺一不可:
	//
	//  dx_id IN (…)   只掃這次匯入有的診斷。少了它,一個從 dx.json 拿掉的診斷
	//                 (預設不 --prune,所以它的題目還在)會被清光所有詞條,
	//                 而 gradeSmear() 只看 smear_terms —— 那幾題從此每個答案
	//                 都判 miss,畫面上沒有任何東西解釋得了。
	//  proposed_by    社群提報的列不歸匯入管。
	//  没有票          刪了會沿 CASCADE 把票一起帶走。
	if (terms.length > 0) {
		const dxIds = [...new Set(terms.map((t) => t.dx_id))];
		out.push(
			`DELETE FROM smear_terms WHERE proposed_by IS NULL ` +
				`AND dx_id IN (${list(dxIds)}) ` +
				`AND id NOT IN (SELECT term_id FROM smear_term_votes) ` +
				`AND (dx_id || '${KEY_SEP}' || norm) NOT IN (${list(
					terms.map((t) => termKey(t.dx_id, t.norm)),
				)});`,
		);
	}

	// ---- smear_questions ----
	for (const q of questions) {
		out.push(
			`INSERT INTO smear_questions (id, dx_id, source, source_ref, source_url, attribution, image_key_view, image_key_full, prompt, image_note, created_at) VALUES ` +
				`('${esc(q.id)}', '${esc(q.dx_id)}', '${esc(q.source)}', ${sqlStr(q.source_ref)}, ${sqlStr(q.source_url)}, ${sqlStr(q.attribution)}, ` +
				`'${esc(q.image_key_view)}', '${esc(q.image_key_full)}', ${sqlStr(q.prompt)}, ${sqlStr(q.image_note)}, ${now}) ` +
				`ON CONFLICT(id) DO UPDATE SET dx_id = excluded.dx_id, source = excluded.source, source_ref = excluded.source_ref, ` +
				`source_url = excluded.source_url, attribution = excluded.attribution, image_key_view = excluded.image_key_view, ` +
				`image_key_full = excluded.image_key_full, prompt = excluded.prompt, image_note = excluded.image_note ` +
				`WHERE smear_questions.source <> 'submission';`,
		);
	}

	// ---- smear_dx_notes ----
	// version 只在建立時給 1;更新時不動它,也不清 editing_by / editing_until ——
	// 那兩欄是站上編輯鎖,匯入把它清掉等於在別人編輯到一半時把鎖拔了。
	for (const n of notes) {
		const related =
			n.related_dx_ids && n.related_dx_ids.length > 0
				? JSON.stringify(n.related_dx_ids)
				: null;
		out.push(
			`INSERT INTO smear_dx_notes (dx_id, content_json, related_dx_ids, version, updated_by, updated_at, editing_by, editing_until) VALUES ` +
				`('${esc(n.dx_id)}', '${esc(JSON.stringify(n.content_json))}', ${sqlStr(related)}, 1, NULL, ${now}, NULL, NULL) ` +
				`ON CONFLICT(dx_id) DO UPDATE SET content_json = excluded.content_json, ` +
				`related_dx_ids = excluded.related_dx_ids, updated_at = excluded.updated_at ` +
				`WHERE smear_dx_notes.updated_by IS NULL;`,
		);
	}

	// ---- 過期內容(只有 --prune) ----
	// 順序:先題目再診斷。反過來的話 smear_dx 的 CASCADE 會先把題目帶走,
	// 而那條路徑不受下面的來源限制保護 —— 核准的投稿會跟著消失。
	//
	// ⚠️ 兩個刪除各看各的清單。共用一個 `dx.length > 0` 的話,「有診斷但這次
	//    沒有題目」會產出 `id NOT IN ()`,而 SQLite 把空的 NOT IN 當成恆真 ——
	//    整批 exam/ash 題目連同作答歷史一起消失。
	if (prune && questions.length > 0) {
		const sources = [...new Set(questions.map((q) => q.source))].filter(
			(src) => !(COMMUNITY_SOURCES as readonly string[]).includes(src),
		);
		if (sources.length > 0) {
			out.push(
				`DELETE FROM smear_questions WHERE source IN (${list(sources)}) AND id NOT IN (${list(
					questions.map((q) => q.id),
				)});`,
			);
		}
	}
	if (prune && dx.length > 0) {
		out.push(`DELETE FROM smear_dx WHERE id NOT IN (${list(dx.map((d) => d.dx_id))});`);
	}

	// ---- smear_fts ----
	// 從**資料庫**重建,不是從匯入資料重建:社群提報通過的寫法、站上編輯過的
	// 詳解都在表裡而不在匯入的輸入裡,照著輸入建索引等於讓它們搜尋不到 ——
	// 而且無聲。詳解純文字走 json_tree(同 migration 0016 的慣用法),不把整份
	// content_json 塞進索引。
	// ⚠️ 清空與重建必須是**同一個**陣列元素:呼叫端每 50 條切一個 .sql 檔
	// 分開送,而那一步實測會偶發失敗(所以才有 shRetry)。落在不同檔案、
	// 而後者重試耗盡的話,smear_fts 會是空的 —— 搜尋從此什麼都找不到,無聲。
	out.push(
		"DELETE FROM smear_fts;\n" +
			`INSERT INTO smear_fts (dx_id, canonical, terms, topic, note) ` +
			`SELECT d.id, ` +
			`TRIM(d.canonical_long || ' ' || COALESCE(d.canonical_abbrev, '')), ` +
			`COALESCE((SELECT group_concat(t.text, ' ') FROM smear_terms t WHERE t.dx_id = d.id AND t.status = 'accepted'), ''), ` +
			`d.topic, ` +
			`COALESCE((SELECT group_concat(jt.value, ' ') FROM smear_dx_notes n, json_tree(n.content_json) jt ` +
			`WHERE n.dx_id = d.id AND jt.key = 'text' AND jt.type = 'text'), '') ` +
			`FROM smear_dx d;`,
	);

	return out;
}
