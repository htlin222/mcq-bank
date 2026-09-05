import { Hono } from "hono";
import type { AppContext } from "../types";
import { uuid } from "../lib/db";
import { isAdminEmail } from "../lib/admin";
import { normalizeTerm } from "../lib/smear-grade";
import { validateImageFile, type UploadedFile } from "../lib/upload-validate";

// 抹片練習的社群功能:收藏 / 個人筆記 / 討論 / 投稿。掛在 /api/smear 下,
// 跟 routes/smear.ts、routes/smear-terms.ts 分成三個檔案純粹是行數考量,
// 路徑不重疊,三個 Hono router 掛同一個 prefix 不會互相干擾。
//
// 四個功能全部掛 dx_id,不掛 question_id —— 同整個抹片功能的組織方式:
// 使用者研究的是「這個診斷」,不是某一張特定的圖(migrations/0044 開頭
// 的註解重述過一次同樣的理由)。
export const smearCommunityRoutes = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// 收藏診斷 —— 扁平 toggle,沒有資料夾(比全套 MCQ 收藏系統簡單)。
// ---------------------------------------------------------------------------

smearCommunityRoutes.post("/dx/:id/bookmark", async (c) => {
	const dxId = c.req.param("id");
	const email = c.var.email;

	const dx = await c.env.DB.prepare("SELECT id FROM smear_dx WHERE id = ?")
		.bind(dxId)
		.first<{ id: string }>();
	if (!dx) return c.json({ error: "dx not found" }, 404);

	await c.env.DB.prepare(
		"INSERT OR IGNORE INTO smear_dx_bookmarks (user_email, dx_id, created_at) VALUES (?, ?, ?)",
	)
		.bind(email, dxId, Date.now())
		.run();
	return c.json({ ok: true, bookmarked: true });
});

smearCommunityRoutes.delete("/dx/:id/bookmark", async (c) => {
	const dxId = c.req.param("id");
	const email = c.var.email;

	await c.env.DB.prepare(
		"DELETE FROM smear_dx_bookmarks WHERE user_email = ? AND dx_id = ?",
	)
		.bind(email, dxId)
		.run();
	return c.json({ ok: true, bookmarked: false });
});

smearCommunityRoutes.get("/bookmarks", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT b.dx_id, b.created_at, sd.canonical_long, sd.canonical_abbrev, sd.topic, sd.qtype
       FROM smear_dx_bookmarks b
       JOIN smear_dx sd ON sd.id = b.dx_id
      WHERE b.user_email = ?
      ORDER BY b.created_at DESC`,
	)
		.bind(email)
		.all();
	return c.json({ items: results ?? [] });
});

// ---------------------------------------------------------------------------
// 個人筆記 —— 一使用者一診斷可有多則,私有(僅自己看得到,僅自己能改)。
// v1 刻意不做拖曳排序:純附加順序(sort_order 遞增),編輯/刪除即可,
// 之後真的需要排序時再照 personal_notes 的 sort_order 模式加。
// ---------------------------------------------------------------------------

smearCommunityRoutes.get("/dx/:id/notes", async (c) => {
	const dxId = c.req.param("id");
	const email = c.var.email;

	const { results } = await c.env.DB.prepare(
		`SELECT id, dx_id, content_json, sort_order, created_at, updated_at
       FROM smear_notes
      WHERE user_email = ? AND dx_id = ?
      ORDER BY sort_order ASC`,
	)
		.bind(email, dxId)
		.all();
	return c.json({ items: results ?? [] });
});

smearCommunityRoutes.post("/dx/:id/notes", async (c) => {
	const dxId = c.req.param("id");
	const email = c.var.email;

	const dx = await c.env.DB.prepare("SELECT id FROM smear_dx WHERE id = ?")
		.bind(dxId)
		.first<{ id: string }>();
	if (!dx) return c.json({ error: "dx not found" }, 404);

	const body = await c.req
		.json<{ content_json?: unknown }>()
		.catch(() => ({}) as Record<string, never>);
	if (body.content_json === undefined || body.content_json === null) {
		return c.json({ error: "content_json is required" }, 400);
	}

	const maxRow = await c.env.DB.prepare(
		"SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM smear_notes WHERE user_email = ? AND dx_id = ?",
	)
		.bind(email, dxId)
		.first<{ max_sort: number }>();
	const sortOrder = (maxRow?.max_sort ?? -1) + 1;

	const id = uuid();
	const now = Date.now();
	const contentStr = JSON.stringify(body.content_json);

	await c.env.DB.prepare(
		`INSERT INTO smear_notes (id, user_email, dx_id, content_json, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, email, dxId, contentStr, sortOrder, now, now)
		.run();

	return c.json(
		{
			id,
			dx_id: dxId,
			content_json: contentStr,
			sort_order: sortOrder,
			created_at: now,
			updated_at: now,
		},
		201,
	);
});

smearCommunityRoutes.put("/notes/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;

	const existing = await c.env.DB.prepare(
		"SELECT user_email FROM smear_notes WHERE id = ?",
	)
		.bind(id)
		.first<{ user_email: string }>();
	if (!existing) return c.json({ error: "not found" }, 404);
	if (existing.user_email !== email) return c.json({ error: "forbidden" }, 403);

	const body = await c.req
		.json<{ content_json?: unknown }>()
		.catch(() => ({}) as Record<string, never>);
	if (body.content_json === undefined || body.content_json === null) {
		return c.json({ error: "content_json is required" }, 400);
	}

	const now = Date.now();
	const contentStr = JSON.stringify(body.content_json);
	await c.env.DB.prepare(
		"UPDATE smear_notes SET content_json = ?, updated_at = ? WHERE id = ? AND user_email = ?",
	)
		.bind(contentStr, now, id, email)
		.run();

	return c.json({ ok: true });
});

smearCommunityRoutes.delete("/notes/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;

	const existing = await c.env.DB.prepare(
		"SELECT user_email FROM smear_notes WHERE id = ?",
	)
		.bind(id)
		.first<{ user_email: string }>();
	if (!existing) return c.json({ error: "not found" }, 404);
	if (existing.user_email !== email) return c.json({ error: "forbidden" }, 403);

	await c.env.DB.prepare("DELETE FROM smear_notes WHERE id = ? AND user_email = ?")
		.bind(id, email)
		.run();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 討論 —— 每個 dx 一條公開討論串,任何人可看可發言,只有作者本人或 admin
// 能刪(軟刪除,保留列以維持串的完整性,同 comments 表的既有作法)。
// v1 刻意不做 @mention 解析 / 通知:那套機制在既有 comments 系統上已經
// 相當複雜,這裡先給純 TipTap 內容,列為未來工作。
// ---------------------------------------------------------------------------

smearCommunityRoutes.get("/dx/:id/comments", async (c) => {
	const dxId = c.req.param("id");

	const { results } = await c.env.DB.prepare(
		`SELECT c.*, u.display_name, u.avatar_key
       FROM smear_comments c
       LEFT JOIN users u ON u.email = c.author_email
      WHERE c.dx_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC`,
	)
		.bind(dxId)
		.all();
	return c.json(results ?? []);
});

smearCommunityRoutes.post("/dx/:id/comments", async (c) => {
	const dxId = c.req.param("id");
	const email = c.var.email;

	const dx = await c.env.DB.prepare("SELECT id FROM smear_dx WHERE id = ?")
		.bind(dxId)
		.first<{ id: string }>();
	if (!dx) return c.json({ error: "dx not found" }, 404);

	const body = await c.req
		.json<{ content_json?: unknown; parent_id?: string }>()
		.catch(() => ({}) as Record<string, never>);
	if (body.content_json === undefined || body.content_json === null) {
		return c.json({ error: "content_json is required" }, 400);
	}

	// 驗證 parent_id 屬於同一個 dx —— 少了這道閘,一則留言可以宣稱回覆一則
	// 掛在「別的診斷」討論串底下的留言,造成串與串之間互相污染。
	if (body.parent_id) {
		const parent = await c.env.DB.prepare(
			"SELECT dx_id FROM smear_comments WHERE id = ?",
		)
			.bind(body.parent_id)
			.first<{ dx_id: string }>();
		if (!parent || parent.dx_id !== dxId) {
			return c.json({ error: "invalid parent_id" }, 400);
		}
	}

	const id = uuid();
	const now = Date.now();
	const contentStr = JSON.stringify(body.content_json);

	await c.env.DB.prepare(
		`INSERT INTO smear_comments (id, dx_id, parent_id, author_email, content_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, dxId, body.parent_id || null, email, contentStr, now, now)
		.run();

	const author = await c.env.DB.prepare(
		"SELECT display_name, avatar_key FROM users WHERE email = ?",
	)
		.bind(email)
		.first<{ display_name: string | null; avatar_key: string | null }>();

	return c.json(
		{
			id,
			dx_id: dxId,
			parent_id: body.parent_id || null,
			author_email: email,
			content_json: contentStr,
			created_at: now,
			updated_at: now,
			deleted_at: null,
			display_name: author?.display_name ?? null,
			avatar_key: author?.avatar_key ?? null,
		},
		201,
	);
});

smearCommunityRoutes.delete("/comments/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;

	const existing = await c.env.DB.prepare(
		"SELECT author_email FROM smear_comments WHERE id = ? AND deleted_at IS NULL",
	)
		.bind(id)
		.first<{ author_email: string }>();
	if (!existing) return c.json({ error: "not found" }, 404);

	const isOwner = existing.author_email === email;
	const isAdmin = isAdminEmail(email, c.env);
	if (!isOwner && !isAdmin) return c.json({ error: "forbidden" }, 403);

	await c.env.DB.prepare("UPDATE smear_comments SET deleted_at = ? WHERE id = ?")
		.bind(Date.now(), id)
		.run();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 投稿 —— 任何人可傳圖 + 建議答案 + 詳解草稿,進 pending 審核佇列。
// 在 admin 核准之前,對其他非 admin/非本人使用者完全不可見,也不進任何
// 抽題池(不寫進 smear_questions,直到 approve)。
// ---------------------------------------------------------------------------

smearCommunityRoutes.post("/submissions", async (c) => {
	const email = c.var.email;
	const fd = await c.req.formData();
	const rawFile = fd.get("image") as unknown as UploadedFile | string | null;

	const check = validateImageFile(rawFile);
	if (!check.ok) return c.json({ error: check.error }, check.status);
	const file = rawFile as UploadedFile;

	const proposedAnswerRaw = fd.get("proposedAnswer");
	const proposedAnswer =
		typeof proposedAnswerRaw === "string" ? proposedAnswerRaw.trim() : "";
	if (!proposedAnswer) {
		return c.json({ error: "proposedAnswer is required" }, 400);
	}

	const explanationTextRaw = fd.get("explanationText");
	const explanationText =
		typeof explanationTextRaw === "string" && explanationTextRaw.trim()
			? explanationTextRaw.trim()
			: null;

	// STAGING 路徑,刻意跟 smear/exam/、smear/ash/ 分開 —— 這強化了投稿在
	// 儲存層本身就不是活題目池的一部分(即使有人繞過 API 直接掃 R2)。
	const ext = file.type.split("/")[1];
	const key = `smear/submissions/${crypto.randomUUID()}.${ext}`;
	await c.env.R2.put(key, file.stream(), {
		httpMetadata: { contentType: file.type },
		customMetadata: { uploadedBy: email, uploadedAt: String(Date.now()) },
	});

	const id = uuid();
	const now = Date.now();
	await c.env.DB.prepare(
		`INSERT INTO smear_submissions
       (id, user_email, image_key, proposed_answer, explanation_text, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
	)
		.bind(id, email, key, proposedAnswer, explanationText, now)
		.run();

	// 刻意不回傳任何暗示「這題已經可以練習」的東西 —— 只有 id/status。
	return c.json({ id, status: "pending" }, 201);
});

smearCommunityRoutes.get("/submissions/mine", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT id, SUBSTR(proposed_answer, 1, 200) AS proposed_answer, status,
              created_at, reviewed_at, review_note
       FROM smear_submissions
      WHERE user_email = ?
      ORDER BY created_at DESC`,
	)
		.bind(email)
		.all();
	return c.json({ items: results ?? [] });
});

smearCommunityRoutes.get("/submissions/pending", async (c) => {
	const email = c.var.email;
	if (!isAdminEmail(email, c.env)) return c.json({ error: "forbidden" }, 403);

	const { results } = await c.env.DB.prepare(
		`SELECT id, user_email, image_key, proposed_answer, explanation_text, created_at
       FROM smear_submissions
      WHERE status = 'pending'
      ORDER BY created_at ASC`,
	)
		.all<{
			id: string;
			user_email: string;
			image_key: string;
			proposed_answer: string;
			explanation_text: string | null;
			created_at: number;
		}>();

	const items = [];
	for (const r of results ?? []) {
		const norm = normalizeTerm(r.proposed_answer);
		let suggestedDxId: string | null = null;
		let suggestedCanonical: string | null = null;
		if (norm) {
			const match = await c.env.DB.prepare(
				`SELECT st.dx_id, sd.canonical_long
           FROM smear_terms st JOIN smear_dx sd ON sd.id = st.dx_id
          WHERE st.status = 'accepted' AND st.norm = ?
          LIMIT 1`,
			)
				.bind(norm)
				.first<{ dx_id: string; canonical_long: string }>();
			if (match) {
				suggestedDxId = match.dx_id;
				suggestedCanonical = match.canonical_long;
			}
		}
		items.push({ ...r, suggestedDxId, suggestedCanonical });
	}

	return c.json({ items });
});

smearCommunityRoutes.post("/submissions/:id/approve", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;
	if (!isAdminEmail(email, c.env)) return c.json({ error: "forbidden" }, 403);

	const body = await c.req
		.json<{ dxId?: string }>()
		.catch(() => ({}) as Record<string, never>);
	if (!body.dxId || typeof body.dxId !== "string") {
		return c.json({ error: "dxId is required" }, 400);
	}

	const submission = await c.env.DB.prepare(
		"SELECT id, status, image_key FROM smear_submissions WHERE id = ?",
	)
		.bind(id)
		.first<{ id: string; status: string; image_key: string }>();
	if (!submission) return c.json({ error: "not found" }, 404);
	if (submission.status !== "pending") {
		return c.json({ error: "submission already resolved" }, 409);
	}

	const dx = await c.env.DB.prepare("SELECT id, qtype FROM smear_dx WHERE id = ?")
		.bind(body.dxId)
		.first<{ id: string; qtype: string }>();
	if (!dx) return c.json({ error: "dx not found" }, 400);

	const now = Date.now();
	// 沿用 scripts/smear/import.ts 的 promptFor() 邏輯:依 qtype 決定固定文字,
	// 原始 PDF 的提示文字從沒被結構化保存過,這裡跟匯入腳本用同一套預設。
	const prompt = dx.qtype === "cell" ? "What cell?" : "What disease?";
	const questionId = `submission-${submission.id}`;

	await c.env.DB.batch([
		c.env.DB.prepare(
			`UPDATE smear_submissions
         SET status = 'approved', matched_dx_id = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND status = 'pending'`,
		).bind(body.dxId, email, now, id),
		// v1 簡化:不做伺服器端二次裁切,image_key_view / image_key_full 都指向
		// 同一張已上傳的圖 —— 這是已知的限制,不是 bug(見任務說明)。
		c.env.DB.prepare(
			`INSERT INTO smear_questions
         (id, dx_id, source, source_ref, image_key_view, image_key_full, prompt, image_note, attribution, created_at)
       VALUES (?, ?, 'submission', ?, ?, ?, ?, NULL, NULL, ?)`,
		).bind(questionId, body.dxId, submission.id, submission.image_key, submission.image_key, prompt, now),
	]);

	// 刻意不動 smear_dx_notes —— explanation_text 是給審核者判斷用的脈絡,
	// 不是自動併入共筆詳解的內容。那是另一個編輯行為,而且目前這張表還沒有
	// 編輯 API(見 worker/routes/smear.ts 的 GET /dx/:id),所以本來就做不到,
	// 也不該從這支端點偷偷寫。

	return c.json({ ok: true, questionId });
});

smearCommunityRoutes.post("/submissions/:id/reject", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;
	if (!isAdminEmail(email, c.env)) return c.json({ error: "forbidden" }, 403);

	const body = await c.req
		.json<{ reviewNote?: string }>()
		.catch(() => ({}) as Record<string, never>);

	const submission = await c.env.DB.prepare(
		"SELECT id, status FROM smear_submissions WHERE id = ?",
	)
		.bind(id)
		.first<{ id: string; status: string }>();
	if (!submission) return c.json({ error: "not found" }, 404);
	if (submission.status !== "pending") {
		return c.json({ error: "submission already resolved" }, 409);
	}

	const now = Date.now();
	await c.env.DB.prepare(
		`UPDATE smear_submissions
       SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?
     WHERE id = ? AND status = 'pending'`,
	)
		.bind(email, now, body.reviewNote ?? null, id)
		.run();

	// R2 物件保留原地 —— 被拒的投稿可能被重新考慮,刪除不是這支的責任。
	return c.json({ ok: true });
});
