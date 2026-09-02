import { Hono } from "hono";
import type { AppContext } from "../types";
import { apiKeyMiddleware } from "../lib/apikey";
import { sanitizeNoteDoc, externalImages } from "../lib/note-doc";
import { sideloadImageToR2 } from "../lib/sideload";
import { MAX_NOTES_PER_QUESTION, resolveNoteSlot } from "../lib/notes";
import { readIdemKey, idemLookup, idemRecordOp } from "../lib/idempotency";
import { ftsQuery } from "./search";

export const mcqRoutes = new Hono<AppContext>();

// Own API-key auth — this router is registered before the Access middleware
// in index.ts, so it never inherits Access gating.
mcqRoutes.use("*", apiKeyMiddleware);

// GET /api/mcq/search?q=CML — keyword lookup for the /mcq skill, so a user can
// find a question by topic instead of remembering its 年-題號. Registered
// BEFORE `/:id` (which would otherwise swallow "search" as an id). Returns only
// id / 年-題號 / group / snippet — never the answer, so the skill's answer-reveal
// flow stays intact. Same FTS behaviour as /api/search: ASCII tokens become
// prefix matches AND'd together, so short abbreviations (CML, CMV, AML) hit far
// more reliably than spelled-out disease names.
mcqRoutes.get("/search", async (c) => {
	const q = (c.req.query("q") || "").trim();
	const year = c.req.query("year");
	const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);
	if (!q) return c.json({ items: [], q });

	const params: any[] = [ftsQuery(q)];
	let yearSql = "";
	if (year) {
		yearSql = "AND q.year = ?";
		params.push(parseInt(year));
	}
	params.push(limit);

	try {
		const { results } = await c.env.DB.prepare(
			`SELECT q.id, q.year, q.number, q."group",
              snippet(questions_fts, 1, '<<', '>>', '…', 16) AS snippet
         FROM questions q
         JOIN questions_fts f ON f.rowid = q.rowid
        WHERE questions_fts MATCH ? ${yearSql}
        ORDER BY bm25(questions_fts) ASC, q.year DESC, q.number ASC
        LIMIT ?`,
		)
			.bind(...params)
			.all();
		return c.json({ items: results, q });
	} catch (e) {
		console.warn("mcq search failed:", String(e));
		return c.json({ error: "search failed", q }, 400);
	}
});

// ── 其他筆記(自由筆記)────────────────────────────────────────────────
//
// 不掛在任何題目上的私人筆記(free_notes,見 CLAUDE.md「其他筆記」那節)。
// 網頁端走 /api/free-notes(Access session);這裡是 .skill 的 API-key 入口,
// 讓終端也能讀寫同一批筆記。
//
// ⚠️ 這兩條**必須註冊在 `/:id` 之前** —— Hono 依註冊順序比對,放在後面的話
// `GET /free-notes` 會被當成題號 "free-notes" 吞掉,回的是「查無此題」,
// 完全不會指向路由順序。同 CLAUDE.md 講義書籤那節的 `/bookmarks` vs `/:slug`。

/** 與 worker/routes/free-notes.ts 對齊 —— 兩邊寫同一張表,上限要一致。 */
const MAX_FREE_NOTES = 500;
const FREE_TITLE_MAX = 200;

/** 從 TipTap doc 取前幾十個字當摘要,列表用。 */
function freeExcerpt(contentJson: string, max = 120): string {
	try {
		const md = tiptapToMarkdown(JSON.parse(contentJson));
		const t = md
			.replace(/[#*`>\-]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return t.length > max ? `${t.slice(0, max)}…` : t;
	} catch {
		return "";
	}
}

// GET /api/mcq/free-notes — 列出這個人的其他筆記(不含全文)。
// `short` 是 id 的前 8 碼:終端要打的是它,不是整串 UUID。
mcqRoutes.get("/free-notes", async (c) => {
	const email = c.get("email");
	const { results } = await c.env.DB.prepare(
		`SELECT id, title, content_json, updated_at
       FROM free_notes WHERE user_email = ?
      ORDER BY updated_at DESC`,
	)
		.bind(email)
		.all<{
			id: string;
			title: string;
			content_json: string;
			updated_at: number;
		}>();
	const items = (results ?? []).map((r) => ({
		id: r.id,
		short: r.id.slice(0, 8),
		title: r.title,
		excerpt: freeExcerpt(r.content_json),
		updated_at: r.updated_at,
	}));
	return c.json({ items, count: items.length, max: MAX_FREE_NOTES });
});

// GET /api/mcq/free-notes/:ref — 單則全文(markdown)。ref 可以是完整 id 或前綴。
mcqRoutes.get("/free-notes/:ref", async (c) => {
	const email = c.get("email");
	const found = await resolveFreeNote(c.env.DB, email, c.req.param("ref"));
	if ("error" in found) return c.json(found.error, found.status as any);
	return c.json({
		id: found.row.id,
		short: found.row.id.slice(0, 8),
		title: found.row.title,
		updated_at: found.row.updated_at,
		note_markdown: tiptapToMarkdown(JSON.parse(found.row.content_json)),
	});
});

type FreeRow = {
	id: string;
	title: string;
	content_json: string;
	updated_at: number;
};

/** ref → 一則筆記。接受完整 id 或**唯一**前綴;前綴撞號時寧可報錯也不猜。 */
async function resolveFreeNote(
	DB: AppContext["Bindings"]["DB"],
	email: string,
	ref: string,
): Promise<{ row: FreeRow } | { error: object; status: number }> {
	const r = (ref || "").trim();
	if (!r) return { error: { error: "note ref required" }, status: 400 };
	const { results } = await DB.prepare(
		`SELECT id, title, content_json, updated_at FROM free_notes
      WHERE user_email = ? AND (id = ? OR id LIKE ?) LIMIT 5`,
	)
		.bind(email, r, `${r}%`)
		.all<FreeRow>();
	const rows = results ?? [];
	const exact = rows.find((x) => x.id === r);
	if (exact) return { row: exact };
	if (rows.length === 0)
		return { error: { error: "free note not found", ref: r }, status: 404 };
	if (rows.length > 1)
		return {
			error: {
				error: "ambiguous note ref",
				ref: r,
				matches: rows.map((x) => ({ short: x.id.slice(0, 8), title: x.title })),
			},
			status: 409,
		};
	return { row: rows[0] };
}

// PUT /api/mcq/free-notes — 寫入。body:
//   { markdown | doc, mode?: 'append'|'replace', id?: '<id|前綴>'|'new', title?: string }
// 不給 id 就是 'new'(另開一則)—— 預設不去動既有筆記,因為終端沒有「選哪一則」
// 的介面,猜錯的代價是把內容灌進不相干的筆記裡。
mcqRoutes.put("/free-notes", async (c) => {
	const email = c.get("email");

	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		if (hit)
			return c.json(
				{ ...(hit.body as object), replayed: true } as any,
				hit.status as any,
			);
	}

	let body: {
		markdown?: unknown;
		doc?: unknown;
		mode?: unknown;
		id?: unknown;
		title?: unknown;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}
	const markdown =
		typeof body.markdown === "string" ? body.markdown.trim() : "";
	const mode = body.mode === "replace" ? "replace" : "append";
	const title =
		typeof body.title === "string"
			? body.title.slice(0, FREE_TITLE_MAX)
			: undefined;
	const ref =
		body.id === undefined || body.id === null ? "new" : String(body.id);

	if (!markdown && !body.doc)
		return c.json({ error: "markdown or doc required" }, 400);
	if (markdown.length > NOTE_MAX_CHARS)
		return c.json(
			{ error: `markdown too long (max ${NOTE_MAX_CHARS} chars)` },
			400,
		);

	const warnings: string[] = [];
	let newBlocks: PMNode[];
	if (body.doc) {
		if (JSON.stringify(body.doc).length > NOTE_DOC_MAX_JSON)
			return c.json(
				{ error: `doc too large (max ${NOTE_DOC_MAX_JSON} JSON chars)` },
				400,
			);
		const sanitized = sanitizeNoteDoc(body.doc);
		if (!sanitized.ok) return c.json({ error: sanitized.error }, 400);
		if (sanitized.dropped.length)
			warnings.push(
				`dropped unsupported nodes: ${sanitized.dropped.join(", ")}`,
			);
		const pending = externalImages(sanitized.images);
		if (pending.length > MAX_SIDELOAD_IMAGES)
			warnings.push(
				`only first ${MAX_SIDELOAD_IMAGES} of ${pending.length} external images sideloaded`,
			);
		for (const img of pending.slice(0, MAX_SIDELOAD_IMAGES)) {
			const src = String(img.attrs!.src);
			const result = await sideloadImageToR2(c.env, src, email);
			if (result.ok) img.attrs!.src = result.url;
			else
				warnings.push(
					`image kept as hotlink (${result.error}): ${src.slice(0, 120)}`,
				);
		}
		newBlocks = sanitized.doc.content ?? [];
	} else {
		newBlocks = markdownToTiptap(markdown).content ?? [];
	}

	const now = Date.now();
	let row: FreeRow | null = null;
	if (ref !== "new") {
		const found = await resolveFreeNote(c.env.DB, email, ref);
		if ("error" in found) return c.json(found.error, found.status as any);
		row = found.row;
	}

	let outId: string;
	let outTitle: string;
	let previousMarkdown: string | undefined;
	let action: "create" | "append" | "replace";
	let finalDoc: PMNode;
	let write: ReturnType<ReturnType<typeof c.env.DB.prepare>["bind"]>;

	if (!row) {
		const cnt = await c.env.DB.prepare(
			"SELECT COUNT(*) AS n FROM free_notes WHERE user_email = ?",
		)
			.bind(email)
			.first<{ n: number }>();
		if ((cnt?.n ?? 0) >= MAX_FREE_NOTES)
			return c.json({ error: "too many notes", max: MAX_FREE_NOTES }, 409);
		outId = crypto.randomUUID();
		// 沒給標題就從內文第一行取 —— 一則沒有標題的筆記在列表上認不出來,
		// 而終端這端沒有「回頭補標題」的自然時機。
		outTitle =
			title ??
			(
				tiptapToMarkdown({ type: "doc", content: newBlocks })
					.split("\n")
					.map((l) => l.replace(/^#+\s*/, "").trim())
					.find((l) => l.length > 0) || "未命名筆記"
			).slice(0, FREE_TITLE_MAX);
		action = "create";
		finalDoc = { type: "doc", content: newBlocks };
		write = c.env.DB.prepare(
			`INSERT INTO free_notes (id, user_email, title, content_json, created_at, updated_at, needs_relink)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
		).bind(outId, email, outTitle, JSON.stringify(finalDoc), now, now);
	} else {
		outId = row.id;
		outTitle = title ?? row.title;
		const old = JSON.parse(row.content_json) as PMNode;
		if (mode === "replace") {
			previousMarkdown = tiptapToMarkdown(old);
			action = "replace";
		} else {
			action = "append";
		}
		finalDoc = {
			type: "doc",
			content:
				mode === "replace" ? newBlocks : [...(old.content ?? []), ...newBlocks],
		};
		write = c.env.DB.prepare(
			`UPDATE free_notes SET title = ?, content_json = ?, updated_at = ?, needs_relink = 1
        WHERE id = ? AND user_email = ?`,
		).bind(outTitle, JSON.stringify(finalDoc), now, outId, email);
	}

	const payload = {
		ok: true,
		id: outId,
		short: outId.slice(0, 8),
		title: outTitle,
		mode: action,
		warnings,
		...(previousMarkdown ? { previous_markdown: previousMarkdown } : {}),
		note_markdown: tiptapToMarkdown(finalDoc),
	};

	// 寫入與去重紀錄一起送 —— 分開送的話中途失敗會留下「寫了但沒記」的狀態,
	// 重跑就會再 append 一次。同 personal_notes 那條的作法。
	const ops = [write];
	if (idemKey)
		ops.push(
			idemRecordOp(c.env.DB, {
				email,
				key: idemKey,
				endpoint: "PUT /mcq/free-notes",
				status: 200,
				body: payload,
				now,
			}),
		);
	await c.env.DB.batch(ops);

	return c.json(payload);
});

// GET /api/mcq/:id — read-only single question with parsed options, answer,
// and the collaborative explanation rendered to markdown. `id` is the primary
// key, e.g. "114-001" (民國 year + 3-digit number).
mcqRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");

	const q = await c.env.DB.prepare(
		`SELECT id, year, number, "group", stem, options_json, answer, difficulty, source
       FROM questions WHERE id = ?`,
	)
		.bind(id)
		.first<{
			id: string;
			year: number;
			number: number;
			group: string | null;
			stem: string;
			options_json: string;
			answer: string;
			difficulty: number | null;
			source: string | null;
		}>();
	if (!q) return c.json({ error: "question not found", id }, 404);

	const exp = await c.env.DB.prepare(
		`SELECT content_json, version, updated_by, updated_at
       FROM explanations WHERE question_id = ?`,
	)
		.bind(id)
		.first<{
			content_json: string;
			version: number;
			updated_by: string | null;
			updated_at: number;
		}>();

	// Personal notes of the *authenticated* caller only — the email comes from
	// apiKeyMiddleware (HMAC-verified), never straight from the header, so one
	// member can never read another member's notes through this endpoint.
	// 一題可以有多則筆記(migration 0036),全部回傳並各自附上 slot,終端才看得
	// 到使用者在網頁上分則寫的東西。`personal_note` 保留成第一則:0.7.x 以前
	// 下載的 .skill 還在使用者機器上跑,它只認得那一個欄位。
	const { results: noteRows } = await c.env.DB.prepare(
		`SELECT slot, content_json, created_at, updated_at
       FROM personal_notes WHERE user_email = ? AND question_id = ? ORDER BY slot`,
	)
		.bind(c.get("email"), id)
		.all<{
			slot: number;
			content_json: string;
			created_at: number;
			updated_at: number;
		}>();

	const notes = (noteRows ?? []).map((n) => {
		const markdown = tiptapToMarkdown(JSON.parse(n.content_json));
		return {
			slot: n.slot,
			title: noteTitle(markdown),
			markdown,
			created_at: n.created_at,
			updated_at: n.updated_at,
		};
	});

	return c.json({
		id: q.id,
		year: q.year,
		number: q.number,
		group: q.group,
		difficulty: q.difficulty,
		source: q.source,
		stem: q.stem,
		options: JSON.parse(q.options_json) as Array<{ key: string; text: string }>,
		answer: q.answer,
		explanation: exp
			? {
					markdown: tiptapToMarkdown(JSON.parse(exp.content_json)),
					version: exp.version,
					updated_by: exp.updated_by,
					updated_at: exp.updated_at,
				}
			: null,
		personal_note: notes[0] ?? null,
		personal_notes: notes,
	});
});

// PUT /api/mcq/:id/note — write the *caller's own* personal note. Default is
// append (existing rich content from the web editor is preserved verbatim,
// new blocks go after a horizontal rule); `mode: "replace"` swaps the whole
// doc and echoes the previous content back so it survives in the terminal.
//
// `slot` picks which of the question's notes to write:
//   • 省略      — 第一則(最小的既存 slot);一則都沒有就建 slot 0。這是
//                0.7.x 的 .skill 與 enrich-note 批次腳本的行為,不能變。
//   • 數字      — 指定那一則,必須已經存在。不存在就回 404 並附上現有號碼,
//                而不是在中間開一個洞 —— 畫記與挖空快取都以 slot 定位。
//   • "new"     — 新開一則(號碼取現有最大值 +1,不重用刪掉的號碼)。
//
// Content comes as ONE of:
//   • `markdown` — plain markdown, converted with markdownToTiptap below
//   • `doc`      — a TipTap document the skill built from HTML (--html /
//                  --oe-url). Sanitized to the web editor's node set
//                  (lib/note-doc.ts); external images are sideloaded to R2
//                  so notes don't depend on expiring hotlinks.
const NOTE_MAX_CHARS = 32_000;
const NOTE_DOC_MAX_JSON = 400_000; // sanity cap for the raw doc payload
const MAX_SIDELOAD_IMAGES = 12;

mcqRoutes.put("/:id/note", async (c) => {
	const id = c.req.param("id");
	const email = c.get("email");

	// 冪等:重送同一 key 直接 replay。
	//
	// 這是這條路由最需要它的地方 —— 預設 mode 是 append,不是覆寫:同一份內容
	// 送兩次會在筆記裡多出一份(slot:"new" 則是多出一則)。而終端這端沒有自動
	// 重試,真正的破口是「client 逾時、Worker 其實寫成功了」之後由人手動重跑。
	//
	// 查在 body 解析與圖片 sideload 之前:replay 不該再把 12 張圖重傳一次 R2。
	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		// `replayed` 只在回應上加,不進去重表 —— 呼叫端據此說「這次沒有再寫一次」,
		// 否則一模一樣的成功訊息會讓人以為又append了一份。
		if (hit)
			return c.json(
				{ ...(hit.body as object), replayed: true } as any,
				hit.status as any,
			);
	}

	let body: {
		markdown?: unknown;
		doc?: unknown;
		mode?: unknown;
		slot?: unknown;
	};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}
	const markdown =
		typeof body.markdown === "string" ? body.markdown.trim() : "";
	const mode = body.mode === "replace" ? "replace" : "append";

	// 這裡不用 lib/notes 的 parseSlot():它把看不懂的值收斂成 0,對網頁那種
	// 「使用者按下拉選單」的來源是對的,但終端是手打的 —— 打錯號碼就把內容
	// 靜靜灌進別則筆記,比直接報錯糟糕得多。
	const wantsNew = body.slot === "new";
	let askedSlot: number | null = null;
	if (!wantsNew && body.slot !== undefined && body.slot !== null) {
		const n = typeof body.slot === "number" ? body.slot : Number(body.slot);
		if (!Number.isInteger(n) || n < 0 || n >= MAX_NOTES_PER_QUESTION)
			return c.json(
				{
					error: `slot must be an integer 0–${MAX_NOTES_PER_QUESTION - 1}, or "new"`,
				},
				400,
			);
		askedSlot = n;
	}
	if (!markdown && !body.doc)
		return c.json({ error: "markdown or doc required" }, 400);
	if (markdown.length > NOTE_MAX_CHARS)
		return c.json(
			{ error: `markdown too long (max ${NOTE_MAX_CHARS} chars)` },
			400,
		);

	const warnings: string[] = [];
	let newBlocks: PMNode[];
	if (body.doc) {
		if (JSON.stringify(body.doc).length > NOTE_DOC_MAX_JSON)
			return c.json(
				{ error: `doc too large (max ${NOTE_DOC_MAX_JSON} JSON chars)` },
				400,
			);
		const sanitized = sanitizeNoteDoc(body.doc);
		if (!sanitized.ok) return c.json({ error: sanitized.error }, 400);
		if (sanitized.dropped.length)
			warnings.push(
				`dropped unsupported nodes: ${sanitized.dropped.join(", ")}`,
			);

		// Persist hotlinked figures into R2 — mutates the image nodes in place.
		const pending = externalImages(sanitized.images);
		if (pending.length > MAX_SIDELOAD_IMAGES)
			warnings.push(
				`only first ${MAX_SIDELOAD_IMAGES} of ${pending.length} external images sideloaded`,
			);
		for (const img of pending.slice(0, MAX_SIDELOAD_IMAGES)) {
			const src = String(img.attrs!.src);
			const result = await sideloadImageToR2(c.env, src, email);
			if (result.ok) img.attrs!.src = result.url;
			else
				warnings.push(
					`image kept as hotlink (${result.error}): ${src.slice(0, 120)}`,
				);
		}
		newBlocks = sanitized.doc.content ?? [];
	} else {
		newBlocks = markdownToTiptap(markdown).content ?? [];
	}

	const exists = await c.env.DB.prepare("SELECT id FROM questions WHERE id = ?")
		.bind(id)
		.first();
	if (!exists) return c.json({ error: "question not found", id }, 404);

	const { results: existing } = await c.env.DB.prepare(
		`SELECT slot, content_json FROM personal_notes
      WHERE user_email = ? AND question_id = ? ORDER BY slot`,
	)
		.bind(email, id)
		.all<{ slot: number; content_json: string }>();
	const rows = existing ?? [];
	const pick = resolveNoteSlot(
		rows.map((r) => r.slot),
		wantsNew ? "new" : askedSlot,
	);
	if (!pick.ok)
		return c.json(
			{
				error: pick.error,
				slots: pick.slots,
				max: MAX_NOTES_PER_QUESTION,
				...(pick.status === 404 ? { hint: 'use slot:"new" to add one' } : {}),
			},
			pick.status,
		);
	const slot = pick.slot;

	const prev = pick.isNew ? undefined : rows.find((r) => r.slot === slot);
	let doc: PMNode;
	if (mode === "append" && prev) {
		const prevDoc = JSON.parse(prev.content_json) as PMNode;
		doc = {
			type: "doc",
			content: [
				...(prevDoc.content ?? []),
				{ type: "horizontalRule" },
				...newBlocks,
			],
		};
	} else {
		doc = { type: "doc", content: newBlocks };
	}

	const now = Date.now();
	const note_markdown = tiptapToMarkdown(doc);
	// Payload 在寫入前就算完,去重列才能和筆記同進同退(同一個 batch)。
	const payload = {
		ok: true,
		mode: prev ? mode : "create",
		slot,
		title: noteTitle(note_markdown),
		notes_count: prev ? rows.length : rows.length + 1,
		updated_at: now,
		note_markdown,
		previous_markdown:
			mode === "replace" && prev
				? tiptapToMarkdown(JSON.parse(prev.content_json))
				: null,
		...(warnings.length ? { warnings } : {}),
	};

	const ops = [
		c.env.DB.prepare(
			`INSERT INTO personal_notes (user_email, question_id, slot, content_json, created_at, updated_at, needs_relink)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_email, question_id, slot) DO UPDATE SET
         content_json = excluded.content_json,
         updated_at   = excluded.updated_at,
         needs_relink = 1`,
		).bind(email, id, slot, JSON.stringify(doc), now, now),
	];
	if (idemKey) {
		ops.push(
			idemRecordOp(c.env.DB, {
				email,
				key: idemKey,
				endpoint: "PUT /mcq/:id/note",
				status: 200,
				body: payload,
				now,
			}),
		);
	}
	await c.env.DB.batch(ops);

	return c.json(payload);
});

// 筆記的名字就是內文第一行 —— 沒有 title 欄位,網頁的切換下拉也是這樣取名的
// (frontend/src/lib/noteTitle.ts)。這裡從已經轉好的 markdown 取,省得再走一次
// TipTap 樹;結果對齊網頁,使用者在終端看到的名字就是他在下拉裡選的那個。
const NOTE_TITLE_MAX = 40;

function noteTitle(markdown: string, fallback = "未命名筆記"): string {
	const line = markdown
		.split("\n")
		.map((s) => s.trim())
		.find(Boolean);
	if (!line) return fallback;
	if (/^!\[/.test(line)) return "［圖片］";
	const plain = line
		.replace(/^#{1,6}\s*/, "")
		.replace(/^[-*+]\s+/, "")
		.replace(/^>\s*/, "")
		.replace(/[*`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!plain) return fallback;
	return plain.length > NOTE_TITLE_MAX
		? `${plain.slice(0, NOTE_TITLE_MAX)}…`
		: plain;
}

// --- TipTap / ProseMirror JSON → markdown-ish plain text -------------------
type PMNode = {
	type?: string;
	text?: string;
	attrs?: Record<string, any>;
	marks?: Array<{ type: string; attrs?: Record<string, any> }>;
	content?: PMNode[];
};

// --- markdown → TipTap JSON (write path) -----------------------------------
// Only emits node types in the frontend's StarterKit set (paragraph, heading,
// lists, blockquote, codeBlock, horizontalRule) plus bold/italic/code marks,
// so the web editor can always open what the skill writes. Anything fancier
// in the input just survives as literal text.

function parseInline(text: string): PMNode[] {
	const nodes: PMNode[] = [];
	// **bold** / *italic* / `code`; unmatched markers fall through as text.
	const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
	let last = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		if (m.index > last)
			nodes.push({ type: "text", text: text.slice(last, m.index) });
		if (m[2] !== undefined)
			nodes.push({ type: "text", text: m[2], marks: [{ type: "bold" }] });
		else if (m[3] !== undefined)
			nodes.push({ type: "text", text: m[3], marks: [{ type: "italic" }] });
		else nodes.push({ type: "text", text: m[4], marks: [{ type: "code" }] });
		last = m.index + m[0].length;
	}
	if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
	return nodes;
}

function paragraph(lines: string[]): PMNode {
	const content: PMNode[] = [];
	lines.forEach((line, i) => {
		if (i > 0) content.push({ type: "hardBreak" });
		content.push(...parseInline(line));
	});
	return { type: "paragraph", content };
}

function markdownToTiptap(md: string): PMNode {
	const blocks: PMNode[] = [];
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	let i = 0;
	let para: string[] = [];
	const flushPara = () => {
		if (para.length) blocks.push(paragraph(para));
		para = [];
	};

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (!trimmed) {
			flushPara();
			i++;
			continue;
		}
		if (trimmed.startsWith("```")) {
			flushPara();
			const code: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith("```"))
				code.push(lines[i++]);
			i++; // closing fence (or EOF)
			blocks.push({
				type: "codeBlock",
				content: code.length ? [{ type: "text", text: code.join("\n") }] : [],
			});
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			flushPara();
			blocks.push({
				type: "heading",
				attrs: { level: heading[1].length },
				content: parseInline(heading[2]),
			});
			i++;
			continue;
		}
		if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
			flushPara();
			blocks.push({ type: "horizontalRule" });
			i++;
			continue;
		}
		const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
		const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
		if (bullet || ordered) {
			flushPara();
			const listType = bullet ? "bulletList" : "orderedList";
			const itemRe = bullet ? /^[-*+]\s+(.*)$/ : /^\d+[.)]\s+(.*)$/;
			const items: PMNode[] = [];
			while (i < lines.length) {
				const m = itemRe.exec(lines[i].trim());
				if (!m) break;
				items.push({ type: "listItem", content: [paragraph([m[1]])] });
				i++;
			}
			blocks.push({ type: listType, content: items });
			continue;
		}
		if (trimmed.startsWith("> ")) {
			flushPara();
			const quoted: string[] = [];
			while (i < lines.length && lines[i].trim().startsWith("> "))
				quoted.push(lines[i++].trim().slice(2));
			blocks.push({ type: "blockquote", content: [paragraph(quoted)] });
			continue;
		}
		para.push(trimmed);
		i++;
	}
	flushPara();
	if (!blocks.length) blocks.push(paragraph([""]));
	return { type: "doc", content: blocks };
}

function tiptapToMarkdown(doc: PMNode): string {
	const walk = (n: PMNode | undefined): string => {
		if (!n) return "";
		const kids = (n.content ?? []).map(walk).join("");
		switch (n.type) {
			case "doc":
				return kids;
			case "paragraph":
				return kids + "\n\n";
			case "text":
				return n.text ?? "";
			case "heading":
				return "#".repeat(n.attrs?.level ?? 1) + " " + kids + "\n\n";
			case "bulletList":
			case "orderedList":
				return kids + "\n";
			case "listItem":
				return "- " + kids.trim() + "\n";
			case "hardBreak":
				return "\n";
			case "blockquote":
				return "> " + kids.trim() + "\n\n";
			case "codeBlock":
				return "```\n" + kids + "\n```\n\n";
			case "image":
				return `![](${n.attrs?.src ?? ""})\n`;
			case "mention":
				return "@" + (n.attrs?.label ?? n.attrs?.id ?? "");
			default:
				return kids;
		}
	};
	return walk(doc)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
