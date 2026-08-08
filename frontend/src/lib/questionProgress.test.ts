// 作答後就地補寫 my_progress 的兩個純函式。
//
// 這兩支存在的理由是「答完不要再問伺服器一次」—— 舊版的 `onAnswered={reload}`
// 會強制重抓 payload,而 `/api/questions/:id` 在 Service Worker 是 NetworkFirst
// 加 3 秒 timeout,慢網路上回的是**答題前**那份快取,反而把剛作答的狀態洗掉
// (回報 #95:「上一題/下一題 來回切換就不見了」)。詳見 questionProgress.ts。

import { test } from "node:test";
import assert from "node:assert/strict";
import { withAnswer, withProgressCleared } from "./questionProgress.ts";
import type { QuestionFull } from "../hooks/useQuestion.ts";

function q(progress: QuestionFull["my_progress"]): QuestionFull {
	return {
		id: "113-050",
		year: 113,
		number: 50,
		stem: "…",
		options: { A: "a", B: "b", C: "c", D: "d" },
		answer: "B",
		group: "內科",
		difficulty: null,
		source: null,
		tags: [],
		can_edit_answer: false,
		explanation: null,
		my_progress: progress,
		my_note: null,
		back_refs: [],
		comment_count: 0,
	};
}

test("第一次作答:從沒有進度長出一筆", () => {
	const out = withAnswer(q(null), "B", true);
	assert.deepEqual(out.my_progress, {
		times_seen: 1,
		times_correct: 1,
		last_chosen: "B",
		last_correct: 1,
		bookmarked: 0,
		bookmark_folder_id: null,
	});
});

test("答錯:times_seen 進位但 times_correct 不動", () => {
	const before = {
		times_seen: 3,
		times_correct: 2,
		last_chosen: "B",
		last_correct: 1 as const,
		bookmarked: 0 as const,
		bookmark_folder_id: null,
	};
	const out = withAnswer(q(before), "D", false);
	assert.equal(out.my_progress?.times_seen, 4);
	assert.equal(out.my_progress?.times_correct, 2);
	assert.equal(out.my_progress?.last_chosen, "D");
	assert.equal(out.my_progress?.last_correct, 0);
});

// 收藏跟作答是兩張互不相干的狀態,只是剛好共用同一個 my_progress 物件。漏帶的話
// 症狀是「答一題就把收藏取消了」,而且要重新整理才看得出來。
test("收藏狀態原封不動帶過去", () => {
	const before = {
		times_seen: 1,
		times_correct: 0,
		last_chosen: "A",
		last_correct: 0 as const,
		bookmarked: 1 as const,
		bookmark_folder_id: "folder-x",
	};
	assert.equal(withAnswer(q(before), "C", false).my_progress?.bookmarked, 1);
	assert.equal(
		withAnswer(q(before), "C", false).my_progress?.bookmark_folder_id,
		"folder-x",
	);
	assert.equal(withProgressCleared(q(before)).my_progress?.bookmarked, 1);
	assert.equal(
		withProgressCleared(q(before)).my_progress?.bookmark_folder_id,
		"folder-x",
	);
});

test("清除作答紀錄:歸零而不是變成 null", () => {
	// null 會讓呼叫端分不出「還沒作答」與「這題沒查到進度」,而 QuestionCard 是用
	// `!!my_progress?.last_chosen` 判斷要不要揭曉的 —— 兩者剛好等價,但把 times_*
	// 一起歸零才能讓「已看過 N 次」那行同步退回。
	const out = withProgressCleared(
		q({
			times_seen: 9,
			times_correct: 4,
			last_chosen: "B",
			last_correct: 1,
			bookmarked: 0,
			bookmark_folder_id: null,
		}),
	);
	assert.deepEqual(out.my_progress, {
		times_seen: 0,
		times_correct: 0,
		last_chosen: null,
		last_correct: null,
		bookmarked: 0,
		bookmark_folder_id: null,
	});
});

test("是純函式:不動輸入", () => {
	const before = {
		times_seen: 1,
		times_correct: 1,
		last_chosen: "B",
		last_correct: 1 as const,
		bookmarked: 0 as const,
		bookmark_folder_id: null,
	};
	const input = q(before);
	const out = withAnswer(input, "D", false);
	assert.equal(input.my_progress?.times_seen, 1, "輸入被就地改掉了");
	assert.notEqual(out, input);
	assert.equal(out.stem, input.stem);
});
