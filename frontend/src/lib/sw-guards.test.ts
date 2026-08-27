import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isAuthRedirect,
	isCacheableApiResponse,
	isCacheableImageResponse,
	isCacheableApiPath,
	API_CACHE_MAX_ENTRIES,
	API_CACHE_MAX_AGE_SECONDS,
	IMG_CACHE_MAX_ENTRIES,
	IMG_CACHE_MAX_AGE_SECONDS,
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

// —— 快取容量 —————————————————————————————————————————————————
//
// 這兩個數字不是隨手挑的,而且改小會讓「離線預載一年」無聲失效
// (docs/plans/2026-08-27-offline-year-prefetch-design.md)。

test("maxEntries 要大於整個題庫 —— 驅逐壓力必須不存在", () => {
	// 全部 11 年 × 100 題 = 1100。大於它之後,就不必區分「刻意拓的一年」與
	// 「隨手看過的題目」,那一整套驅逐策略因此不需要存在。
	// 題庫長到超過這個數字時,這個假設失效,要回頭讀設計文件。
	assert.ok(
		API_CACHE_MAX_ENTRIES > 1100,
		`maxEntries 必須大於題庫題數(1100),實際 ${API_CACHE_MAX_ENTRIES}`,
	);
});

test("maxAge 要撐得過一個考季 —— 7 天會讓拓好的一年第 8 天無聲過期", () => {
	const days = API_CACHE_MAX_AGE_SECONDS / 86400;
	assert.ok(days >= 30, `至少要 30 天,實際 ${days} 天`);
});

test("圖片快取要裝得下不只一年 —— 300 張連一年都不夠", () => {
	// 一年的詳解有 125–259 張圖(2026-08-27 實測)。上限太小的症狀是「拓第二年
	// 之後,第一年的某些題沒圖」,完全不指向快取容量。
	assert.ok(
		IMG_CACHE_MAX_ENTRIES >= 1000,
		`至少要裝得下好幾年,實際 ${IMG_CACHE_MAX_ENTRIES}`,
	);
});

test("圖片 key 是 UUID,不會過期 —— 30 天只會讓備好的圖消失", () => {
	const days = IMG_CACHE_MAX_AGE_SECONDS / 86400;
	assert.ok(days >= 180, `至少半年,實際 ${days} 天`);
});

// —— 圖片的 guard ————————————————————————————————————————————
//
// ⚠️ 這一組守的是一個實際的 bug:`/img/*` 原本跟 API 共用 guard,而那支要求
// content-type 是 application/json —— 於是圖片一張都沒被快取過,連 img-v1 那個
// cache 都不存在。症狀是「離線看詳解沒圖」,跟「本來就沒預載圖」長得一樣。

test("圖片回應可以快取 —— JSON 那支會拒絕它", () => {
	const png = res('x', { headers: { 'content-type': 'image/png' }, url: ORIGIN + '/img/a.png' });
	assert.equal(isCacheableImageResponse(png, ORIGIN), true);
	// 這一行就是原本的 bug:同一個回應在 JSON 那支底下是「不可快取」。
	assert.equal(isCacheableApiResponse(png, ORIGIN), false);
});

test("圖片的 guard 一樣擋 Access 登入頁", () => {
	// 過期的 session 換來 text/html,用 CacheFirst 存下去的話,那張圖的位置會
	// 永遠是一頁 HTML —— 而且 CacheFirst 不會再去問網路。
	const html = res('<html>', {
		headers: { 'content-type': 'text/html' },
		url: ORIGIN + '/img/a.png',
	});
	assert.equal(isCacheableImageResponse(html, ORIGIN), false);

	const redirected = res('x', {
		headers: { 'content-type': 'image/png' },
		url: 'https://team.cloudflareaccess.com/x',
		redirected: true,
	});
	assert.equal(isCacheableImageResponse(redirected, ORIGIN), false);
});

test("圖片的 guard 不收非 2xx", () => {
	const e = res('x', { status: 500, headers: { 'content-type': 'image/png' } });
	assert.equal(isCacheableImageResponse(e, ORIGIN), false);
	assert.equal(isCacheableImageResponse(undefined, ORIGIN), false);
});
