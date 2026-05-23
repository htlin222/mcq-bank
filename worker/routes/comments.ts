import { Hono } from "hono";
import type { AppContext } from "../types";
import {
	extractMentions,
	excerpt,
	uuid,
	extractQuestionRefs,
	syncQuestionRefs,
} from "../lib/db";

export const commentsRoutes = new Hono<AppContext>();

// List comments for a question (returns flat list; client builds tree by parent_id)
commentsRoutes.get("/:id/comments", async (c) => {
	const id = c.req.param("id");
	const { results } = await c.env.DB.prepare(
		`SELECT c.*, u.display_name, u.avatar_key
       FROM comments c
       LEFT JOIN users u ON u.email = c.author_email
       WHERE c.question_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC`,
	)
		.bind(id)
		.all();
	return c.json(results);
});

// Post comment (optionally a reply via parent_id)
commentsRoutes.post("/:id/comments", async (c) => {
	const questionId = c.req.param("id");
	const email = c.var.email;
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

	await c.env.DB.prepare(
		`INSERT INTO comments
       (id, question_id, parent_id, author_email, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			commentId,
			questionId,
			body.parent_id || null,
			email,
			contentStr,
			now,
			now,
		)
		.run();

	// Notifications: mentions + reply to parent author
	const mentioned = new Set(extractMentions(contentStr));
	mentioned.delete(email);

	const notifOps: any[] = [];
	const preview = excerpt(contentStr);

	for (const m of mentioned) {
		notifOps.push(
			c.env.DB.prepare(
				`INSERT INTO mentions (source_type, source_id, mentioned_email, by_email, question_id, created_at)
           VALUES ('comment', ?, ?, ?, ?, ?)`,
			).bind(commentId, m, email, questionId, now),
		);
		notifOps.push(
			c.env.DB.prepare(
				`INSERT INTO notifications (id, recipient, kind, question_id, comment_id, actor_email, preview, created_at)
           VALUES (?, ?, 'mention', ?, ?, ?, ?, ?)`,
			).bind(uuid(), m, questionId, commentId, email, preview, now),
		);
	}

	if (parentAuthor && parentAuthor !== email && !mentioned.has(parentAuthor)) {
		notifOps.push(
			c.env.DB.prepare(
				`INSERT INTO notifications (id, recipient, kind, question_id, comment_id, actor_email, preview, created_at)
           VALUES (?, ?, 'reply', ?, ?, ?, ?, ?)`,
			).bind(uuid(), parentAuthor, questionId, commentId, email, preview, now),
		);
	}

	if (notifOps.length) await c.env.DB.batch(notifOps);

	await syncQuestionRefs(c.env.DB, {
		sourceType: "comment",
		sourceId: commentId,
		selfQuestionId: questionId,
		byEmail: email,
		targets: extractQuestionRefs(contentStr),
		now,
	});

	// Return the created comment with author info
	const created = await c.env.DB.prepare(
		`SELECT c.*, u.display_name, u.avatar_key
       FROM comments c LEFT JOIN users u ON u.email = c.author_email
       WHERE c.id = ?`,
	)
		.bind(commentId)
		.first();

	return c.json(created, 201);
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
