import { Hono } from "hono";
import type { AppContext, Env } from "../types";

export const aiRoutes = new Hono<AppContext>();

const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

type GeneratedQaItem = {
	question: string;
	answer: string[];
};

// Generic fallbacks so the worker still produces sensible output when a
// fork hasn't filled in [ai] in config.toml yet. Forks should always set
// these in wrangler.toml [vars] (see config.example.toml for the schema).
const AI_DEFAULTS = {
	specialty_zh: "醫學",
	specialty_en_long: "general medicine",
	tag_disease_examples: "DM, HTN, CKD, COPD, HF",
	tag_topic_examples: "誘導治療,術後照護,門診追蹤,鑑別診斷,藥物副作用",
	qa_question_examples:
		"甚麼是 X 機轉?;Y 的臨床指引建議?;Z 的鑑別診斷有哪些?",
	qa_terminology_examples:
		"正式藥名保留英文,通用名稱可譯;縮寫首次出現後括號展開",
	qa_mc_bad_example: "下列何者為 X 的最常見副作用?",
	qa_mc_good_example: "X 常見的副作用有哪些?",
} as const;

function aiVar(env: Env, key: keyof typeof AI_DEFAULTS): string {
	// env keys are AI_<SCREAMING_SNAKE_CASE> versions of the config field.
	const envKey = `AI_${key.toUpperCase()}` as keyof Env;
	const v = env[envKey];
	const value = typeof v === "string" ? v.trim() : "";
	return value || AI_DEFAULTS[key];
}

function formatExampleList(raw: string): string {
	// Accept "a;b;c" or "a,b,c". Each item is quoted with full-width 「」
	// so it reads as a natural Chinese example list inside the prompt.
	const items = raw
		.split(/[;；,，]/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (items.length === 0) return "";
	return items.map((s) => `「${s}」`).join("");
}

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

// Concise zh-TW explanation of a selected lecture-slide fragment
// (powers the PDF reader's text-selection popup → "AI 解釋").
aiRoutes.post("/explain-selection", async (c) => {
	const body = await c.req.json<{ text: string }>();
	if (!body.text || body.text.length < 10) {
		return c.json({ error: "text too short" }, 400);
	}

	const out = await c.env.AI.run(TEXT_MODEL, {
		messages: [
			{
				role: "system",
				content:
					"你是醫學教學助手。請用繁體中文簡潔解釋以下投影片片段的重點,2-4 句,必要時補充臨床意義。只輸出解釋,不要重述原文。",
			},
			{ role: "user", content: body.text.slice(0, 4000) },
		],
	});

	return c.json({ text: (out as any).response });
});

// Generate a curated study Q&A list from a question and its explanation.
// The frontend renders this as numbered questions with bullet answers.
aiRoutes.post("/generate-qa", async (c) => {
	const body = await c.req.json<{
		stem: string;
		options: Record<string, string>;
		answer: string;
		tags?: string[];
		explanation: string;
	}>();
	const explanation = (body.explanation || "").trim();
	if (explanation.length < 80) {
		return c.json({ error: "text too short" }, 400);
	}

	const out = await c.env.AI.run(TEXT_MODEL, {
		max_tokens: 1200,
		temperature: 0.2,
		response_format: {
			type: "json_schema",
			json_schema: {
				type: "object",
				properties: {
					items: {
						type: "array",
						minItems: 4,
						maxItems: 6,
						items: {
							type: "object",
							properties: {
								question: { type: "string" },
								answer: {
									type: "array",
									minItems: 1,
									maxItems: 3,
									items: { type: "string" },
								},
							},
							required: ["question", "answer"],
							additionalProperties: false,
						},
					},
				},
				required: ["items"],
				additionalProperties: false,
			},
		},
		messages: [
			{
				role: "system",
				content: buildQaSystemPrompt(c.env),
			},
			{ role: "user", content: buildQaPrompt(body).slice(0, 5000) },
		],
	});

	const rawResponse = (out as any).response ?? out ?? "";
	const items = parseGeneratedQaItems(rawResponse);
	if (items.length === 0) {
		return c.json({ error: "could not parse generated QA" }, 502);
	}

	return c.json({ items });
});

function buildQaPrompt(body: {
	stem: string;
	options: Record<string, string>;
	answer: string;
	tags?: string[];
	explanation: string;
}): string {
	const tags = body.tags?.length ? body.tags.join(", ") : "無";

	return [
		`標籤:\n${tags}`,
		"以下是考點資料,請只根據這段資料設計概念性簡答題。不要重建或改寫原始選擇題題幹。",
		body.explanation,
	].join("\n\n");
}

function buildQaSystemPrompt(env: Env): string {
	const spec = aiVar(env, "specialty_zh");
	const qaExamples = formatExampleList(aiVar(env, "qa_question_examples"));
	const termExamples = aiVar(env, "qa_terminology_examples");
	const mcBad = aiVar(env, "qa_mc_bad_example");
	const mcGood = aiVar(env, "qa_mc_good_example");

	return [
		`你是${spec}國考考官,正在設計給考生作答的簡答題,不是選擇題。任務是根據詳解整理出醫學複習書風格的「考官問答」。`,
		"規則:用台灣繁體中文;必要醫學名詞、藥名、基因、縮寫保留英文;只寫輸入內容支持或標準醫學知識可直接支持的重點,不確定就不要寫;",
		`不要硬翻英文醫學詞或做半中半英混搭;例如 ${termExamples}。`,
		"產出 4-6 題高價值簡答題,依學習價值排序。每一題都要像考官問考生:「什麼是...」「如何...」「為什麼...」「請列舉...」「臨床上如何使用...」。",
		qaExamples ? `問題範例風格:${qaExamples}。` : "",
		"問題必須自足、精準、可考,每題測一個核心概念,避免連續題目重複同一主詞;涵蓋診斷判讀、機轉、治療、鑑別或易混淆點。",
		"question 欄位必須是問句,必須以 ? 或 ？ 結尾,不可只是陳述句。",
		"絕對不要產生選擇題題幹。不可問「下列何者」、不可問「哪一項敘述」、不可問「何者正確/錯誤」、不可提選項字母、不可寫「本題答案是」。",
		`如果原始資料是選擇題,要把它抽象成概念性簡答題;例如不要問「${mcBad}」,要改問「${mcGood}」。`,
		"答案像簡答題標準答案:用 1-3 個短 bullet,先給核心結論再補必要細節,每個 bullet 必須是完整句或完整片語,不可只放單字清單,盡量 30-80 字;不要前言、免責或 Markdown。",
		'只回傳合法 JSON,格式:{"items":[{"question":"...","answer":["...","..."]}]}',
	]
		.filter(Boolean)
		.join("");
}

function buildSuggestTagsSystemPrompt(env: Env): string {
	const spec = aiVar(env, "specialty_zh");
	const specEn = aiVar(env, "specialty_en_long");
	const disease = aiVar(env, "tag_disease_examples");
	const topic = aiVar(env, "tag_topic_examples");

	return [
		`你是${spec}科考題標籤助手。題目皆屬${spec}領域 (${specEn})。`,
		'看到題幹後回傳一個 JSON: {"tags":["<tag1>","<tag2>","<tag3>"]}。',
		`tag 風格:疾病用慣用縮寫 (${disease}),其他用繁體中文 (${topic})。`,
		"盡量 2-5 個標籤,不要過多,不要解釋,只回 JSON。",
	].join("");
}

function parseGeneratedQaItems(raw: unknown): GeneratedQaItem[] {
	const parsed = parseJsonObject(raw);
	const candidates = Array.isArray(parsed)
		? parsed
		: Array.isArray(parsed?.items)
			? parsed.items
			: parsePartialGeneratedQaItems(raw);

	return candidates
		.map((item: any) => {
			const question =
				typeof item?.question === "string" ? item.question.trim() : "";
			const rawAnswer = item?.answer;
			const answer = Array.isArray(rawAnswer)
				? rawAnswer
						.filter((line: unknown): line is string => typeof line === "string")
						.map((line: string) => cleanBullet(line))
						.filter(Boolean)
						.slice(0, 3)
				: typeof rawAnswer === "string"
					? splitAnswerBullets(rawAnswer)
					: [];
			return { question, answer };
		})
		.filter(
			(item: GeneratedQaItem) =>
				item.question &&
				item.answer.length > 0 &&
				looksLikeShortAnswerQuestion(item.question) &&
				!looksLikeMultipleChoiceQuestion(item.question),
		)
		.slice(0, 6);
}

function looksLikeShortAnswerQuestion(question: string): boolean {
	return /[?？]\s*$/.test(question);
}

function looksLikeMultipleChoiceQuestion(question: string): boolean {
	return /(?:下列|何者|哪一項|哪項|何項|選項|敘述).{0,12}(?:正確|錯誤|不正確|最適當|最不適當|為是|為非)|(?:正確|錯誤|不正確).{0,8}(?:敘述|選項)|本題|答案是|^[A-E][.)、]/.test(
		question,
	);
}

function parseJsonObject(raw: unknown): any | null {
	if (raw && typeof raw === "object") return raw;
	if (typeof raw !== "string") return null;
	const cleaned = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "");
	try {
		return JSON.parse(cleaned);
	} catch {
		const match = cleaned.match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
}

function parsePartialGeneratedQaItems(raw: unknown): unknown[] {
	if (typeof raw !== "string") return [];
	const match = raw.match(/"items"\s*:\s*\[/);
	if (!match || match.index === undefined) return [];
	const start = raw.indexOf("[", match.index);
	if (start < 0) return [];

	const items: unknown[] = [];
	let depth = 0;
	let objectStart = -1;
	let inString = false;
	let escaped = false;
	for (let i = start + 1; i < raw.length; i += 1) {
		const ch = raw[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = inString;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") {
			if (depth === 0) objectStart = i;
			depth += 1;
			continue;
		}
		if (ch === "}") {
			depth -= 1;
			if (depth === 0 && objectStart >= 0) {
				try {
					items.push(JSON.parse(raw.slice(objectStart, i + 1)));
				} catch {
					// Keep scanning; a later complete object may still parse.
				}
				objectStart = -1;
			}
		}
	}
	return items;
}

function splitAnswerBullets(answer: string): string[] {
	return answer
		.split(/\n+/)
		.map(cleanBullet)
		.filter(Boolean)
		.slice(0, 3);
}

function cleanBullet(line: string): string {
	return line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
}

// Suggest specialty-specific tags for a question stem. Wording is driven
// by [ai] in config.toml so a fork can swap the medical specialty without
// editing this file. Returns { tags: string[] } — free-form, English
// abbreviations / 繁體中文 topic words.
aiRoutes.post("/suggest-tags", async (c) => {
	const body = await c.req.json<{ stem: string }>();

	const out = await c.env.AI.run(TEXT_MODEL, {
		messages: [
			{
				role: "system",
				content: buildSuggestTagsSystemPrompt(c.env),
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
