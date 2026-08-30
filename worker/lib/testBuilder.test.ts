import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestFilter, normalizeFilters, MAX_COUNT, DEFAULT_COUNT } from './testBuilder.ts';
import { WRONG_PREDICATE } from './wrong-criterion.ts';

test('無任何條件 = 全題庫,只有兩個 join 用的 email 參數', () => {
  const f = buildTestFilter(normalizeFilters({}), 'a@b.c');
  assert.equal(f.whereSql, '');
  assert.deepEqual(f.params, ['a@b.c', 'a@b.c']); // rp join + bi join
});

test('狀態複選是 OR 語意,包在同一組括號裡', () => {
  const f = buildTestFilter(normalizeFilters({ status: ['unseen', 'bookmarked'] }), 'a@b.c');
  assert.match(f.whereSql, /^WHERE \(.*OR.*\)$/s);
  assert.match(f.whereSql, /rp\.question_id IS NULL/);
  assert.match(f.whereSql, /bi\.question_id IS NOT NULL/);
});

test('四種狀態全選等於不限,不產生 WHERE 片段', () => {
  const f = buildTestFilter(
    normalizeFilters({ status: ['unseen', 'wrong', 'correct', 'bookmarked'] }),
    'a@b.c',
  );
  assert.match(f.whereSql, /^WHERE \(/);
});

test('範圍條件之間是 AND,狀態組與範圍組也是 AND', () => {
  const f = buildTestFilter(
    normalizeFilters({ status: ['wrong'], years: [114, 113], groups: ['內科'] }),
    'a@b.c',
  );
  // status組 / year組 / group組,三段以 AND 串接。
  // 注意 'wrong' 片段內部自己也有 AND,所以不能用 split(' AND ') 數。
  // 錯題判準本身不在這條的守備範圍(它在 wrong-criterion.test.ts)—— 這裡問的是
  // 「三組怎麼串」。寫死那段 SQL 的話,判準一改這條就假紅。
  assert.equal(
    f.whereSql,
    `WHERE (${WRONG_PREDICATE}) AND q.year IN (?,?) AND q."group" IN (?)`,
  );
  assert.deepEqual(f.params.slice(2), [114, 113, '內科']);
});

test('tag 多選是 OR(與 /api/questions 的 AND 刻意不同)', () => {
  const f = buildTestFilter(normalizeFilters({ tags: ['AML', 'MDS'] }), 'a@b.c');
  assert.match(f.whereSql, /EXISTS \(SELECT 1 FROM question_tags/);
  assert.deepEqual(f.params.slice(2), ['AML', 'MDS']);
});

test('join 一定存在,email 綁在 join 上而非 where', () => {
  const f = buildTestFilter(normalizeFilters({ years: [114] }), 'a@b.c');
  assert.match(f.joinSql, /LEFT JOIN review_progress rp/);
  assert.match(f.joinSql, /LEFT JOIN bookmark_items {2}bi/);
  assert.deepEqual(f.params, ['a@b.c', 'a@b.c', 114]);
});

test('normalizeFilters:題數夾在 1..100、未知狀態剔除、空陣列視為不限', () => {
  assert.equal(normalizeFilters({ count: 999 }).count, MAX_COUNT);
  assert.equal(normalizeFilters({ count: 0 }).count, 1);
  assert.equal(normalizeFilters({}).count, DEFAULT_COUNT);
  assert.deepEqual(normalizeFilters({ status: ['unseen', 'bogus'] as never }).status, ['unseen']);
  assert.deepEqual(normalizeFilters({ years: [] }).years, []);
});

test('normalizeFilters:去重、剔除非法型別、年份轉整數', () => {
  assert.deepEqual(normalizeFilters({ status: ['wrong', 'wrong'] }).status, ['wrong']);
  assert.deepEqual(normalizeFilters({ years: [114, 114, '113' as never] }).years, [114, 113]);
  assert.deepEqual(normalizeFilters({ groups: ['內科', '', 3 as never] }).groups, ['內科']);
  assert.deepEqual(normalizeFilters({ tags: ['  AML  ', 'AML'] }).tags, ['AML']);
  assert.equal(normalizeFilters({ count: NaN as never }).count, DEFAULT_COUNT);
  assert.equal(normalizeFilters(undefined).count, DEFAULT_COUNT);
});

test('normalizeFilters:tutor/timed 預設 exam mode + 計時', () => {
  const d = normalizeFilters({});
  assert.equal(d.tutor, false);
  assert.equal(d.timed, true);
  assert.equal(normalizeFilters({ tutor: true, timed: false }).tutor, true);
  assert.equal(normalizeFilters({ tutor: true, timed: false }).timed, false);
});

test('SQL 片段的 ? 數量與 params 長度一致(防綁定錯位)', () => {
  const f = buildTestFilter(
    normalizeFilters({ status: ['wrong', 'bookmarked'], years: [114], groups: ['內科', '共同'], tags: ['AML'] }),
    'a@b.c',
  );
  const marks = (f.joinSql + ' ' + f.whereSql).split('?').length - 1;
  assert.equal(marks, f.params.length);
});
