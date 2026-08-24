import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isAuthRedirect,
	isCacheableApiResponse,
	isCacheableApiPath,
} from "./sw-guards.ts";

const ORIGIN = "https://example.com";

function res(
	body: string,
	init: ResponseInit & {
		url?: string;
		redirected?: boolean;
		type?: string;
	} = {},
): Response {
	const { url, redirected, type, ...rest } = init;
	const r = new Response(body, rest) as Response;
	if (url !== undefined) Object.defineProperty(r, "url", { value: url });
	if (redirected !== undefined)
		Object.defineProperty(r, "redirected", { value: redirected });
	if (type !== undefined) Object.defineProperty(r, "type", { value: type });
	return r;
}

const json = (init: Parameters<typeof res>[1] = {}) =>
	res("{}", {
		headers: { "content-type": "application/json" },
		url: `${ORIGIN}/api/questions/114-001`,
		...init,
	});

// --- isAuthRedirect -------------------------------------------------------
// The failure mode this whole module exists for: CF Access answers an expired
// session with a 302 to <team>.cloudflareaccess.com. fetch() follows it, so
// status is 200 and res.ok is true — status alone can never detect this.

test("a followed 302 is an auth redirect even though status is 200", () => {
	const r = json({
		redirected: true,
		url: "https://team.cloudflareaccess.com/x",
	});
	assert.equal(r.ok, true); // the trap
	assert.equal(isAuthRedirect(r, ORIGIN), true);
});

test("a cross-origin final URL is an auth redirect", () => {
	assert.equal(
		isAuthRedirect(
			json({ url: "https://team.cloudflareaccess.com/cdn-cgi/x" }),
			ORIGIN,
		),
		true,
	);
});

test("an opaqueredirect response is an auth redirect", () => {
	assert.equal(isAuthRedirect(json({ type: "opaqueredirect" }), ORIGIN), true);
});

test("401 and 403 are auth redirects (the Worker answers with JSON 401)", () => {
	assert.equal(isAuthRedirect(json({ status: 401 }), ORIGIN), true);
	assert.equal(isAuthRedirect(json({ status: 403 }), ORIGIN), true);
});

test("a normal same-origin JSON response is not an auth redirect", () => {
	assert.equal(isAuthRedirect(json(), ORIGIN), false);
});

test("a response with no url (constructed, not fetched) is not cross-origin", () => {
	assert.equal(isAuthRedirect(res("{}", {}), ORIGIN), false);
});

// --- isCacheableApiResponse ----------------------------------------------

test("a followed 302 is never cached", () => {
	assert.equal(
		isCacheableApiResponse(json({ redirected: true }), ORIGIN),
		false,
	);
});

test("HTML (the Access login page) is never cached", () => {
	const r = res("<html>", {
		headers: { "content-type": "text/html" },
		url: `${ORIGIN}/api/questions/114-001`,
	});
	assert.equal(isCacheableApiResponse(r, ORIGIN), false);
});

test("a plain JSON 200 is cacheable", () => {
	assert.equal(isCacheableApiResponse(json(), ORIGIN), true);
});

test("a 500 is not cacheable", () => {
	assert.equal(isCacheableApiResponse(json({ status: 500 }), ORIGIN), false);
});

test("an undefined response is not cacheable", () => {
	assert.equal(isCacheableApiResponse(undefined, ORIGIN), false);
});

// --- isCacheableApiPath (allowlist) --------------------------------------

test("question read endpoints are cacheable", () => {
	assert.equal(isCacheableApiPath("/api/questions/114-001"), true);
	assert.equal(isCacheableApiPath("/api/questions/114-001/comments"), true);
	assert.equal(isCacheableApiPath("/api/questions/114-001/note"), true);
	assert.equal(isCacheableApiPath("/api/questions?year=114"), true);
	assert.equal(isCacheableApiPath("/api/questions"), true);
	assert.equal(isCacheableApiPath("/api/questions/_meta/years"), true);
	assert.equal(isCacheableApiPath("/api/lectures"), true);
});

test("curated video listings are cacheable, but the mutable ones are not", () => {
	assert.equal(isCacheableApiPath("/api/questions/114-001/videos"), true);
	assert.equal(isCacheableApiPath("/api/videos/topics"), true);
	assert.equal(isCacheableApiPath("/api/videos/topics/cml"), true);
	// 「已移除」是刪除動作的鏡子 —— 快取它,還原後畫面就不會更新。
	assert.equal(isCacheableApiPath("/api/videos/removed"), false);
});

test("identity, notifications and chat are never cacheable", () => {
	assert.equal(isCacheableApiPath("/api/me"), false);
	assert.equal(isCacheableApiPath("/api/notifications"), false);
	assert.equal(isCacheableApiPath("/api/notifications/unread-count"), false);
	assert.equal(isCacheableApiPath("/api/chat/ws"), false);
	assert.equal(isCacheableApiPath("/api/users"), false);
});

test("the new-year import wizard is never cacheable", () => {
	// 整個精靈的前提就是它反映本機此刻的狀態。快取任何一支都會讓畫面凍住,
	// 而使用者無從得知自己在看的是幾分鐘前的東西。
	assert.equal(isCacheableApiPath("/api/admin/import-year/status"), false);
	assert.equal(isCacheableApiPath("/api/admin/import-year/abc-123"), false);
	assert.equal(isCacheableApiPath("/api/bank-ingest/config"), false);
	assert.equal(isCacheableApiPath("/api/me/bank-skill"), false);
});

test("講義書籤是可變的私人狀態,永遠不快取", () => {
	// 現有的 /^\/api\/lectures(\?|$)/ 只認完全相同的路徑,所以這幾支「剛好」
	// 不在允許清單裡 —— 但那是巧合,不是決定。哪天有人把它放寬成前綴比對,
	// 症狀會是「加了書籤、重新整理,書籤不見了」,而且無聲。
	assert.equal(isCacheableApiPath("/api/lectures/bookmarks"), false);
	assert.equal(isCacheableApiPath("/api/lectures/heme-01/bookmarks"), false);
});

test("其他筆記(自由筆記)是可變的私人狀態,永遠不快取", () => {
	// 這幾支被快取住的話,使用者會存完筆記、重新整理,然後看到自己剛寫的東西
	// 沒有變 —— 而且是無聲的。/api/lectures 可快取,名稱又相近,所以特別測。
	assert.equal(isCacheableApiPath("/api/free-notes"), false);
	assert.equal(isCacheableApiPath("/api/free-notes/n1"), false);
	assert.equal(isCacheableApiPath("/api/free-notes/n1/tags"), false);
	assert.equal(isCacheableApiPath("/api/free-notes/n1/links"), false);
});

test("備份端點永遠不快取 —— 備份到的必須是「現在」", () => {
	// 這幾支的回應會被寫進使用者下載的 zip。被 SW 快取住的話,備份檔裡是上一次
	// 的狀態,而檔名與 manifest 的 generated_at 都會宣稱是現在 —— 一份說謊的
	// 備份比沒有備份更糟。分頁游標也會因此永遠停在同一頁。
	assert.equal(isCacheableApiPath("/api/backup/manifest"), false);
	assert.equal(
		isCacheableApiPath("/api/backup/questions?after=113-050"),
		false,
	);
	assert.equal(isCacheableApiPath("/api/backup/notes"), false);
	assert.equal(isCacheableApiPath("/api/backup/free-notes"), false);
});

test("scheduling and answer state are never cacheable", () => {
	assert.equal(isCacheableApiPath("/api/review/due"), false);
	assert.equal(isCacheableApiPath("/api/drill/next"), false);
	assert.equal(isCacheableApiPath("/api/exam/123"), false);
	assert.equal(isCacheableApiPath("/api/highlights"), false);
	assert.equal(isCacheableApiPath("/api/bookmarks"), false);
});

test("the allowlist is closed — unknown endpoints default to no cache", () => {
	assert.equal(isCacheableApiPath("/api/some-future-endpoint"), false);
	assert.equal(isCacheableApiPath("/api/questions/114-001/challenges"), false);
	assert.equal(isCacheableApiPath("/pdf/lecture.pdf"), false);
	assert.equal(isCacheableApiPath("/img/abc"), false);
});
