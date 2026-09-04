// Typed wrappers over /api/smear/*. Reuses the shared `api` fetch helper —
// do not introduce a second fetch layer here.
//
// This file only covers what the route-skeleton + start-dialog task needs
// (GET /meta, POST /sessions). Later tasks (session/answer UI, history,
// wrong-list, search) should extend this file rather than hand-rolling
// fetch calls in components — same convention as lectureApi.ts.
import { api } from "./api";

export type SmearMode = "review" | "exam";
export type SmearForm = "long" | "abbrev" | "any";

export interface SmearMeta {
	dxCount: number;
	topicWeights: Record<string, number>;
	sourceCounts: Record<string, number>;
	topics: string[];
}

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
