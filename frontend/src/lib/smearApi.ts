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

// qtype 標籤,同上 —— dx 詳情頁與搜尋結果都要顯示,集中一份避免漂移。
export const SMEAR_QTYPE_LABELS: Record<string, string> = {
	cell: "細胞辨識",
	disease: "疾病診斷",
};

// 模式標籤,同上 —— SmearSession/StartDialog 原本各自寫一份三元運算,D4 的
// 結果頁 + 作答記錄再各加一份就是第三、第四份,集中在這裡供之後的呼叫端沿用。
export const SMEAR_MODE_LABELS: Record<SmearMode, string> = {
	review: "複習模式",
	exam: "全真模式",
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

// ---------------------------------------------------------------------------
// GET /api/smear/dx/:id —— 診斷詳情(D5)
//
// `note.content_json` 是原樣字串(同 /api/questions/:id 的 explanation 慣例),
// 呼叫端自己 JSON.parse() 再餵給 StaticContent。`terms` 只含 status='accepted'
// 的列 —— 提報中的詞不會出現在這裡,提報成功後由呼叫端把回應裡的 term 加進
// 本地 state 顯示,見 SmearDx.tsx。
// ---------------------------------------------------------------------------
export interface SmearDxNote {
	dx_id: string;
	content_json: string;
	related_dx_ids: string | null;
	version: number;
	updated_by: string | null;
	updated_at: number;
}

export interface SmearAcceptedTermFull {
	id: string;
	text: string;
	tier: SmearTier;
	form: "long" | "abbrev";
}

export interface SmearDxQuestionImage {
	id: string;
	source: string;
	source_ref: string | null;
	source_url: string | null;
	attribution: string | null;
	image_key_view: string;
	image_key_full: string;
	prompt: string | null;
	image_note: string | null;
}

export interface SmearRelatedDx {
	dx_id: string;
	canonical_long: string;
}

export interface SmearDxDetail {
	id: string;
	canonical_long: string;
	canonical_abbrev: string | null;
	topic: string;
	qtype: string;
	created_at: number;
	note: SmearDxNote | null;
	terms: SmearAcceptedTermFull[];
	questions: SmearDxQuestionImage[];
	related: SmearRelatedDx[];
}

export function fetchSmearDx(id: string): Promise<SmearDxDetail> {
	return api.get<SmearDxDetail>(`/api/smear/dx/${id}`);
}

// ---------------------------------------------------------------------------
// GET /api/smear/search?q= —— 獨立索引(D6),語法規則同 lib/fts-query.ts
// ---------------------------------------------------------------------------
export interface SmearSearchHit {
	dx_id: string;
	canonical_long: string;
	topic: string;
	qtype: string;
}

export function searchSmear(q: string): Promise<{ items: SmearSearchHit[]; q: string }> {
	return api.get(`/api/smear/search?q=${encodeURIComponent(q)}`);
}

// ---------------------------------------------------------------------------
// 提報/投票(C2)—— POST /api/smear/dx/:id/terms、
// POST|DELETE /api/smear/terms/:tid/votes
// ---------------------------------------------------------------------------
export type SmearProposalStatus = "open" | "accepted" | "rejected";

export interface SmearProposedTerm {
	id: string;
	dx_id: string;
	text: string;
	norm: string;
	tier: SmearTier;
	form: "long" | "abbrev";
	status: SmearProposalStatus;
	rationale: string | null;
	proposed_by: string | null;
	created_at: number;
	resolved_at: number | null;
}

export function proposeSmearTerm(
	dxId: string,
	body: { text: string; tier: SmearTier; form: "long" | "abbrev"; rationale?: string },
): Promise<{ term: SmearProposedTerm }> {
	return api.post(`/api/smear/dx/${dxId}/terms`, body);
}

export interface SmearVoteTally {
	agree: number;
	disagree: number;
}

export interface SmearVoteResponse {
	term: SmearProposedTerm;
	tally: SmearVoteTally;
	justResolved: boolean;
}

export function voteSmearTerm(termId: string, agree: boolean): Promise<SmearVoteResponse> {
	return api.post(`/api/smear/terms/${termId}/votes`, { agree });
}

export function retractSmearTermVote(termId: string): Promise<SmearVoteResponse> {
	return api.del(`/api/smear/terms/${termId}/votes`);
}

// ---------------------------------------------------------------------------
// GET /api/smear/sessions —— 作答記錄(D4)
//
// ⚠️ `finished_at`/`score`/`max_score` 是 `null` 表示這場全真模式還沒交卷 ——
// 見 worker/routes/smear.ts 的說明,那是刻意的安全模型(判定要到 /finish 才
// 揭曉)。呼叫端一律用 `finished_at == null` 判斷「要不要顯示成績」,不要用
// `score == null`(0 分是合法的已完成成績,不能拿它當「未完成」的判準)。
// ---------------------------------------------------------------------------
export interface SmearHistoryItem {
	id: string;
	mode: SmearMode;
	started_at: number;
	finished_at: number | null;
	score: number | null;
	max_score: number | null;
	question_count: number;
}

export function fetchSmearSessions(): Promise<{ items: SmearHistoryItem[] }> {
	return api.get("/api/smear/sessions");
}

// ---------------------------------------------------------------------------
// GET /api/smear/wrong —— 錯題本(D4),按診斷聚合、worst-first
// ---------------------------------------------------------------------------
export interface SmearWrongItem {
	dx_id: string;
	canonical_long: string;
	topic: string;
	wrong_count: number;
	last_wrong_at: number | null;
}

export function fetchSmearWrong(): Promise<{ items: SmearWrongItem[] }> {
	return api.get("/api/smear/wrong");
}

// ---------------------------------------------------------------------------
// GET /api/smear/topic-stats —— 按主題聚合的整體正確率 + 上次練習時間,
// 供 /smear/review 的主題卡片使用。`score`/`attempts` 兩個數字自己算
// 正確率(score/attempts),不在後端先算成 %——跟 SmearResult.tsx 的
// topicStats 是同一種「回傳原始數字,顯示端自己算比例」的分工。
// ---------------------------------------------------------------------------
export interface SmearTopicStat {
	topic: string;
	score: number;
	attempts: number;
	last_answered_at: number | null;
}

export function fetchSmearTopicStats(): Promise<{ items: SmearTopicStat[] }> {
	return api.get("/api/smear/topic-stats");
}

// ---------------------------------------------------------------------------
// 收藏 —— POST|DELETE /api/smear/dx/:id/bookmark、GET /api/smear/bookmarks
//
// GET /api/smear/dx/:id 不回 `bookmarked` 欄位(worker/routes/smear.ts 沒有這個
// 需求),所以「這個 dx 有沒有被我收藏」是用 GET /bookmarks 的清單反查 ——
// 見 SmearDx.tsx。這是前端獨有的判斷方式,不是後端漏欄位。
// ---------------------------------------------------------------------------
export interface SmearBookmarkItem {
	dx_id: string;
	created_at: number;
	canonical_long: string;
	canonical_abbrev: string | null;
	topic: string;
	qtype: string;
}

export function fetchSmearBookmarks(): Promise<{ items: SmearBookmarkItem[] }> {
	return api.get("/api/smear/bookmarks");
}

export function bookmarkSmearDx(dxId: string): Promise<{ ok: true; bookmarked: true }> {
	return api.post(`/api/smear/dx/${dxId}/bookmark`);
}

export function unbookmarkSmearDx(dxId: string): Promise<{ ok: true; bookmarked: false }> {
	return api.del(`/api/smear/dx/${dxId}/bookmark`);
}

// ---------------------------------------------------------------------------
// 個人筆記 —— GET|POST /api/smear/dx/:id/notes、PUT|DELETE /api/smear/notes/:id
//
// `content_json` 原樣以字串來回(同 explanation/comments 的慣例),呼叫端自己
// JSON.parse() 餵給 StaticContent / RichEditor。
// ---------------------------------------------------------------------------
export interface SmearNote {
	id: string;
	dx_id: string;
	content_json: string;
	sort_order: number;
	created_at: number;
	updated_at: number;
}

export function fetchSmearNotes(dxId: string): Promise<{ items: SmearNote[] }> {
	return api.get(`/api/smear/dx/${dxId}/notes`);
}

export function createSmearNote(
	dxId: string,
	contentJson: unknown,
): Promise<SmearNote> {
	return api.post(`/api/smear/dx/${dxId}/notes`, { content_json: contentJson });
}

export function updateSmearNote(
	noteId: string,
	contentJson: unknown,
): Promise<{ ok: true }> {
	return api.put(`/api/smear/notes/${noteId}`, { content_json: contentJson });
}

export function deleteSmearNote(noteId: string): Promise<{ ok: true }> {
	return api.del(`/api/smear/notes/${noteId}`);
}

// ---------------------------------------------------------------------------
// 討論 —— GET|POST /api/smear/dx/:id/comments、DELETE /api/smear/comments/:id
//
// 扁平清單(同 comments.ts 的既有慣例),呼叫端自己用 parent_id 建樹 ——
// 見 components/smear/SmearCommentThread.tsx。v1 沒有 @mention/helpful 投票,
// 也沒有編輯,只有發表/回覆/刪除(作者本人或 admin)。
// ---------------------------------------------------------------------------
export interface SmearComment {
	id: string;
	dx_id: string;
	parent_id: string | null;
	author_email: string;
	content_json: string;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	display_name: string | null;
	avatar_key: string | null;
}

export function fetchSmearComments(dxId: string): Promise<SmearComment[]> {
	return api.get(`/api/smear/dx/${dxId}/comments`);
}

export function postSmearComment(
	dxId: string,
	body: { content_json: unknown; parent_id?: string },
): Promise<SmearComment> {
	return api.post(`/api/smear/dx/${dxId}/comments`, body);
}

export function deleteSmearComment(commentId: string): Promise<{ ok: true }> {
	return api.del(`/api/smear/comments/${commentId}`);
}

// ---------------------------------------------------------------------------
// 投稿 —— POST /api/smear/submissions(multipart)、GET .../mine、
// GET .../pending(admin)、POST .../:id/approve|reject(admin)。見
// worker/routes/smear-community.ts 檔尾那一段的設計說明:核准前對其他
// 非本人/非 admin 使用者完全不可見,也不進任何抽題池。
// ---------------------------------------------------------------------------
export type SmearSubmissionStatus = "pending" | "approved" | "rejected";

// `proposed_answer` 已被伺服器 SUBSTR 到 200 字(見 GET /submissions/mine),
// 呼叫端不需要、也不應該再自己截一次。
export interface SmearSubmissionMineItem {
	id: string;
	proposed_answer: string;
	status: SmearSubmissionStatus;
	created_at: number;
	reviewed_at: number | null;
	review_note: string | null;
}

export function fetchMySmearSubmissions(): Promise<{
	items: SmearSubmissionMineItem[];
}> {
	return api.get("/api/smear/submissions/mine");
}

// `suggestedDxId`/`suggestedCanonical` 是伺服器用 normalizeTerm() 對現有
// accepted 詞比對出來的建議,**永遠不會自動套用**——approve 一律要求呼叫端
// 明確帶 dxId。null 代表沒有可信的比對,不是「還沒算完」。
export interface SmearSubmissionPendingItem {
	id: string;
	user_email: string;
	image_key: string;
	proposed_answer: string;
	explanation_text: string | null;
	created_at: number;
	suggestedDxId: string | null;
	suggestedCanonical: string | null;
}

export function fetchPendingSmearSubmissions(): Promise<{
	items: SmearSubmissionPendingItem[];
}> {
	return api.get("/api/smear/submissions/pending");
}

export interface SmearSubmissionAck {
	id: string;
	status: "pending";
}

// 圖片 + 建議答案(必填)+ 文字說明(選填)。走 multipart,同 worker/lib/
// upload-validate.ts 的型別/大小限制 —— 呼叫端的檢查只是 UX,伺服器才是
// 真正的邊界(見 SubmissionForm.tsx 的檔頭說明)。
export function submitSmearSubmission(input: {
	image: File;
	proposedAnswer: string;
	explanationText?: string;
}): Promise<SmearSubmissionAck> {
	const fd = new FormData();
	fd.append("image", input.image);
	fd.append("proposedAnswer", input.proposedAnswer);
	if (input.explanationText) fd.append("explanationText", input.explanationText);
	return api.postForm("/api/smear/submissions", fd);
}

export function approveSmearSubmission(
	id: string,
	dxId: string,
): Promise<{ ok: true; questionId: string }> {
	return api.post(`/api/smear/submissions/${id}/approve`, { dxId });
}

export function rejectSmearSubmission(
	id: string,
	reviewNote?: string,
): Promise<{ ok: true }> {
	return api.post(`/api/smear/submissions/${id}/reject`, { reviewNote });
}
