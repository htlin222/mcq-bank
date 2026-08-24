import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	matchesBookmark,
	sortBookmarks,
	type SortableBookmark,
} from './bookmarkSort.ts';

function bm(
	p: Partial<SortableBookmark> & { slug: string; page: number },
): SortableBookmark {
	return { created_at: 0, title: '', sort_order: 0, note_preview: '', ...p };
}

test('日期排序:新的在前', () => {
	const rows = [
		bm({ slug: 'a', page: 1, created_at: 100 }),
		bm({ slug: 'b', page: 2, created_at: 300 }),
		bm({ slug: 'c', page: 3, created_at: 200 }),
	];
	assert.deepEqual(
		sortBookmarks(rows, 'date').map((r) => r.slug),
		['b', 'c', 'a'],
	);
});

test('文件排序:sort_order 優先,同一份講義內依頁碼', () => {
	const rows = [
		bm({ slug: 'b', page: 9, sort_order: 2 }),
		bm({ slug: 'a', page: 12, sort_order: 1 }),
		bm({ slug: 'a', page: 3, sort_order: 1 }),
	];
	assert.deepEqual(
		sortBookmarks(rows, 'doc').map((r) => `${r.slug}:${r.page}`),
		['a:3', 'a:12', 'b:9'],
	);
});

// 同分時若不排到最後,順序由引擎自由決定 —— 症狀是「每次重整卡片就換位置」,
// 而在只有兩三個書籤的帳號上完全看不出來。
test('時間戳相同時仍是全序(slug → page),與輸入順序無關', () => {
	const rows = [
		bm({ slug: 'b', page: 1, created_at: 500 }),
		bm({ slug: 'a', page: 7, created_at: 500 }),
		bm({ slug: 'a', page: 2, created_at: 500 }),
	];
	const once = sortBookmarks(rows, 'date').map((r) => `${r.slug}:${r.page}`);
	const twice = sortBookmarks([...rows].reverse(), 'date').map(
		(r) => `${r.slug}:${r.page}`,
	);
	assert.deepEqual(once, ['a:2', 'a:7', 'b:1']);
	assert.deepEqual(twice, once);
});

test('sort_order 相同時仍是全序', () => {
	const rows = [
		bm({ slug: 'z', page: 1, sort_order: 3 }),
		bm({ slug: 'y', page: 4, sort_order: 3 }),
	];
	assert.deepEqual(
		sortBookmarks(rows, 'doc').map((r) => r.slug),
		['y', 'z'],
	);
});

test('不修改輸入陣列', () => {
	const rows = [
		bm({ slug: 'a', page: 1, created_at: 1 }),
		bm({ slug: 'b', page: 2, created_at: 9 }),
	];
	const copy = [...rows];
	sortBookmarks(rows, 'date');
	assert.deepEqual(rows, copy);
});

test('過濾:標題或筆記預覽命中,大小寫不拘', () => {
	const row = bm({
		slug: 'a',
		page: 1,
		title: '急性骨髓性白血病',
		note_preview: 'FLT3-ITD 預後差',
	});
	assert.equal(matchesBookmark(row, ''), true);
	assert.equal(matchesBookmark(row, '   '), true, '只有空白也一律通過');
	assert.equal(matchesBookmark(row, '白血病'), true);
	assert.equal(matchesBookmark(row, 'flt3'), true);
	assert.equal(matchesBookmark(row, '淋巴瘤'), false);
});
