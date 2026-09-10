/**
 * 跑台模組(smear station)—— 一個病人、多張片子、逐步揭露。
 *
 * 設計:docs/plans/2026-09-09-smear-station-design.md
 *
 * 跟 `/smear/review`、`/smear/exam` 的關係:第三條路,只有一種節奏。
 * 不計時、不交卷、沒有 session —— 全真的價值建立在交卷前什麼都不揭曉,
 * 而這裡的核心迴圈是「一張一張看完、寫下、最後一次全部攤開」,兩者衝突。
 *
 * ⚠️ **洩題面只有一個點,但它比單張題容易漏。**
 * 單張題的正解是一個詞;案例的答案散在 `reveal_note`(逐張)與
 * `discussion_json`(整案)。這兩個欄位在 POST /answer 之前**一次都不能出現
 * 在任何回應裡**。GET /cases/:id 回的是病史 + 全部圖的 key + 清乾淨的
 * caption,就這樣。
 *
 * ⚠️ **圖一次全給是刻意的。** 既然中途不回饋,就不需要一步一趟;少一支端點
 * 就少一個洩題面。洩的是文字不是圖 —— 知道這案有五張圖、其中一張是骨髓,
 * 是合理的線索不是答案。
 */

import { Hono } from "hono";
import type { AppContext } from "../types";
import { uuid } from "../lib/db";
import { gradeSmear, type AcceptedTerm } from "../lib/smear-grade";
import { pickCorrectOptionLabel } from "../lib/smear-mcq";

export const smearStationRoutes = new Hono<AppContext>();

type CaseRow = {
	id: string;
	dx_id: string;
	history_md: string | null;
	discussion_json: string | null;
	source: string;
	source_ref: string | null;
	attribution: string | null;
};
type ItemRow = {
	idx: number;
	modality: string;
	image_key_view: string;
	image_key_full: string;
	caption: string | null;
	reveal_note: string | null;
};

// ---------------------------------------------------------------------------
// GET /station/cases —— 清單
// ---------------------------------------------------------------------------
smearStationRoutes.get("/station/cases", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT sc.id, sc.source, sc.history_md,
            (SELECT COUNT(*) FROM smear_case_items i WHERE i.case_id = sc.id) AS steps,
            (SELECT group_concat(DISTINCT i.modality) FROM smear_case_items i WHERE i.case_id = sc.id) AS modalities,
            (SELECT COUNT(*) FROM smear_case_attempts a WHERE a.case_id = sc.id AND a.user_email = ?) AS my_attempts,
            (SELECT a.tier FROM smear_case_attempts a WHERE a.case_id = sc.id AND a.user_email = ?
              ORDER BY a.created_at DESC LIMIT 1) AS last_tier
       FROM smear_cases sc
      ORDER BY sc.source, sc.id`,
	)
		// ⚠️ 兩個 ? 都是 user_email,綁的變數名字裡要有 email —— worker/lib/bind-order.ts 會掃。
		.bind(email, email)
		.all<{
			id: string;
			source: string;
			history_md: string | null;
			steps: number;
			modalities: string | null;
			my_attempts: number;
			last_tier: string | null;
		}>();

	return c.json({
		cases: (results ?? []).map((r) => ({
			id: r.id,
			source: r.source,
			steps: r.steps,
			// 病史的第一行當清單上的標題。⚠️ 不用投影片標題 —— 那是
			// 'Case 3: ALL vs. FL?',它含答案,所以 schema 裡根本沒有那個欄位。
			teaser: (r.history_md ?? "").split("\n")[0].slice(0, 60) || null,
			modalities: [...new Set((r.modalities ?? "").split(",").filter(Boolean))],
			my_attempts: r.my_attempts,
			last_tier: r.last_tier,
		})),
	});
});

// ---------------------------------------------------------------------------
// GET /station/cases/:id —— 開場:病史 + 全部圖。不含任何說明文字。
// ---------------------------------------------------------------------------
smearStationRoutes.get("/station/cases/:id", async (c) => {
	const id = c.req.param("id");
	const row = await c.env.DB.prepare(
		"SELECT id, dx_id, history_md, discussion_json, source, source_ref, attribution FROM smear_cases WHERE id = ?",
	)
		.bind(id)
		.first<CaseRow>();
	if (!row) return c.json({ error: "case not found" }, 404);

	const { results } = await c.env.DB.prepare(
		"SELECT idx, modality, image_key_view, image_key_full, caption, reveal_note FROM smear_case_items WHERE case_id = ? ORDER BY idx",
	)
		.bind(id)
		.all<ItemRow>();

	// ⚠️ 這裡逐欄挑出去,不是把 row 展開再 delete 兩個欄位。展開的寫法在加
	//    新欄位時會靜默把它一起送出去,而新欄位很可能就是下一段揭曉文字。
	return c.json({
		id: row.id,
		source: row.source,
		source_ref: row.source_ref,
		attribution: row.attribution,
		history_md: row.history_md,
		steps: (results ?? []).map((i) => ({
			idx: i.idx,
			modality: i.modality.split(",").filter(Boolean),
			// 回原始 R2 key,不是 /img/ 開頭的 URL —— 前端的 SmearImage 自己
			// 加前綴,兩處都加的話就是 /img//img/...
			image_key_view: i.image_key_view,
			image_key_full: i.image_key_full,
			caption: i.caption,
		})),
	});
});

// ---------------------------------------------------------------------------
// POST /station/cases/:id/answer —— 判定 + 一次揭曉全部
// ---------------------------------------------------------------------------
smearStationRoutes.post("/station/cases/:id/answer", async (c) => {
	const email = c.var.email;
	const id = c.req.param("id");
	const body = await c.req
		.json<{ typed?: string; notes?: Record<string, string>; steps_seen?: number }>()
		.catch(() => ({}) as Record<string, never>);

	const row = await c.env.DB.prepare(
		"SELECT id, dx_id, history_md, discussion_json, source, source_ref, attribution FROM smear_cases WHERE id = ?",
	)
		.bind(id)
		.first<CaseRow>();
	if (!row) return c.json({ error: "case not found" }, 404);

	// ⚠️ 要 form 這個欄位,不只是 text/tier —— 顯示正解走 pickCorrectOptionLabel(),
	//    它靠 form 挑「長寫法」。少了它,APL 那案的正解會顯示成 `APML`(詞表裡
	//    第一個 full 剛好是縮寫),而使用者看到的是一個他沒學過的縮寫。
	//    CLAUDE.md 的 #234 critical bug 講的就是這條:canonical_long 有 18% 帶
	//    括號補充,直接送進判定會是 miss,所以正解一律走這支。
	const { results: termRows } = await c.env.DB.prepare(
		"SELECT text, tier, form FROM smear_terms WHERE dx_id = ? AND status = 'accepted'",
	)
		.bind(row.dx_id)
		.all<AcceptedTerm & { form: string }>();
	const terms = (termRows ?? []) as (AcceptedTerm & { form: string })[];

	// 判定沿用單張題那一支,一個字都沒改 —— 「一個病人」跟「一張圖」都是那個
	// 診斷的一個實例,所以答案的判準沒有理由不同。
	const grade = gradeSmear([body.typed ?? ""], terms);
	const canonicalLabel = pickCorrectOptionLabel(terms, grade.canonical ?? row.dx_id);

	const { results: items } = await c.env.DB.prepare(
		"SELECT idx, modality, image_key_view, image_key_full, caption, reveal_note FROM smear_case_items WHERE case_id = ? ORDER BY idx",
	)
		.bind(id)
		.all<ItemRow>();

	const now = Date.now();
	const stepsSeen = Number.isFinite(Number(body.steps_seen))
		? Math.max(0, Math.min(99, Math.floor(Number(body.steps_seen))))
		: null;
	await c.env.DB.prepare(
		`INSERT INTO smear_case_attempts (id, user_email, case_id, notes_json, final_typed, tier, score, steps_seen, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			uuid(),
			email,
			id,
			body.notes ? JSON.stringify(body.notes) : null,
			body.typed ?? null,
			grade.tier,
			grade.score,
			stepsSeen,
			now,
		)
		.run();

	let discussion: string[] | null = null;
	if (row.discussion_json) {
		try {
			discussion = JSON.parse(row.discussion_json) as string[];
		} catch {
			discussion = null;
		}
	}

	return c.json({
		tier: grade.tier,
		score: grade.score,
		matched: grade.matched,
		canonical: canonicalLabel,
		spellingErrors: grade.spellingErrors,
		dx_id: row.dx_id,
		discussion,
		reveals: (items ?? []).map((i) => ({ idx: i.idx, reveal_note: i.reveal_note })),
	});
});

// ---------------------------------------------------------------------------
// GET /station/attempts —— 我跑過哪些案(錯題本用同一個 dx 單位)
// ---------------------------------------------------------------------------
smearStationRoutes.get("/station/attempts", async (c) => {
	const email = c.var.email;
	const { results } = await c.env.DB.prepare(
		`SELECT a.case_id, a.tier, a.score, a.steps_seen, a.created_at, sc.dx_id, sd.canonical_long
       FROM smear_case_attempts a
       JOIN smear_cases sc ON sc.id = a.case_id
       JOIN smear_dx sd ON sd.id = sc.dx_id
      WHERE a.user_email = ?
      ORDER BY a.created_at DESC
      LIMIT 100`,
	)
		.bind(email)
		.all();
	return c.json({ attempts: results ?? [] });
});
