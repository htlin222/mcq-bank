import { Hono } from "hono";
import type { AppContext } from "../types";
import {
	extractMentions,
	excerpt,
	uuid,
	extractQuestionRefs,
	syncQuestionRefs,
} from "../lib/db";
import { readIdemKey, idemLookup, idemRecordOp } from "../lib/idempotency";

export const commentsRoutes = new Hono<AppContext>();

// List comments for a question (returns flat list; client builds tree by parent_id)
commentsRoutes.get("/:id/comments", async (c) => {
	const id = c.req.param("id");
	// helpful 計數與「我投過沒」在同一次查詢帶回,避免每則留言一次 round-trip。
	const { results } = await c.env.DB.prepare(
		`SELECT c.*, u.display_name, u.avatar_key,
              COALESCE(hc.n, 0) AS helpful_count,
              CASE WHEN mv.user_email IS NULL THEN 0 ELSE 1 END AS voted_by_me,
              EXISTS (SELECT 1 FROM answer_challenges ac
                       WHERE ac.question_id = c.question_id
                         AND ac.status = 'promoted'
                         AND ac.proposer_email = c.author_email) AS adopted
       FROM comments c
       LEFT JOIN users u ON u.email = c.author_email
       LEFT JOIN (SELECT target_id, COUNT(*) AS n FROM helpful_votes
                   WHERE target_type = 'comment' GROUP BY target_id) hc
              ON hc.target_id = c.id
       LEFT JOIN helpful_votes mv
              ON mv.target_type = 'comment' AND mv.target_id = c.id
             AND mv.user_email = ?
       WHERE c.question_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC`,
	)
		.bind(c.var.email, id)
		.all();
	return c.json(results);
});

// Post comment (optionally a reply via parent_id)
commentsRoutes.post("/:id/comments", async (c) => {
	const questionId = c.req.param("id");
	const email = c.var.email;

	// 冪等:重送同一 key 直接 replay,不重複 INSERT 留言 / mentions / notifications。
	const idemKey = readIdemKey(c);
	if (idemKey) {
		const hit = await idemLookup(c.env.DB, email, idemKey);
		if (hit) return c.json(hit.body as any, hit.status as any);
	}

	const body = await c.req.json<{
		content_json: any;
		parent_id?: string;
	}>();

	const commentId = uuid();
	const now = Date.now();
	const contentStr = JSON.stringify(body.content_json);

	// Validate parent exists and belongs to the same question
	let parentAuthor: string | null = null;
	if (body.parent_id) {
		const parent = await c.env.DB.prepare(
			"SELECT question_id, author_email FROM comments WHERE id = ?",
		)
			.bind(body.parent_id)
			.first<{ question_id: string; author_email: string }>();
		if (!parent || parent.question_id !== questionId) {
			return c.json({ error: "invalid parent_id" }, 400);
		}
		parentAuthor = parent.author_email;
	}

	// 留言、mentions、notifications 與去重列改走同一個 DB.batch(),原子提交。
	const ops: any[] = [
		c.env.DB.prepare(
			`INSERT INTO comments
       (id, question_id, parent_id, author_email, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			commentId,
			questionId,
			body.parent_id || null,
			email,
			contentStr,
			now,
			now,
		),
	];

	// Notifications: mentions + reply to parent author
	const mentioned = new Set(extractMentions(contentStr));
	mentioned.delete(email);

	const preview = excerpt(contentStr);

	for (const m of mentioned) {
		ops.push(
			c.env.DB.prepare(
				`INSERT INTO mentions (source_type, source_id, mentioned_email, by_email, question_id, created_at)
           VALUES ('comment', ?, ?, ?, ?, ?)`,
			).bind(commentId, m, email, questionId, now),
		);
		ops.push(
			c.env.DB.prepare(
				`INSERT INTO notifications (id, recipient, kind, question_id, comment_id, actor_email, preview, created_at)
           VALUES (?, ?, 'mention', ?, ?, ?, ?, ?)`,
			).bind(uuid(), m, questionId, commentId, email, preview, now),
		);
	}

	if (parentAuthor && parentAuthor !== email && !mentioned.has(parentAuthor)) {
		ops.push(
			c.env.DB.prepare(
				`INSERT INTO notifications (id, recipient, kind, question_id, comment_id, actor_email, preview, created_at)
           VALUES (?, ?, 'reply', ?, ?, ?, ?, ?)`,
			).bind(uuid(), parentAuthor, questionId, commentId, email, preview, now),
		);
	}

	// 回傳體以已知欄位就地組出(等價於原本 INSERT 後的 SELECT join),
	// 讓去重列能在同一 batch 內帶上完整 replay body。
	const author = await c.env.DB.prepare(
		"SELECT display_name, avatar_key FROM users WHERE email = ?",
	)
		.bind(email)
		.first<{ display_name: string | null; avatar_key: string | null }>();

	const created = {
		id: commentId,
		question_id: questionId,
		parent_id: body.parent_id || null,
		author_email: email,
		content_json: contentStr,
		created_at: now,
		updated_at: now,
		deleted_at: null,
		display_name: author?.display_name ?? null,
		avatar_key: author?.avatar_key ?? null,
	};
	// 新留言必然零票 —— 補上常數欄讓形狀與 list 端點一致。
	const payload = { ...created, helpful_count: 0, voted_by_me: 0, adopted: 0 };

	if (idemKey) {
		ops.push(
			idemRecordOp(c.env.DB, {
				email,
				key: idemKey,
				endpoint: "POST /comments/:id/comments",
				status: 201,
				body: payload,
				now,
			}),
		);
	}
	await c.env.DB.batch(ops);

	await syncQuestionRefs(c.env.DB, {
		sourceType: "comment",
		sourceId: commentId,
		selfQuestionId: questionId,
		byEmail: email,
		targets: extractQuestionRefs(contentStr),
		now,
	});

	return c.json(payload, 201);
});

// Edit own comment
commentsRoutes.patch("/:qid/comments/:cid", async (c) => {
	const cid = c.req.param("cid");
	const email = c.var.email;
	const body = await c.req.json<{ content_json: any }>();

	const existing = await c.env.DB.prepare(
		"SELECT author_email FROM comments WHERE id = ? AND deleted_at IS NULL",
	)
		.bind(cid)
		.first<{ author_email: string }>();

	if (!existing) return c.json({ error: "not found" }, 404);
	if (existing.author_email !== email)
		return c.json({ error: "forbidden" }, 403);

	const now = Date.now();
	const contentStr = JSON.stringify(body.content_json);
	await c.env.DB.prepare(
		"UPDATE comments SET content_json = ?, updated_at = ? WHERE id = ?",
	)
		.bind(contentStr, now, cid)
		.run();

	const qid = c.req.param("qid");
	await syncQuestionRefs(c.env.DB, {
		sourceType: "comment",
		sourceId: cid,
		selfQuestionId: qid,
		byEmail: email,
		targets: extractQuestionRefs(contentStr),
		now,
	});

	return c.json({ ok: true });
});

// Soft delete
commentsRoutes.delete("/:qid/comments/:cid", async (c) => {
	const cid = c.req.param("cid");
	const email = c.var.email;

	const existing = await c.env.DB.prepare(
		"SELECT author_email FROM comments WHERE id = ? AND deleted_at IS NULL",
	)
		.bind(cid)
		.first<{ author_email: string }>();

	if (!existing) return c.json({ error: "not found" }, 404);
	if (existing.author_email !== email)
		return c.json({ error: "forbidden" }, 403);

	await c.env.DB.batch([
		c.env.DB.prepare("UPDATE comments SET deleted_at = ? WHERE id = ?").bind(
			Date.now(),
			cid,
		),
		c.env.DB.prepare(
			"DELETE FROM question_refs WHERE source_type = 'comment' AND source_id = ?",
		).bind(cid),
	]);

	return c.json({ ok: true });
});
