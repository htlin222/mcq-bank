import { Hono } from "hono";
import type { AppContext } from "../types";

// 使用者自訂的 AI 提示詞,供選字工具列的「✨ AI」使用。
//
// 這裡刻意只有提示詞:Groq 金鑰只存在瀏覽器 localStorage,從不經過 Worker、
// 從不進 D1(見 docs/plans/2026-07-28-byok-ai-assistant-design.md)。提示詞
// 存雲端是為了跨裝置共用,和金鑰是兩件解耦的事 —— 沒設金鑰的人一樣看得到
// 自己的提示詞列表。
//
// 四個內建預設在前端程式碼裡,不在這張表,所以這裡永遠只回傳自訂的。
export const aiPromptRoutes = new Hono<AppContext>();

const MAX_PROMPTS = 20;
const MAX_TITLE = 30;
const MAX_BODY = 2000;

type Row = {
	id: string;
	title: string;
	body: string;
	sort_order: number;
	created_at: number;
	updated_at: number;
};

// 驗證並正規化使用者輸入。回傳字串代表錯誤訊息。
function validate(
	title: unknown,
	body: unknown,
): { title: string; body: string } | string {
	if (typeof title !== "string" || typeof body !== "string") {
		return "title 與 body 為必填";
	}
	const t = title.trim();
	const b = body.trim();
	if (!t) return "title 不可空白";
	if (!b) return "body 不可空白";
	if (t.length > MAX_TITLE) return `title 上限 ${MAX_TITLE} 字`;
	if (b.length > MAX_BODY) return `body 上限 ${MAX_BODY} 字`;
	return { title: t, body: b };
}

// GET /api/ai/prompts — 本人的自訂提示詞。
aiPromptRoutes.get("/", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT id, title, body, sort_order, created_at, updated_at
       FROM ai_prompts
      WHERE user_email = ?
      ORDER BY sort_order, created_at`,
	)
		.bind(c.var.email)
		.all<Row>();
	return c.json({ prompts: results ?? [] });
});

// POST /api/ai/prompts — 新增一則。
aiPromptRoutes.post("/", async (c) => {
	const email = c.var.email;
	const input = await c.req.json<{ title?: unknown; body?: unknown }>();
	const v = validate(input.title, input.body);
	if (typeof v === "string") return c.json({ error: v }, 400);

	// 上限擋在寫入前。20 則已經遠超過任何人會用到的量,純粹是防呆。
	const count = await c.env.DB.prepare(
		"SELECT COUNT(*) AS n FROM ai_prompts WHERE user_email = ?",
	)
		.bind(email)
		.first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_PROMPTS) {
		return c.json({ error: `最多 ${MAX_PROMPTS} 則提示詞` }, 409);
	}

	// 新的排在最後:取現有最大 sort_order + 1。
	const max = await c.env.DB.prepare(
		"SELECT COALESCE(MAX(sort_order), -1) AS m FROM ai_prompts WHERE user_email = ?",
	)
		.bind(email)
		.first<{ m: number }>();

	const now = Date.now();
	const row: Row = {
		id: crypto.randomUUID(),
		title: v.title,
		body: v.body,
		sort_order: (max?.m ?? -1) + 1,
		created_at: now,
		updated_at: now,
	};

	await c.env.DB.prepare(
		`INSERT INTO ai_prompts (id, user_email, title, body, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			row.id,
			email,
			row.title,
			row.body,
			row.sort_order,
			row.created_at,
			row.updated_at,
		)
		.run();

	return c.json({ prompt: row }, 201);
});

// PUT /api/ai/prompts/:id — 改標題/內容/排序。
aiPromptRoutes.put("/:id", async (c) => {
	const id = c.req.param("id");
	const email = c.var.email;
	const input = await c.req.json<{
		title?: unknown;
		body?: unknown;
		sort_order?: unknown;
	}>();
	const v = validate(input.title, input.body);
	if (typeof v === "string") return c.json({ error: v }, 400);
	const sortOrder =
		typeof input.sort_order === "number" && Number.isFinite(input.sort_order)
			? Math.trunc(input.sort_order)
			: null;

	const now = Date.now();
	// user_email 綁在 WHERE 上,所以拿到別人的 id 也改不動 —— 回 404,不洩漏
	// 這個 id 是否存在。
	const res = await c.env.DB.prepare(
		`UPDATE ai_prompts
        SET title = ?, body = ?,
            sort_order = COALESCE(?, sort_order),
            updated_at = ?
      WHERE id = ? AND user_email = ?`,
	)
		.bind(v.title, v.body, sortOrder, now, id, email)
		.run();

	if (!res.meta.changes) return c.json({ error: "not found" }, 404);
	return c.json({ ok: true, updated_at: now });
});

// DELETE /api/ai/prompts/:id
aiPromptRoutes.delete("/:id", async (c) => {
	const res = await c.env.DB.prepare(
		"DELETE FROM ai_prompts WHERE id = ? AND user_email = ?",
	)
		.bind(c.req.param("id"), c.var.email)
		.run();
	if (!res.meta.changes) return c.json({ error: "not found" }, 404);
	return c.json({ ok: true });
});
