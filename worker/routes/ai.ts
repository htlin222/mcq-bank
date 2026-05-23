import { Hono } from "hono";
import type { AppContext } from "../types";

export const aiRoutes = new Hono<AppContext>();

const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

// Summarize a question's explanation (returns 2-3 sentence TL;DR)
aiRoutes.post("/summarize", async (c) => {
	const body = await c.req.json<{ text: string }>();
	if (!body.text || body.text.length < 50) {
		return c.json({ error: "text too short" }, 400);
	}

	const out = await c.env.AI.run(TEXT_MODEL, {
		messages: [
			{
				role: "system",
				content:
					"你是醫學考題解答摘要助手。把使用者提供的詳解濃縮成 2-3 句繁體中文要點,直接給結論,不要寫「摘要如下」之類的客套話。",
			},
			{ role: "user", content: body.text.slice(0, 4000) },
		],
	});

	return c.json({ summary: (out as any).response });
});

// Suggest hematology-specific tags for a question stem.
// Returns { tags: string[] } — free-form, English abbreviations / 繁體中文
// disease names (e.g. "AML", "ITP", "thalassemia", "CML", "小兒", "TLS").
aiRoutes.post("/suggest-tags", async (c) => {
	const body = await c.req.json<{ stem: string }>();

	const out = await c.env.AI.run(TEXT_MODEL, {
		messages: [
			{
				role: "system",
				content:
					"你是血液腫瘤科考題標籤助手。題目皆屬血液腫瘤領域 (adult hematology 或 pediatric hematology)。" +
					'看到題幹後回傳一個 JSON: {"tags":["<tag1>","<tag2>","<tag3>"]}。' +
					"tag 風格:疾病用慣用縮寫 (AML, APL, CML, CLL, MM, MDS, ITP, TTP, DLBCL, HL, NHL, AA)," +
					"其他用繁體中文 (誘導化療、TKI、TLS、共同照護、小兒、骨髓移植、輸血依賴)。" +
					"盡量 2-5 個標籤,不要過多,不要解釋,只回 JSON。",
			},
			{ role: "user", content: body.stem.slice(0, 2000) },
		],
	});

	let parsed: { tags: string[] } = { tags: [] };
	try {
		const raw = (out as any).response.match(/\{[\s\S]*\}/)?.[0];
		const j = JSON.parse(raw);
		if (Array.isArray(j.tags)) {
			parsed.tags = (j.tags as unknown[])
				.filter((t): t is string => typeof t === "string")
				.map((t: string) => t.trim())
				.filter(Boolean)
				.slice(0, 8);
		}
	} catch {
		// fall through to empty
	}
	return c.json(parsed);
});

// AI-assisted explanation expansion (called from TipTap toolbar)
aiRoutes.post("/expand", async (c) => {
	const body = await c.req.json<{ context: string; instruction?: string }>();

	const out = await c.env.AI.run(TEXT_MODEL, {
		messages: [
			{
				role: "system",
				content:
					"你是醫學考題詳解協作助手。根據使用者提供的草稿,擴充或改寫成更完整的詳解。保留 markdown 格式。用繁體中文。直接給內容,不要客套。",
			},
			{
				role: "user",
				content: `指示:${body.instruction || "請擴充這段詳解"}\n\n草稿:\n${body.context.slice(0, 4000)}`,
			},
		],
	});

	return c.json({ text: (out as any).response });
});

// Convert text to Traditional Chinese (Taiwan), preserving medical terminology.
// Used to "rescue" 詳解 that contains 簡體 or English passages.
aiRoutes.post("/translate-zh-tw", async (c) => {
	const body = await c.req.json<{ text: string }>();
	if (!body.text || body.text.length < 2) {
		return c.json({ error: "text too short" }, 400);
	}

	const out = await c.env.AI.run(TEXT_MODEL, {
		messages: [
			{
				role: "system",
				content:
					"你是醫學文件繁體中文化助手。把使用者提供的內容轉成台灣慣用的繁體中文。" +
					"規則:(1) 簡體字直接轉繁體;(2) 中國大陸用語改為台灣用語" +
					"(例如:激素→荷爾蒙/類固醇、白血球計數的單位保留)" +
					";(3) 英文醫學名詞與藥名保留原文不翻;" +
					"(4) 已是繁體與正確用語的句子原樣保留,不要硬改;" +
					"(5) 直接輸出轉換結果,不要加說明、前綴或客套話。",
			},
			{ role: "user", content: body.text.slice(0, 4000) },
		],
	});

	return c.json({ text: (out as any).response });
});

// Embed text for similarity search (used to find related questions)
aiRoutes.post("/embed", async (c) => {
	const body = await c.req.json<{ text: string }>();
	const out = await c.env.AI.run(EMBED_MODEL, { text: [body.text] });
	return c.json({ vector: (out as any).data[0] });
});
