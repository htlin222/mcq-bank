import { Hono } from "hono";
import type { AppContext } from "../types";
import { uuid } from "../lib/db";
import { isAdminEmail } from "../lib/admin";
import { normalizeTerm } from "../lib/smear-grade";
import { planApprovedImages } from "../lib/smear-approve-images";
import { validateImageFile, type UploadedFile } from "../lib/upload-validate";
import { resolveSmearNoteOrder } from "../lib/smear-notes";
import {
	SMEAR_NOTE_LOCK_SQL,
	SMEAR_NOTE_SAVE_SQL,
	parseSmearNoteSaveBody,
	smearNoteLockBinds,
	smearNoteLockDecision,
	smearNoteSaveBinds,
	smearNoteSaveRefusal,
} from "../lib/smear-dx-note";
import {
	DELETED_SMEAR_COMMENT_PREVIEW,
	smearCommentPreview,
	smearMentionTargets,
} from "../lib/smear-mentions";
import { extractMentions } from "../lib/db";

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
// 順序寫在 sort_order,不改 id:畫記與內文都靠 id 定位。
// ---------------------------------------------------------------------------

smearCommunityRoutes.get("/dx/:id/notes", async (c) => {
	const dxId = c.req.param("id");
	const email = c.var.email;

	const { results } = await c.env.DB.prepare(
		`SELECT id, dx_id, content_json, sort_order, created_at, updated_at
       FROM smear_notes
      WHERE user_email = ? AND dx_id = ?
      ORDER BY sort_order, id`,
	)
		.bind(email, dxId)
		.all();
	return c.json({ items: results ?? [] });
});

// 必須是現有 id 的完整排列。少一個多一個整批拒絕,一次 batch 寫完。
// 註冊在 PUT /notes/:id 之外:那條改的是內文,這條只改 sort_order。
smearCommunityRoutes.put("/dx/:id/notes/order", async (c) => {
	const dxId = c.req.param("id");
	const email = c.var.email;
	const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });

	const rows = await c.env.DB.prepare(
		"SELECT id FROM smear_notes WHERE user_email = ? AND dx_id = ?",
	)
		.bind(email, dxId)
		.all<{ id: string }>();
	const existing = (rows.results ?? []).map((r) => r.id);
	if (!existing.length) return c.json({ error: "no notes", dx_id: dxId }, 404);

	const picked = resolveSmearNoteOrder(existing, body.ids);
	if (!picked.ok) return c.json({ error: picked.error, ids: existing }, picked.status);

	await c.env.DB.batch(
		picked.ids.map((noteId, i) =>
			c.env.DB
				.prepare(
					"UPDATE smear_notes SET sort_order = ? WHERE user_email = ? AND dx_id = ? AND id = ?",
				)
				.bind(i, email, dxId, noteId),
		),
	);

	return c.json({ ok: true, ids: picked.ids });
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
// 共筆詳解 —— 管理員在診斷頁改。鎖 5 分鐘,存檔對版本。
// updated_by 有值之後,匯入的 ON CONFLICT 不會把這份蓋回 JSON。
// ---------------------------------------------------------------------------

smearCommunityRoutes.post("/dx/:id/note/lock", async (c) => {
	const email = c.var.email;
	if (!isAdminEmail(email, c.env)) return c.json({ error: "forbidden" }, 403);
	const dxId = c.req.param("id");
	const now = Date.now();
	const decision = smearNoteLockDecision(
		await c.env.DB.prepare(
			"SELECT editing_by, editing_until FROM smear_dx_notes WHERE dx_id = ?",
		)
			.bind(dxId)
			.first<{ editing_by: string | null; editing_until: number | null }>(),
		email,
		now,
	);
	if (decision.action === "missing") return c.json({ error: "note missing" }, 404);
	if (decision.action === "deny") {
		return c.json(
			{ error: "locked", locked_by: decision.lockedBy, until: decision.until },
			423,
		);
	}
	const wrote = await c.env.DB.prepare(SMEAR_NOTE_LOCK_SQL)
		.bind(...smearNoteLockBinds(email, decision.until, dxId, now))
		.run();
	if ((wrote.meta?.changes ?? 0) > 0) return c.json({ ok: true, until: decision.until });
	const again = smearNoteLockDecision(
		await c.env.DB.prepare(
			"SELECT editing_by, editing_until FROM smear_dx_notes WHERE dx_id = ?",
		)
			.bind(dxId)
			.first<{ editing_by: string | null; editing_until: number | null }>(),
		email,
		now,
	);
	if (again.action === "deny") {
		return c.json({ error: "locked", locked_by: again.lockedBy, until: again.until }, 423);
	}
	if (again.action === "missing") return c.json({ error: "note missing" }, 404);
	return c.json({ error: "locked" }, 423);
});

smearCommunityRoutes.post("/dx/:id/note/unlock", async (c) => {
	const email = c.var.email;
	if (!isAdminEmail(email, c.env)) return c.json({ error: "forbidden" }, 403);
	await c.env.DB.prepare(
		"UPDATE smear_dx_notes SET editing_by = NULL, editing_until = NULL WHERE dx_id = ? AND editing_by = ?",
	)
		.bind(c.req.param("id"), email)
		.run();
	return c.json({ ok: true });
});

smearCommunityRoutes.put("/dx/:id/note", async (c) => {
	const email = c.var.email;
	if (!isAdminEmail(email, c.env)) return c.json({ error: "forbidden" }, 403);
	const dxId = c.req.param("id");
	const parsed = parseSmearNoteSaveBody(await c.req.json().catch(() => null));
	if (!parsed.ok) return c.json({ error: parsed.error }, 400);

	const now = Date.now();
	const wrote = await c.env.DB.prepare(SMEAR_NOTE_SAVE_SQL)
		.bind(...smearNoteSaveBinds(parsed.json, email, now, dxId, parsed.expectedVersion))
		.run();
	if ((wrote.meta?.changes ?? 0) > 0) {
		return c.json({ ok: true, version: parsed.expectedVersion + 1, updated_by: email, updated_at: now });
	}
	const row = await c.env.DB.prepare(
		"SELECT editing_by, editing_until, version FROM smear_dx_notes WHERE dx_id = ?",
	)
		.bind(dxId)
		.first<{ editing_by: string | null; editing_until: number | null; version: number }>();
	const refusal = smearNoteSaveRefusal(row ?? null, email, parsed.expectedVersion, now);
	if (refusal.status === 423 && refusal.error === "locked") {
		return c.json({ error: "locked", locked_by: refusal.lockedBy, until: refusal.until }, 423);
	}
	if (refusal.status === 409) {
		return c.json(
			{ error: "version conflict", server_version: refusal.serverVersion, your_version: parsed.expectedVersion },
			409,
		);
	}
	return c.json({ error: refusal.error }, refusal.status);
});

// ---------------------------------------------------------------------------
// 討論 —— 每個 dx 一條公開討論串,任何人可看可發言,只有作者本人或 admin
// 能刪(軟刪除,保留列以維持串的完整性,同 comments 表的既有作法)。
// @ 沿用筆試的 mention 節點抽取。通知寫 dx_id,不寫 mentions 表:
// 那張表的 question_id 是 NOT NULL,而這裡沒有考題。
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

	const rawMentions = extractMentions(contentStr).filter((m) => m !== email);
	const known = new Set<string>();
	if (rawMentions.length > 0) {
		const { results: users } = await c.env.DB.prepare(
			`SELECT email FROM users WHERE email IN (${rawMentions.map(() => "?").join(",")})`,
		)
			.bind(...rawMentions)
			.all<{ email: string }>();
		for (const u of users ?? []) known.add(u.email);
	}
	const targets = smearMentionTargets(contentStr, email, known);
	const preview = smearCommentPreview(contentStr);

	const ops = [
		c.env.DB.prepare(
			`INSERT INTO smear_comments (id, dx_id, parent_id, author_email, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(id, dxId, body.parent_id || null, email, contentStr, now, now),
		...targets.map((mentionedEmail) =>
			c.env.DB.prepare(
				`INSERT INTO notifications
           (id, recipient, kind, question_id, comment_id, actor_email, preview, created_at, dx_id)
         VALUES (?, ?, 'smear_mention', NULL, ?, ?, ?, ?, ?)`,
			).bind(uuid(), mentionedEmail, id, email, preview, now, dxId),
		),
	];
	await c.env.DB.batch(ops);

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

	const now = Date.now();
	await c.env.DB.batch([
		c.env.DB.prepare("UPDATE smear_comments SET deleted_at = ? WHERE id = ?").bind(now, id),
		// 預覽換成固定墓碑。只動 smear_mention,避免撞到筆試留言的 comment_id。
		c.env.DB.prepare(
			"UPDATE notifications SET preview = ? WHERE comment_id = ? AND kind = 'smear_mention'",
		).bind(DELETED_SMEAR_COMMENT_PREVIEW, id),
	]);
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

	// multipart:dxId + 瀏覽器縮好的檢視圖。JSON 的舊形狀不再接受 —— 少了
	// 檢視圖就會又把兩把 key 寫成同一張。
	const fd = await c.req.formData().catch(() => null);
	const dxIdRaw = fd?.get("dxId");
	const dxId = typeof dxIdRaw === "string" ? dxIdRaw.trim() : "";
	if (!dxId) return c.json({ error: "dxId is required" }, 400);

	const rawView = fd?.get("view") as unknown as UploadedFile | string | null;
	const check = validateImageFile(rawView);
	if (!check.ok) {
		return c.json(
			{ error: check.error === "no file" ? "view image is required" : check.error },
			check.status,
		);
	}
	const viewFile = rawView as UploadedFile;

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
		.bind(dxId)
		.first<{ id: string; qtype: string }>();
	if (!dx) return c.json({ error: "dx not found" }, 400);

	// head 只拿位元組數,不把原圖拉進 Worker。檢視圖不夠小就整筆拒絕,
	// 不寫出兩把指著同一張圖的 key。
	const original = await c.env.R2.head(submission.image_key);
	if (!original) return c.json({ error: "original image is missing" }, 400);
	const planned = planApprovedImages({
		submissionId: submission.id,
		fullKey: submission.image_key,
		viewType: viewFile.type,
		viewBytes: viewFile.size,
		fullBytes: original.size,
	});
	if (!planned.ok) return c.json({ error: planned.error }, 400);

	await c.env.R2.put(planned.viewKey, viewFile.stream(), {
		httpMetadata: { contentType: viewFile.type },
		customMetadata: { derivedFrom: submission.image_key, uploadedBy: email },
	});

	const now = Date.now();
	// 沿用 scripts/smear/import.ts 的 promptFor() 邏輯:依 qtype 決定固定文字,
	// 原始 PDF 的提示文字從沒被結構化保存過,這裡跟匯入腳本用同一套預設。
	const prompt = dx.qtype === "cell" ? "What cell?" : "What disease?";
	const questionId = `submission-${submission.id}`;

	// TOCTOU: the SELECT above and this write aren't one atomic step, so two
	// concurrent approve calls can both pass the 'pending' check above. The
	// UPDATE's own `WHERE status = 'pending'` guard makes the loser's write a
	// no-op, but `questionId` is derived from `submission.id` (not random),
	// so the loser's INSERT collides on smear_questions' primary key and the
	// whole batch — both statements — rolls back atomically (verified locally:
	// re-running approve after manually resetting status back to 'pending'
	// throws and leaves both tables exactly as they were). Catch that instead
	// of letting it surface as a bare 500. The view object may already be in
	// R2; the key is deterministic, so the winner's put overwrites it.
	try {
		await c.env.DB.batch([
			c.env.DB.prepare(
				`UPDATE smear_submissions
           SET status = 'approved', matched_dx_id = ?, reviewed_by = ?, reviewed_at = ?
         WHERE id = ? AND status = 'pending'`,
			).bind(dxId, email, now, id),
			c.env.DB.prepare(
				`INSERT INTO smear_questions
           (id, dx_id, source, source_ref, image_key_view, image_key_full, prompt, image_note, attribution, created_at)
         VALUES (?, ?, 'submission', ?, ?, ?, ?, NULL, NULL, ?)`,
			).bind(
				questionId,
				dxId,
				submission.id,
				planned.viewKey,
				planned.fullKey,
				prompt,
				now,
			),
		]);
	} catch {
		return c.json({ error: "submission already resolved" }, 409);
	}

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
	const res = await c.env.DB.prepare(
		`UPDATE smear_submissions
       SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?
     WHERE id = ? AND status = 'pending'`,
	)
		.bind(email, now, body.reviewNote ?? null, id)
		.run();
	// TOCTOU: the SELECT above and this UPDATE aren't one atomic step, so a
	// concurrent approve can flip the row between the two. Unlike approve
	// (whose second write is a fixed-id INSERT that collides and rolls the
	// whole batch back), this UPDATE has no such backstop — without checking
	// `meta.changes`, a request that lost the race would still get back
	// `{ok: true}` while the submission was actually approved underneath it.
	if ((res.meta?.changes ?? 0) === 0) {
		return c.json({ error: "submission already resolved" }, 409);
	}

	// R2 物件保留原地 —— 被拒的投稿可能被重新考慮,刪除不是這支的責任。
	return c.json({ ok: true });
});
