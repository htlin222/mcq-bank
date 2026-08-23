import { Hono } from "hono";
import type { AppContext } from "../types";
import { readIdemKey, idemLookup, idemRecordOp } from "../lib/idempotency";

export const lectureRoutes = new Hono<AppContext>();

// ── Registry ──────────────────────────────────────────────────────────

// List lecture docs, ordered by sort_order, joined with the caller's own
// annotation/note counts. Defaults to kind='lecture' (複習班講義) so the
// textbook chapters (kind='textbook', migration 0033) don't flood the grid.
// Pass ?kind=textbook to browse the Wintrobe chapters directly — the grid on
// /lectures exposes this as a second tab; the全站選字 popup →
// /api/textbook/lookup remains the other way in.
lectureRoutes.get("/", async (c) => {
	const email = c.var.email;
	const kind = c.req.query("kind") === "textbook" ? "textbook" : "lecture";
	const { results } = await c.env.DB.prepare(
		`SELECT d.*,
        (SELECT COUNT(*) FROM lecture_annotations a WHERE a.slug = d.slug AND a.user_email = ?1) AS anno_count,
        (SELECT COUNT(*) FROM lecture_notes n WHERE n.slug = d.slug AND n.user_email = ?1) AS note_count
       FROM lecture_docs d
       WHERE d.kind = ?2
       ORDER BY d.sort_order`,
	)
		.bind(email, kind)
		.all();

	return c.json(results ?? []);
});

// ── Search ──────────────────────────────────────────────────────────
//
// Full-text search across lecture content (migration 0016). Two scopes:
//
//   scope=pdf    → lecture_pages_fts (shared across users)
//   scope=notes  → lecture_notes_fts filtered by caller email (per-user)
//
// Each result is a (slug, page) match with a snippet. FTS5's snippet()
// wraps matches with char(1)/char(2) markers (instead of <mark>/</mark>)
// so the client can render them as React elements without exposing PDF
// or note text to dangerouslySetInnerHTML — XSS-safe by construction.
// Results are joined back to lecture_docs for title/instructor display.
// Frontend uses (slug, page) to deep-link via /lectures/:slug?page=N.
//
// Declared BEFORE the /:slug route so it isn't swallowed by the param.
lectureRoutes.get("/search", async (c) => {
	const qRaw = (c.req.query("q") ?? "").trim();
	const scope = c.req.query("scope") === "notes" ? "notes" : "pdf";
	const limit = Math.min(
		50,
		Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20),
	);
	// Optional slug filter — used by the in-reader search box on /lectures/:slug
	// to restrict results to the lecture currently being read.
	const slugFilter = (c.req.query("slug") ?? "").trim();
	const hasSlug = slugFilter.length > 0;

	if (qRaw.length === 0) {
		return c.json({ results: [], scope, q: qRaw });
	}

	// FTS5 query sanitisation: strip operator chars and wrap each token as a
	// phrase so user input can't trigger syntax errors or unexpected boolean
	// behaviour. Tokens implicitly AND. Empty → no match → []
	const ftsQuery = qRaw
		.replace(/["()*:]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => '"' + t + '"')
		.join(" ");

	if (ftsQuery.length === 0) {
		return c.json({ results: [], scope, q: qRaw });
	}

	let results: unknown[];
	if (scope === "notes") {
		const email = c.var.email;
		const sql = `SELECT
       n.slug AS slug,
       CAST(n.page AS INTEGER) AS page,
       d.title AS title,
       d.instructor AS instructor,
       snippet(lecture_notes_fts, 3, char(1), char(2), '…', 16) AS snippet
     FROM lecture_notes_fts n
     JOIN lecture_docs d ON d.slug = n.slug
     WHERE lecture_notes_fts MATCH ?1
       AND n.user_email = ?2
       ${hasSlug ? "AND n.slug = ?3" : ""}
     ORDER BY bm25(lecture_notes_fts), d.sort_order, n.page
     LIMIT ${hasSlug ? "?4" : "?3"}`;
		const stmt = c.env.DB.prepare(sql);
		const r = await (hasSlug
			? stmt.bind(ftsQuery, email, slugFilter, limit)
			: stmt.bind(ftsQuery, email, limit)
		).all();
		results = r.results ?? [];
	} else {
		const sql = `SELECT
       p.slug AS slug,
       CAST(p.page AS INTEGER) AS page,
       d.title AS title,
       d.instructor AS instructor,
       snippet(lecture_pages_fts, 2, char(1), char(2), '…', 16) AS snippet
     FROM lecture_pages_fts p
     JOIN lecture_docs d ON d.slug = p.slug
     WHERE lecture_pages_fts MATCH ?1
       ${hasSlug ? "AND p.slug = ?2" : ""}
     ORDER BY bm25(lecture_pages_fts), d.sort_order, p.page
     LIMIT ${hasSlug ? "?3" : "?2"}`;
		const stmt = c.env.DB.prepare(sql);
		const r = await (hasSlug
			? stmt.bind(ftsQuery, slugFilter, limit)
			: stmt.bind(ftsQuery, limit)
		).all();
		results = r.results ?? [];
	}

	return c.json({
		results,
		scope,
		q: qRaw,
		slug: hasSlug ? slugFilter : undefined,
	});
});

// ── 歷屆考題 (past-exam MCQ links) ────────────────────────────────────
//
// One page's worth of MCQs, ranked by the offline pipeline
// (scripts/build-slide-mcq-links.ts, see
// docs/plans/2026-07-23-slide-mcq-links-design.md §5). Pure indexed D1
// lookup — no Workers AI / Vectorize at request time (free-tier §7).
//
// `page` is 1-based (frontend sends currentPage + 1). The join table may
// not exist yet on a fresh migration, or may simply have no rows for this
// (slug, page) — either way this returns [] rather than throwing, so the
// panel just shows its empty state.
//
// Declared BEFORE the /:slug route so it isn't swallowed by the param.
lectureRoutes.get("/:slug/questions", async (c) => {
	const slug = c.req.param("slug");
	const page = parseInt(c.req.query("page") ?? "", 10);
	if (!Number.isFinite(page)) return c.json([]);

	try {
		const { results } = await c.env.DB.prepare(
			`SELECT q.id, q.year, q."group", q.stem, q.options_json, q.answer,
                lpq.score, lpq.rank,
                (SELECT GROUP_CONCAT(tag, ' ') FROM question_tags t WHERE t.question_id = q.id) AS tags
         FROM lecture_page_questions lpq
         JOIN questions q ON q.id = lpq.question_id
         WHERE lpq.slug = ?1 AND lpq.page = ?2
         ORDER BY lpq.rank`,
		)
			.bind(slug, page)
			.all();

		return c.json(results ?? []);
	} catch (err) {
		// Table missing / not yet backfilled — degrade to empty, never 500.
		//
		// 但要留下痕跡:這個 catch 夠寬,連真正的 SQL 錯誤(欄位打錯、join 寫壞)
		// 都會被它吞成一個安靜的空面板。沒有這行,那種 bug 從前端看起來就只是
		// 「這頁沒有相關考題」,永遠不會有人回報。`wrangler tail` 看得到。
		console.error("lecture page questions", c.req.param("slug"), page, err);
		return c.json([]);
	}
});

// ── Bookmarks (per-user page flags, migration 0042) ──────────────────
//
// ⚠️ 這一組必須註冊在 `/:slug` 之前。Hono 依註冊順序比對,`/bookmarks` 放在
// 後面的話會先被 `/:slug` 吃掉,前端拿到的是「找不到這份講義」的 404 ——
// 而那個症狀完全不會指向路由順序。
//
// 頁碼一律 1-based(見 migration 0042 的說明)。

/** 書籤清單共用的投影:講義標題 + 該頁筆記的純文字預覽。
 *
 *  預覽直接在 SQL 裡從 TipTap JSON 走出來(migration 0016 的同一個慣用法:
 *  json_tree → key='text' AND type='text'),不把整份 content_json 送到前端
 *  再走一次 —— 一頁筆記可以有幾十 KB,而卡片只用得到兩行。
 */
const BOOKMARK_SELECT = `
  SELECT b.id, b.slug, b.page, b.created_at,
         d.title, d.instructor, d.sort_order,
         (SELECT COALESCE(
                   (SELECT GROUP_CONCAT(value, ' ')
                      FROM json_tree(n.content_json)
                     WHERE key = 'text' AND type = 'text'),
                   '')
            FROM lecture_notes n
           WHERE n.user_email = b.user_email
             AND n.slug = b.slug
             AND n.page = b.page
           ORDER BY n.updated_at DESC
           LIMIT 1) AS note_preview
    FROM lecture_bookmarks b
    JOIN lecture_docs d ON d.slug = b.slug`;

// 預覽在伺服器端就截斷。卡片只顯示兩行,整頁筆記傳過去是純粹的浪費 ——
// 而這支端點是 /lectures 書籤分頁一進來就打的。
const PREVIEW_MAX = 240;

function shapeBookmark(r: any) {
	const raw = typeof r.note_preview === "string" ? r.note_preview.trim() : "";
	return {
		id: r.id,
		slug: r.slug,
		page: r.page,
		created_at: r.created_at,
		title: r.title,
		instructor: r.instructor ?? "",
		sort_order: r.sort_order,
		note_preview:
			raw.length > PREVIEW_MAX ? raw.slice(0, PREVIEW_MAX) + "…" : raw,
	};
}

// 全部書籤(/lectures?tab=bookmark 的卡片格線)。排序在前端切換(日期 /
// 文件),所以這裡固定回 created_at DESC 並附上 sort_order 讓前端排得出
// 「依文件」那一種。
lectureRoutes.get("/bookmarks", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(`${BOOKMARK_SELECT}
       WHERE b.user_email = ?
       ORDER BY b.created_at DESC
       LIMIT 1000`)
		.bind(email)
		.all<any>();
	return c.json((results ?? []).map(shapeBookmark));
});

// 單一講義的書籤(閱讀器左側 rail)。依頁碼排 —— rail 是拿來當目錄用的,
// 依加入時間排會讓同一份講義的書籤在頁碼上跳來跳去。
lectureRoutes.get("/:slug/bookmarks", async (c) => {
	const email = c.var.email;
	const slug = c.req.param("slug");
	const { results } = await c.env.DB.prepare(`${BOOKMARK_SELECT}
       WHERE b.user_email = ? AND b.slug = ?
       ORDER BY b.page`)
		.bind(email, slug)
		.all<any>();
	return c.json((results ?? []).map(shapeBookmark));
});

// 加書籤。INSERT OR IGNORE + UNIQUE(user_email, slug, page):重送同一頁是
// no-op,所以工具列那顆 toggle 不需要先查再寫(那中間有 race)。
lectureRoutes.post("/:slug/bookmarks", async (c) => {
	const email = c.var.email;
	const slug = c.req.param("slug");
	const body = await c.req
		.json<{ page?: number }>()
		.catch(() => ({}) as { page?: number });
	const page = Number(body.page);

	// 教科書是唯讀參考書,不給加書籤(跟閱讀器的 readOnly 判準一致)。
	// 同一次查詢順便拿 page_count 來夾頁碼 —— 越界的書籤在 rail 上點了跳不動,
	// 而那看起來像 rail 壞掉,不像資料壞掉。
	const doc = await c.env.DB.prepare(
		"SELECT kind, page_count FROM lecture_docs WHERE slug = ?",
	)
		.bind(slug)
		.first<{ kind: string; page_count: number | null }>();
	if (!doc) return c.json({ error: "not found" }, 404);
	if (doc.kind === "textbook")
		return c.json({ error: "read-only document" }, 403);

	const max = doc.page_count ?? Number.MAX_SAFE_INTEGER;
	if (!Number.isInteger(page) || page < 1 || page > max) {
		return c.json({ error: "invalid page" }, 400);
	}

	const id = crypto.randomUUID();
	const now = Date.now();
	await c.env.DB.prepare(
		`INSERT OR IGNORE INTO lecture_bookmarks (id, user_email, slug, page, created_at)
       VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(id, email, slug, page, now)
		.run();

	// 回既有那一列(重送時 id/created_at 是舊的),前端就不必自己猜寫進去的是哪筆。
	const row = await c.env.DB.prepare(`${BOOKMARK_SELECT}
       WHERE b.user_email = ? AND b.slug = ? AND b.page = ?`)
		.bind(email, slug, page)
		.first<any>();
	return c.json(row ? shapeBookmark(row) : { id, slug, page, created_at: now });
});

// 移除。以頁碼定位而不是 id —— 呼叫端(工具列那顆 toggle)手上只有「現在
// 第幾頁」,要它先去清單裡找 id 等於把 race 搬到前端。
lectureRoutes.delete("/:slug/bookmarks/:page", async (c) => {
	const email = c.var.email;
	const slug = c.req.param("slug");
	const page = Number(c.req.param("page"));
	if (!Number.isInteger(page)) return c.json({ error: "invalid page" }, 400);

	await c.env.DB.prepare(
		"DELETE FROM lecture_bookmarks WHERE user_email = ? AND slug = ? AND page = ?",
	)
		.bind(email, slug, page)
		.run();
	return c.json({ ok: true });
});

// Single doc metadata + derived /pdf URL.
lectureRoutes.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	const row = await c.env.DB.prepare(
		"SELECT * FROM lecture_docs WHERE slug = ?",
	)
		.bind(slug)
		.first<{ r2_key: string }>();

	if (!row) return c.json({ error: "not found" }, 404);

	return c.json({ ...row, pdf_url: "/pdf/" + row.r2_key });
});

// ── Annotations (highlights + sticky notes) ──────────────────────────

// All of the caller's annotations for a slug.
lectureRoutes.get("/:slug/annotations", async (c) => {
	const slug = c.req.param("slug");
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM lecture_annotations
       WHERE slug = ? AND user_email = ?
       ORDER BY page, created_at`,
	)
		.bind(slug, email)
		.all<any>();

	const rows = (results ?? []).map((r: any) => ({
		...r,
		payload_json: safeParse(r.payload_json),
	}));
	return c.json(rows);
});

// Create an annotation.
lectureRoutes.post("/:slug/annotations", async (c) => {
	const slug = c.req.param("slug");
	const email = c.var.email;

	// 冪等:重送同一 key 直接 replay,不重複建立註記。
	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		if (hit) return c.json(hit.body as any, hit.status as any);
	}

	const body = await c.req.json<{
		kind: string;
		page: number;
		payload_json: any;
	}>();

	const id = crypto.randomUUID();
	const now = Date.now();
	const payload = JSON.stringify(body.payload_json);

	const responseBody = {
		id,
		user_email: email,
		slug,
		page: body.page,
		kind: body.kind,
		payload_json: body.payload_json,
		created_at: now,
		updated_at: now,
	};
	// 註記 INSERT 與去重列走同一個 batch,原子提交。
	const ops = [
		c.env.DB.prepare(
			`INSERT INTO lecture_annotations
         (id, user_email, slug, page, kind, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(id, email, slug, body.page, body.kind, payload, now, now),
	];
	if (idemKey) {
		ops.push(
			idemRecordOp(c.env.DB, {
				email,
				key: idemKey,
				endpoint: "POST /lectures/:slug/annotations",
				status: 200,
				body: responseBody,
				now,
			}),
		);
	}
	await c.env.DB.batch(ops);

	return c.json(responseBody);
});

// Update an annotation's payload (and page if provided). Ownership-checked.
lectureRoutes.patch("/:slug/annotations/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;
	const body = await c.req.json<{ payload_json?: any; page?: number }>();

	const now = Date.now();
	const sets: string[] = ["updated_at = ?"];
	const binds: any[] = [now];
	if ("payload_json" in body) {
		sets.push("payload_json = ?");
		binds.push(JSON.stringify(body.payload_json));
	}
	if (typeof body.page === "number") {
		sets.push("page = ?");
		binds.push(body.page);
	}
	binds.push(id, email);

	const res = await c.env.DB.prepare(
		`UPDATE lecture_annotations SET ${sets.join(", ")}
       WHERE id = ? AND user_email = ?`,
	)
		.bind(...binds)
		.run();

	if ((res.meta?.changes ?? 0) === 0)
		return c.json({ error: "not found" }, 404);
	return c.json({ ok: true, updated_at: now });
});

// Delete an annotation. Ownership-checked.
lectureRoutes.delete("/:slug/annotations/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;
	const res = await c.env.DB.prepare(
		"DELETE FROM lecture_annotations WHERE id = ? AND user_email = ?",
	)
		.bind(id, email)
		.run();

	if ((res.meta?.changes ?? 0) === 0)
		return c.json({ error: "not found" }, 404);
	return c.json({ ok: true });
});

// ── Notebook (page-anchored TipTap notes) ────────────────────────────

// All of the caller's notes for a slug.
lectureRoutes.get("/:slug/notes", async (c) => {
	const slug = c.req.param("slug");
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM lecture_notes
       WHERE slug = ? AND user_email = ?
       ORDER BY created_at`,
	)
		.bind(slug, email)
		.all<any>();

	const rows = (results ?? []).map((r: any) => ({
		...r,
		content_json: safeParse(r.content_json),
	}));
	return c.json(rows);
});

// Create a note. page may be null (deck-level note).
lectureRoutes.post("/:slug/notes", async (c) => {
	const slug = c.req.param("slug");
	const email = c.var.email;

	// 冪等:重送同一 key 直接 replay,不重複建立筆記。
	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		if (hit) return c.json(hit.body as any, hit.status as any);
	}

	const body = await c.req.json<{ page: number | null; content_json: any }>();

	const id = crypto.randomUUID();
	const now = Date.now();
	const content = JSON.stringify(body.content_json);
	const page = body.page ?? null;

	const responseBody = {
		id,
		user_email: email,
		slug,
		page,
		content_json: body.content_json,
		created_at: now,
		updated_at: now,
	};
	// 筆記 INSERT 與去重列走同一個 batch,原子提交。
	const ops = [
		c.env.DB.prepare(
			`INSERT INTO lecture_notes
         (id, user_email, slug, page, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(id, email, slug, page, content, now, now),
	];
	if (idemKey) {
		ops.push(
			idemRecordOp(c.env.DB, {
				email,
				key: idemKey,
				endpoint: "POST /lectures/:slug/notes",
				status: 200,
				body: responseBody,
				now,
			}),
		);
	}
	await c.env.DB.batch(ops);

	return c.json(responseBody);
});

// Upsert exactly one note for (user, slug, page). No DB unique constraint
// exists, so this is an app-level read-then-write.
lectureRoutes.put("/:slug/notes/by-page/:page", async (c) => {
	const slug = c.req.param("slug");
	const page = Number(c.req.param("page"));
	const email = c.var.email;
	const { content_json } = await c.req.json<{ content_json: any }>();

	const now = Date.now();
	const content = JSON.stringify(content_json);

	const existing = await c.env.DB.prepare(
		"SELECT id, created_at FROM lecture_notes WHERE user_email = ? AND slug = ? AND page = ?",
	)
		.bind(email, slug, page)
		.first<{ id: string; created_at: number }>();

	if (existing) {
		await c.env.DB.prepare(
			"UPDATE lecture_notes SET content_json = ?, updated_at = ? WHERE id = ?",
		)
			.bind(content, now, existing.id)
			.run();
		return c.json({
			id: existing.id,
			user_email: email,
			slug,
			page,
			content_json,
			created_at: existing.created_at,
			updated_at: now,
		});
	}

	const id = crypto.randomUUID();
	await c.env.DB.prepare(
		`INSERT INTO lecture_notes
         (id, user_email, slug, page, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, email, slug, page, content, now, now)
		.run();

	return c.json({
		id,
		user_email: email,
		slug,
		page,
		content_json,
		created_at: now,
		updated_at: now,
	});
});

// Update a note's content (and page if provided). Ownership-checked.
lectureRoutes.patch("/:slug/notes/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;
	const body = await c.req.json<{ content_json?: any; page?: number | null }>();

	const now = Date.now();
	const sets: string[] = ["content_json = ?", "updated_at = ?"];
	const binds: any[] = [JSON.stringify(body.content_json), now];
	if ("page" in body) {
		sets.push("page = ?");
		binds.push(body.page ?? null);
	}
	binds.push(id, email);

	const res = await c.env.DB.prepare(
		`UPDATE lecture_notes SET ${sets.join(", ")}
       WHERE id = ? AND user_email = ?`,
	)
		.bind(...binds)
		.run();

	if ((res.meta?.changes ?? 0) === 0)
		return c.json({ error: "not found" }, 404);
	return c.json({ ok: true, updated_at: now });
});

// Delete a note. Ownership-checked.
lectureRoutes.delete("/:slug/notes/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;
	const res = await c.env.DB.prepare(
		"DELETE FROM lecture_notes WHERE id = ? AND user_email = ?",
	)
		.bind(id, email)
		.run();

	if ((res.meta?.changes ?? 0) === 0)
		return c.json({ error: "not found" }, 404);
	return c.json({ ok: true });
});

function safeParse(raw: unknown): any {
	if (typeof raw !== "string") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
