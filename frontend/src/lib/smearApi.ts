// Typed wrappers over /api/smear/*. Reuses the shared `api` fetch helper —
// do not introduce a second fetch layer here.
//
// Session/answer UI (D3) extended this file with fetchSmearSession /
// submitSmearAnswer / finishSmearSession. Later tasks (history, wrong-list,
// search, result page) should keep extending this file rather than
// hand-rolling fetch calls in components — same convention as lectureApi.ts.
import { api } from "./api";

export type SmearMode = "review" | "exam";
export type SmearForm = "long" | "abbrev" | "any";
export type SmearTier = "full" | "half" | "lay";

export interface SmearMeta {
	dxCount: number;
	topicWeights: Record<string, number>;
	sourceCounts: Record<string, number>;
	topics: string[];
}

// 主題標籤集中在這裡,StartDialog 與 SmearSession 都要用 —— 各寫一份的話,
// 加一個新主題會有一邊忘記改,症狀是「某個主題永遠顯示英文 slug」。
export const SMEAR_TOPIC_LABELS: Record<string, string> = {
	myeloid: "骨髓性",
	lymphoid: "淋巴性",
	normal_reactive: "正常 / 反應性",
	rbc: "紅血球系",
	platelet: "血小板 / 巨核系",
	infection: "感染相關",
	other: "其他",
};

export interface SmearSessionStart {
	id: string;
	// Opaque `#idx` tokens in exam mode until reveal — see worker/routes/smear.ts
	// clientQuestionId(). Real ids in review mode.
	question_ids: string[];
}

export function fetchSmearMeta(): Promise<SmearMeta> {
	return api.get<SmearMeta>("/api/smear/meta");
}

export function createSmearSession(body: {
	mode: SmearMode;
	n: number;
	form: SmearForm;
	topics: string[];
	sources: string[];
}): Promise<SmearSessionStart> {
	return api.post<SmearSessionStart>("/api/smear/sessions", body);
}

// ---------------------------------------------------------------------------
// GET /api/smear/sessions/:id
//
// ⚠️ `id` on each question is an OPAQUE token in exam mode until reveal
// (`#idx`, not a real smear_questions.id) — treat it as an opaque string
// throughout, never parse it, and pass it back verbatim to /answer. Same for
// `dx_id`/`my_tier`/`my_score`: they are only present when mode==='review' or
// the session is finished (gated server-side in worker/routes/smear.ts's
// `revealGrade`). Do not add client-side fallbacks for these fields — their
// absence pre-reveal is load-bearing, not an oversight.
// ---------------------------------------------------------------------------
export interface SmearSessionQuestion {
	id: string;
	dx_id?: string;
	source: string;
	image_key_view: string;
	image_key_full: string;
	prompt: string | null;
	image_note: string | null;
	topic: string;
	qtype: string;
	answered: boolean;
	my_tier?: SmearTier | "miss";
	my_score?: number;
}

export interface SmearSessionConfig {
	mode?: SmearMode;
	n?: number;
	form?: SmearForm;
	topics?: string[];
	sources?: string[];
	limitSec?: number;
}

export interface SmearSessionDetail {
	id: string;
	mode: SmearMode;
	config: SmearSessionConfig | null;
	started_at: number;
	finished_at: number | null;
	questions: SmearSessionQuestion[];
}

export function fetchSmearSession(id: string): Promise<SmearSessionDetail> {
	return api.get<SmearSessionDetail>(`/api/smear/sessions/${id}`);
}

// ---------------------------------------------------------------------------
// POST /api/smear/sessions/:id/answer
//
// `boxes` is always a single-element array — see the design note in
// SmearSession.tsx for why one free-text input replaces N per-word boxes.
// gradeSmear() joins boxes with a space server-side regardless of length, so
// this produces identical grading to N boxes without leaking the answer's
// word count to the client before it answers.
//
// Review mode gets the full graded result back immediately; exam mode gets
// only `{ok:true}` — the grade is computed and stored server-side but
// withheld from the client until POST /finish. Never assume the richer shape
// is available in exam mode.
// ---------------------------------------------------------------------------
export interface SmearAcceptedTerm {
	text: string;
	tier: SmearTier;
}

export interface SmearSpellingError {
	typed: string;
	expected: string;
}

export interface SmearGradeResponse {
	tier: SmearTier | "miss";
	score: number;
	matched: string | null;
	canonical: string | null;
	spellingErrors: SmearSpellingError[];
	acceptedTerms: SmearAcceptedTerm[];
}

export interface SmearAnswerAck {
	ok: true;
}

export function submitSmearAnswer(
	sessionId: string,
	questionId: string,
	boxes: string[],
	hintUsed?: string,
): Promise<SmearGradeResponse | SmearAnswerAck> {
	return api.post(`/api/smear/sessions/${sessionId}/answer`, {
		questionId,
		boxes,
		hintUsed,
	});
}

// ---------------------------------------------------------------------------
// POST /api/smear/sessions/:id/finish
// ---------------------------------------------------------------------------
export interface SmearFinishBreakdownRow {
	question_id: string;
	dx_id: string | null;
	canonical_long: string | null;
	topic: string | null;
	typed: unknown[];
	tier: SmearTier | "miss";
	score: number;
	spelling_errors: unknown[];
}

export interface SmearFinishResult {
	score: number;
	max_score: number;
	spelling_ok: number;
	lay_count: number;
	question_count: number;
	breakdown: SmearFinishBreakdownRow[];
}

export function finishSmearSession(sessionId: string): Promise<SmearFinishResult> {
	return api.post<SmearFinishResult>(`/api/smear/sessions/${sessionId}/finish`);
}
