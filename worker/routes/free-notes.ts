// 其他筆記(自由筆記)—— 不掛在任何題目上的私人筆記。
// 設計:docs/plans/2026-08-07-free-notes-design.md
//
// 每一條查詢都帶 user_email = ?:id 是亂數但**不當作機密**,猜到也讀不到。

import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import type { AppContext } from "../types";
import { TEXT_MODEL } from "../lib/ai-models";
import { buildNoteTagsSystemPrompt, parseTagsResponse } from "./ai";
import {
	loadVocab,
	loadOwnerDocs,
	loadSuggestions,
	computeNoteSuggestions,
} from "../lib/note-links";
import { plainTextFromDoc } from "../lib/note-terms";

export const freeNotesRoutes = new Hono<AppContext>();

/** 一個人最多幾則自由筆記。護欄,不是產品限制 —— 20 人的讀書會離這很遠。 */
const MAX_FREE_NOTES = 500;
const MAX_TITLE_LEN = 200;
/** 一則筆記最多幾個可見標籤(AI + 手動合計)。 */
const MAX_TAGS_PER_NOTE = 16;
/** 送進模型的內文上限,與 /api/ai/suggest-tags 對齊。 */
const TAG_INPUT_LIMIT = 2000;

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function excerptOf(contentJson: string, max = 140): string {
	try {
		const t = plainTextFromDoc(JSON.parse(contentJson))
			.replace(/\s+/g, " ")
			.trim();
		return t.length > max ? `${t.slice(0, max)}…` : t;
	} catch {
		return "";
	}
}

// djb2 —— 與前端 AnnotatableContent.hashContent 同一個演算法,但這裡只用來
// 判斷「內容變了沒」,不跨端比對,所以不需要兩邊完全一致。
function hashContent(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return String(h >>> 0);
}

// ── 列表 ──────────────────────────────────────────────────────────────

// 標籤一起帶出來(卡片上要顯示)。筆記數量是幾十則的量級,一次 join 全撈
// 比 N+1 便宜,前端也才能在這個分頁做即時的本地過濾。
freeNotesRoutes.get("/", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT n.id, n.title, n.content_json, n.created_at, n.updated_at,
            (SELECT GROUP_CONCAT(t.tag, char(10)) FROM free_note_tags t
               WHERE t.note_id = n.id AND t.source != 'hidden') AS tags
       FROM free_notes n
      WHERE n.user_email = ?
      ORDER BY n.updated_at DESC`,
	)
		.bind(email)
		.all<{
			id: string;
			title: string;
			content_json: string;
			created_at: number;
			updated_at: number;
			tags: string | null;
		}>();

	const notes = (results ?? []).map((r) => ({
		id: r.id,
		title: r.title,
		excerpt: excerptOf(r.content_json),
		tags: r.tags ? r.tags.split("\n").filter(Boolean) : [],
		created_at: r.created_at,
		updated_at: r.updated_at,
	}));
	return c.json({ notes });
});

// ── 新增 ──────────────────────────────────────────────────────────────

freeNotesRoutes.post("/", async (c) => {
	const email = c.var.email;
	const body = await c.req
		.json<{ title?: string; content_json?: any }>()
		.catch(() => ({}) as { title?: string; content_json?: any });

	const row = await c.env.DB.prepare(
		"SELECT COUNT(*) AS n FROM free_notes WHERE user_email = ?",
	)
		.bind(email)
		.first<{ n: number }>();
	if ((row?.n ?? 0) >= MAX_FREE_NOTES) {
		return c.json({ error: "too many notes", max: MAX_FREE_NOTES }, 409);
	}

	const id = crypto.randomUUID();
	const now = Date.now();
	const title = (body.title ?? "").slice(0, MAX_TITLE_LEN);
	const content = JSON.stringify(body.content_json ?? EMPTY_DOC);

	await c.env.DB.prepare(
		`INSERT INTO free_notes (id, user_email, title, content_json, created_at, updated_at, needs_relink)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
	)
		.bind(id, email, title, content, now, now)
		.run();

	return c.json({ id, title, created_at: now, updated_at: now }, 201);
});

// ── 單則讀取 ──────────────────────────────────────────────────────────

freeNotesRoutes.get("/:id", async (c) => {
	const email = c.var.email;
	const note = await c.env.DB.prepare(
		`SELECT id, title, content_json, created_at, updated_at
       FROM free_notes WHERE id = ? AND user_email = ?`,
	)
		.bind(c.req.param("id"), email)
		.first<{
			id: string;
			title: string;
			content_json: string;
			created_at: number;
			updated_at: number;
		}>();
	if (!note) return c.json({ error: "not found" }, 404);

	return c.json({
		id: note.id,
		title: note.title,
		content_json: JSON.parse(note.content_json),
		created_at: note.created_at,
		updated_at: note.updated_at,
	});
});

// ── 存檔 ──────────────────────────────────────────────────────────────

// 寫入端**不呼叫 Workers AI**。打字中的 debounce 存檔一秒好幾次,在這裡叫
// 模型等於把免費額度燒在沒人看的中間狀態上。標籤的產生點在 GET /:id/tags。
freeNotesRoutes.put("/:id", async (c) => {
	const email = c.var.email;
	const id = c.req.param("id");
	const body = await c.req.json<{ title?: string; content_json?: any }>();

	const exists = await c.env.DB.prepare(
		"SELECT id FROM free_notes WHERE id = ? AND user_email = ?",
	)
		.bind(id, email)
		.first();
	if (!exists) return c.json({ error: "not found" }, 404);

	const now = Date.now();
	const sets: string[] = ["updated_at = ?", "needs_relink = 1"];
	const binds: unknown[] = [now];
	if (typeof body.title === "string") {
		sets.unshift("title = ?");
		binds.unshift(body.title.slice(0, MAX_TITLE_LEN));
	}
	if (body.content_json !== undefined) {
		sets.unshift("content_json = ?");
		binds.unshift(JSON.stringify(body.content_json));
	}

	await c.env.DB.prepare(
		`UPDATE free_notes SET ${sets.join(", ")} WHERE id = ? AND user_email = ?`,
	)
		.bind(...binds, id, email)
		.run();

	return c.json({ ok: true, updated_at: now });
});

// ── 刪除 ──────────────────────────────────────────────────────────────

// free_note_tags 靠 FK ON DELETE CASCADE,但 note_terms /
// note_link_suggestions 自 0036 起就不帶 FK(複合父鍵不唯一),所以顯式刪。
// 另外要清掉「別人指向這一則」的建議,否則刪掉的筆記會繼續出現在其他筆記
// 下方,而 loadSuggestions 的存在性檢查只擋得住顯示、擋不住殘留列。
freeNotesRoutes.delete("/:id", async (c) => {
	const email = c.var.email;
	const id = c.req.param("id");

	const exists = await c.env.DB.prepare(
		"SELECT id FROM free_notes WHERE id = ? AND user_email = ?",
	)
		.bind(id, email)
		.first();
	if (!exists) return c.json({ error: "not found" }, 404);

	await c.env.DB.batch([
		c.env.DB.prepare(
			"DELETE FROM free_notes WHERE id = ? AND user_email = ?",
		).bind(id, email),
		c.env.DB.prepare("DELETE FROM free_note_tags WHERE note_id = ?").bind(id),
		c.env.DB.prepare(
			"DELETE FROM note_terms WHERE user_email = ? AND owner_kind = 'free' AND owner_id = ?",
		).bind(email, id),
		c.env.DB.prepare(
			"DELETE FROM note_link_suggestions WHERE user_email = ? AND owner_kind = 'free' AND owner_id = ?",
		).bind(email, id),
		c.env.DB.prepare(
			"DELETE FROM note_link_suggestions WHERE user_email = ? AND target_kind = 'free' AND target_id = ?",
		).bind(email, id),
	]);

	return c.json({ ok: true });
});

// ── 標籤 ──────────────────────────────────────────────────────────────

type TagRow = { tag: string; source: string };

// 墓碑('hidden')不回給前端 —— 它只存在於「不要再自動加回來」這個用途。
async function readTags(db: D1Database, id: string): Promise<TagRow[]> {
	const { results } = await db
		.prepare(
			`SELECT tag, source FROM free_note_tags
        WHERE note_id = ? AND source != 'hidden'
        ORDER BY source, created_at`,
		)
		.bind(id)
		.all<TagRow>();
	return results ?? [];
}

// 標籤的產生點。內容雜湊與 tagged_hash 不同時才呼叫模型 —— 旗標會被
// 「存檔 → 還沒產標籤 → 又存檔回原內容」騙到,雜湊不會。
//
// 只覆寫 source='ai' 的那批;使用者手動加的標籤留著,手動刪掉的也不會復活。
freeNotesRoutes.get("/:id/tags", async (c) => {
	const email = c.var.email;
	const id = c.req.param("id");

	const note = await c.env.DB.prepare(
		"SELECT title, content_json, tagged_hash FROM free_notes WHERE id = ? AND user_email = ?",
	)
		.bind(id, email)
		.first<{
			title: string;
			content_json: string;
			tagged_hash: string | null;
		}>();
	if (!note) return c.json({ error: "not found" }, 404);

	const text =
		`${note.title}\n${excerptOf(note.content_json, TAG_INPUT_LIMIT)}`.trim();
	const hash = hashContent(text);

	// 內容太短就不值得叫模型 —— 空筆記只會拿回亂猜的標籤。
	if (hash !== note.tagged_hash && text.length >= 20) {
		try {
			const out = await c.env.AI.run(TEXT_MODEL, {
				messages: [
					{ role: "system", content: buildNoteTagsSystemPrompt(c.env) },
					{ role: "user", content: text.slice(0, TAG_INPUT_LIMIT) },
				],
			});
			const tags = parseTagsResponse(out);
			const now = Date.now();
			const ops = [
				c.env.DB.prepare(
					"DELETE FROM free_note_tags WHERE note_id = ? AND source = 'ai'",
				).bind(id),
				// 標籤變了,建議跟著重算(抽詞的輸入包含標籤)。
				c.env.DB.prepare(
					"UPDATE free_notes SET tagged_hash = ?, needs_relink = 1 WHERE id = ?",
				).bind(hash, id),
			];
			for (const t of tags) {
				// 使用者手動加過同名標籤時不覆寫它的 source —— OR IGNORE 讓
				// 'user' 那列活下來,重跑才不會把它悄悄降級成 'ai'。
				ops.push(
					c.env.DB.prepare(
						"INSERT OR IGNORE INTO free_note_tags (note_id, tag, source, created_at) VALUES (?,?,'ai',?)",
					).bind(id, t, now),
				);
			}
			await c.env.DB.batch(ops);
		} catch (e) {
			// 非致命:標籤產不出來就先回既有的,下次打開再試。
			console.warn("free-note tag generation failed", id, String(e));
		}
	}

	return c.json({ tags: await readTags(c.env.DB, id) });
});

// 手動加一個標籤。OR REPLACE:如果這個標籤先前被刪過(留著 'hidden' 墓碑),
// 重新加回來要能蓋掉墓碑。
freeNotesRoutes.post("/:id/tags", async (c) => {
	const email = c.var.email;
	const id = c.req.param("id");
	const body = await c.req.json<{ tag?: unknown }>();
	const tag = typeof body.tag === "string" ? body.tag.trim().slice(0, 60) : "";
	if (!tag) return c.json({ error: "empty tag" }, 400);

	const exists = await c.env.DB.prepare(
		"SELECT id FROM free_notes WHERE id = ? AND user_email = ?",
	)
		.bind(id, email)
		.first();
	if (!exists) return c.json({ error: "not found" }, 404);

	const n = await c.env.DB.prepare(
		"SELECT COUNT(*) AS n FROM free_note_tags WHERE note_id = ? AND source != 'hidden'",
	)
		.bind(id)
		.first<{ n: number }>();
	if ((n?.n ?? 0) >= MAX_TAGS_PER_NOTE) {
		return c.json({ error: "too many tags", max: MAX_TAGS_PER_NOTE }, 409);
	}

	await c.env.DB.batch([
		c.env.DB.prepare(
			"INSERT OR REPLACE INTO free_note_tags (note_id, tag, source, created_at) VALUES (?,?,'user',?)",
		).bind(id, tag, Date.now()),
		// 標籤參與抽詞(loadOwnerDocs),所以建議要重算。
		c.env.DB.prepare(
			"UPDATE free_notes SET needs_relink = 1 WHERE id = ?",
		).bind(id),
	]);

	return c.json({ tags: await readTags(c.env.DB, id) });
});

// 刪一個標籤 —— 寫墓碑,不是刪列。真的刪掉的話,下次內容一變,模型看同一份
// 內容會給出同一個標籤,它就又回來了。
freeNotesRoutes.delete("/:id/tags", async (c) => {
	const email = c.var.email;
	const id = c.req.param("id");
	const tag = (c.req.query("tag") ?? "").trim();
	if (!tag) return c.json({ error: "empty tag" }, 400);

	const exists = await c.env.DB.prepare(
		"SELECT id FROM free_notes WHERE id = ? AND user_email = ?",
	)
		.bind(id, email)
		.first();
	if (!exists) return c.json({ error: "not found" }, 404);

	await c.env.DB.batch([
		c.env.DB.prepare(
			"INSERT OR REPLACE INTO free_note_tags (note_id, tag, source, created_at) VALUES (?,?,'hidden',?)",
		).bind(id, tag, Date.now()),
		c.env.DB.prepare(
			"UPDATE free_notes SET needs_relink = 1 WHERE id = ?",
		).bind(id),
	]);

	return c.json({ tags: await readTags(c.env.DB, id) });
});

// ── 關聯建議 ──────────────────────────────────────────────────────────

// 髒了就當場算(確定性 SQL,零 neuron),所以建議感覺是「即時」的,不用等
// 夜間 cron。與 /api/questions/:id/note/links 同一套。
freeNotesRoutes.get("/:id/links", async (c) => {
	const email = c.var.email;
	const id = c.req.param("id");

	const note = await c.env.DB.prepare(
		"SELECT needs_relink FROM free_notes WHERE id = ? AND user_email = ?",
	)
		.bind(id, email)
		.first<{ needs_relink: number }>();
	if (!note) return c.json({ error: "not found" }, 404);

	if (note.needs_relink) {
		try {
			const [vocab, docs] = await Promise.all([
				loadVocab(c.env.DB),
				loadOwnerDocs(c.env.DB, email, "free", id),
			]);
			await computeNoteSuggestions(c.env.DB, email, "free", id, docs, vocab);
		} catch (e) {
			console.warn("free-note links lazy compute failed", id, String(e));
		}
	}

	return c.json({ links: await loadSuggestions(c.env.DB, email, "free", id) });
});
