import { Hono } from "hono";
import type { AppContext } from "../types";
import { pickInterleaved, type DrillHit } from "../lib/drill";
import { optionsToRecord } from "../lib/db";

// Embedding model — mirrors routes/ai.ts + routes/questions.ts (768-dim BGE).
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export const drillRoutes = new Hono<AppContext>();

// GET /api/drill/interleave?anchor=<id>&n=5
// Semantic neighbors of the anchor, round-robined across exam years into an
// interleaved practice set. Years come from D1 (source of truth), not the
// vector metadata. Degrades to an empty set if the index isn't populated.
drillRoutes.get("/interleave", async (c) => {
	const anchor = c.req.query("anchor");
	const n = Math.min(parseInt(c.req.query("n") || "5"), 15);
	if (!anchor) return c.json({ error: "anchor required" }, 400);

	const self = await c.env.DB.prepare("SELECT id, stem FROM questions WHERE id = ?")
		.bind(anchor)
		.first<{ id: string; stem: string }>();
	if (!self) return c.json({ error: "no such question" }, 404);

	// Semantic candidate ids (relevance order), anchor excluded. Best-effort.
	let candidateIds: string[] = [];
	try {
		const emb = await c.env.AI.run(EMBED_MODEL, { text: [self.stem] });
		const vector = (emb as { data: number[][] }).data[0];
		const res = await c.env.VEC.query(vector, { topK: n * 3 });
		candidateIds = (res.matches ?? []).map((m) => m.id).filter((id) => id !== anchor);
	} catch {
		candidateIds = [];
	}
	if (candidateIds.length === 0) return c.json({ anchor, questions: [] });

	// Load year + card fields for the candidates in one query.
	const ph = candidateIds.map(() => "?").join(",");
	const { results } = await c.env.DB.prepare(
		`SELECT id, year, number, stem, options_json, "group"
     FROM questions WHERE id IN (${ph})`,
	)
		.bind(...candidateIds)
		.all<{
			id: string;
			year: number;
			number: number;
			stem: string;
			options_json: string;
			group: string | null;
		}>();
	const rowById = new Map(results.map((r) => [r.id, r]));

	// Build hits in vector-relevance order (skip ids missing from D1).
	const hits: DrillHit[] = [];
	for (const id of candidateIds) {
		const row = rowById.get(id);
		if (row) hits.push({ id, year: row.year });
	}

	const picked = pickInterleaved(hits, { anchor, n, seed: hashSeed(anchor) });
	const questions = picked
		.map((p) => rowById.get(p.id))
		.filter((r): r is NonNullable<typeof r> => Boolean(r))
		.map((r) => ({
			id: r.id,
			year: r.year,
			number: r.number,
			stem: r.stem,
			group: r.group,
			options: optionsToRecord(r.options_json),
		}));

	return c.json({ anchor, questions });
});

// FNV-1a — deterministic seed from the anchor id so the same anchor always
// produces the same interleaved order.
function hashSeed(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
