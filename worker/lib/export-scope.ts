// The shared "what am I exporting" vocabulary, plus the per-user SQL that
// turns a scope into a question-id list.
//
// PRIVACY INVARIANT — the single most important thing in this file:
//   scopeSql() ALWAYS binds the caller's email as params[0], for every kind,
//   and the email always comes from c.var.email (never from the request body).
// The public scopes (`year`, `ids`) have nothing user-specific to filter on,
// so they assert membership instead: `EXISTS (SELECT 1 FROM users WHERE
// email = ?)`. That keeps the invariant uniform — worker/lib/export-scope.
// test.ts asserts params[0] === email for every kind, so a new kind that
// forgets to bind the user fails the suite instead of leaking.
//
// Deliberate omission: there is no `search` kind. Duplicating the FTS query
// from worker/routes/search.ts here would mean two copies of a non-trivial
// ranking query drifting apart. The Search page instead sends the ids it is
// already showing as an `ids` scope.

export type ExportScope =
	| { kind: "folder"; folder_id: string | null } // null = 未分類
	| { kind: "bookmarks" }
	| { kind: "notes" }
	| { kind: "highlights" }
	| { kind: "wrong"; year?: number; group?: string; tags?: string[] }
	| { kind: "year"; year: number }
	| { kind: "exam"; session_id: string; only_wrong?: boolean }
	| { kind: "ids"; ids: string[]; label?: string };

// Hard cap. Free-plan Workers get 10 ms CPU per invocation; string assembly
// for 200 questions is comfortably inside that, 1000 is not.
import { parseTagList } from "./sql-params.ts";
import { WRONG_WHERE } from "./wrong-criterion.ts";

export const MAX_QUESTIONS = 200;

const MAX_LABEL = 60;

export type ParseResult =
	| { scope: ExportScope; truncated: boolean; error?: undefined }
	| { error: string; scope?: undefined; truncated?: undefined };

function intOf(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
	if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
	return null;
}

export function parseScope(body: unknown): ParseResult {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { error: "scope must be an object" };
	}
	const b = body as Record<string, unknown>;
	switch (b.kind) {
		case "folder": {
			if (!("folder_id" in b)) return { error: "folder_id required (null = 未分類)" };
			const id = b.folder_id;
			if (id !== null && typeof id !== "string") return { error: "folder_id must be string|null" };
			return { scope: { kind: "folder", folder_id: id }, truncated: false };
		}
		case "bookmarks":
			return { scope: { kind: "bookmarks" }, truncated: false };
		case "notes":
			return { scope: { kind: "notes" }, truncated: false };
		case "highlights":
			return { scope: { kind: "highlights" }, truncated: false };
		case "wrong": {
			const scope: ExportScope = { kind: "wrong" };
			if (b.year !== undefined && b.year !== null) {
				const y = intOf(b.year);
				if (y === null) return { error: "year must be an integer" };
				scope.year = y;
			}
			if (typeof b.group === "string" && b.group) scope.group = b.group;
			if (Array.isArray(b.tags)) {
				// Capped: these become `tag IN (?, ?, …)` further down, and an
				// unbounded list is one D1 "too many SQL variables" from a 500.
				const tags = parseTagList(
					b.tags.filter((t): t is string => typeof t === "string").join(","),
				);
				if (tags.length > 0) scope.tags = tags;
			}
			return { scope, truncated: false };
		}
		case "year": {
			const y = intOf(b.year);
			if (y === null) return { error: "year must be an integer" };
			return { scope: { kind: "year", year: y }, truncated: false };
		}
		case "exam": {
			if (typeof b.session_id !== "string" || !b.session_id) {
				return { error: "session_id required" };
			}
			const scope: ExportScope = { kind: "exam", session_id: b.session_id };
			if (b.only_wrong === true) scope.only_wrong = true;
			return { scope, truncated: false };
		}
		case "ids": {
			if (!Array.isArray(b.ids) || b.ids.length === 0) return { error: "ids required" };
			if (!b.ids.every((i) => typeof i === "string" && !!i)) {
				return { error: "ids must be non-empty strings" };
			}
			const unique = [...new Set(b.ids as string[])];
			const truncated = unique.length > MAX_QUESTIONS;
			const scope: ExportScope = { kind: "ids", ids: unique.slice(0, MAX_QUESTIONS) };
			if (typeof b.label === "string" && b.label.trim()) scope.label = b.label;
			return { scope, truncated };
		}
		default:
			return { error: `unknown scope kind: ${String(b.kind)}` };
	}
}

// Client-supplied text (the `ids` label) ends up in the file header and the
// download filename — collapse whitespace, drop control chars, cap length.
function cleanLabel(s: string): string {
	return s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, "").slice(0, MAX_LABEL);
}

export function scopeLabel(scope: ExportScope, folderName?: string | null): string {
	switch (scope.kind) {
		case "folder":
			return scope.folder_id === null ? "收藏・未分類" : `收藏・${folderName || "資料夾"}`;
		case "bookmarks":
			return "全部收藏";
		case "notes":
			return "我的筆記";
		case "highlights":
			return "我的畫記";
		case "wrong": {
			const q: string[] = [];
			if (scope.year !== undefined) q.push(`${scope.year} 年`);
			if (scope.group) q.push(scope.group);
			if (scope.tags?.length) q.push(scope.tags.join("/"));
			return q.length > 0 ? `錯題(${q.join("・")})` : "錯題";
		}
		case "year":
			return `${scope.year} 年`;
		case "exam":
			return scope.only_wrong ? "測驗結果(答錯的題)" : "測驗結果";
		case "ids":
			return scope.label ? cleanLabel(scope.label) : "自選題目";
	}
}

export function filenameFor(
	scope: ExportScope,
	ext: "md" | "csv" | "html",
	opts: { folderName?: string | null; now?: number } = {},
): string {
	const stamp = new Date((opts.now ?? Date.now()) + 8 * 3600_000).toISOString().slice(0, 10);
	const base = scopeLabel(scope, opts.folderName)
		.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
		.slice(0, MAX_LABEL);
	return `${base}-${stamp}.${ext}`;
}

// ------------------------------------------------------------------- SQL

export type ScopedSql = { sql: string; params: unknown[] };

// Public scopes have no per-user column to filter on; asserting the caller is
// a known user keeps params[0] === email true for every kind. The auth
// middleware upserts the users row before any route runs, so this always
// matches for a legitimately authenticated request.
const KNOWN_USER = "EXISTS (SELECT 1 FROM users u WHERE u.email = ?)";

const Q_ORDER = "ORDER BY q.year DESC, q.number ASC";

export function scopeSql(scope: ExportScope, email: string): ScopedSql {
	switch (scope.kind) {
		case "folder": {
			const params: unknown[] = [email];
			let cond = "b.folder_id IS NULL";
			if (scope.folder_id !== null) {
				cond = "b.folder_id = ?";
				params.push(scope.folder_id);
			}
			return {
				sql: `SELECT b.question_id AS id
              FROM bookmark_items b JOIN questions q ON q.id = b.question_id
              WHERE b.user_email = ? AND ${cond}
              ${Q_ORDER}`,
				params,
			};
		}
		case "bookmarks":
			return {
				sql: `SELECT b.question_id AS id
              FROM bookmark_items b JOIN questions q ON q.id = b.question_id
              WHERE b.user_email = ?
              ${Q_ORDER}`,
				params: [email],
			};
		case "notes":
			return {
				// DISTINCT:一題可以有多則筆記,這裡要的是「有筆記的題目」。
				sql: `SELECT DISTINCT n.question_id AS id
              FROM personal_notes n JOIN questions q ON q.id = n.question_id
              WHERE n.user_email = ?
              ${Q_ORDER}`,
				params: [email],
			};
		case "highlights":
			// store_key is 'anno:exp:<qid>' (詳解上的畫記) or
			// 'anno:note:<qid>:<hash>' (個人筆記上的) — see
			// frontend/src/routes/Question.tsx:934 and lib/noteHighlights.ts:23.
			// Matched exactly rather than with a loose LIKE so 114-001 can't pick
			// up a hypothetical 114-0011.
			return {
				sql: `SELECT q.id AS id FROM questions q
              WHERE EXISTS (
                SELECT 1 FROM highlights h
                WHERE h.user_email = ?
                  AND (h.store_key = 'anno:exp:' || q.id
                       OR h.store_key LIKE 'anno:note:' || q.id || ':%')
              )
              ${Q_ORDER}`,
				params: [email],
			};
		case "wrong": {
			// 判準跟畫面上那份清單共用同一個定義(lib/wrong-criterion.ts)——
			// 各寫一份的話,匯出的題數會跟畫面上看到的不一樣,而那沒有人會回報。
			// Filters live in WHERE (not a JOIN) so every extra param lands AFTER
			// the email — the params[0] invariant depends on that ordering.
			const params: unknown[] = [email];
			const where = ["rp.user_email = ?", WRONG_WHERE];
			if (scope.year !== undefined) {
				where.push("q.year = ?");
				params.push(scope.year);
			}
			if (scope.group) {
				where.push('q."group" = ?');
				params.push(scope.group);
			}
			if (scope.tags?.length) {
				const holes = scope.tags.map(() => "?").join(",");
				where.push(
					`(SELECT COUNT(DISTINCT t.tag) FROM question_tags t
             WHERE t.question_id = q.id AND t.tag IN (${holes})) = ?`,
				);
				params.push(...scope.tags, scope.tags.length);
			}
			return {
				sql: `SELECT rp.question_id AS id
              FROM review_progress rp JOIN questions q ON q.id = rp.question_id
              WHERE ${where.join(" AND ")}
              ORDER BY (rp.times_correct * 100 / rp.times_seen) ASC, q.year DESC, q.number ASC`,
				params,
			};
		}
		case "year":
			return {
				sql: `SELECT q.id AS id FROM questions q
              WHERE ${KNOWN_USER} AND q.year = ?
              ORDER BY q.number ASC`,
				params: [email, scope.year],
			};
		case "exam": {
			const params: unknown[] = [email, scope.session_id];
			const extra = scope.only_wrong
				? " AND (ea.is_correct IS NULL OR ea.is_correct = 0)"
				: "";
			return {
				sql: `SELECT ea.question_id AS id
              FROM exam_answers ea
              JOIN exam_sessions es ON es.id = ea.session_id
              JOIN questions q ON q.id = ea.question_id
              WHERE es.user_email = ? AND es.id = ?${extra}
              ORDER BY COALESCE(ea.seq, q.number) ASC`,
				params,
			};
		}
		case "ids": {
			const holes = scope.ids.map(() => "?").join(",");
			return {
				sql: `SELECT q.id AS id FROM questions q
              WHERE ${KNOWN_USER} AND q.id IN (${holes})
              ${Q_ORDER}`,
				params: [email, ...scope.ids],
			};
		}
	}
}
