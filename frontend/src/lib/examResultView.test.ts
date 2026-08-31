import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXAM_RESULT_VIEW,
  parseExamResultView,
} from './examResultView.ts';

test('沒存過 / 空字串 → 這一頁原本的初始狀態', () => {
  assert.deepEqual(parseExamResultView(null), DEFAULT_EXAM_RESULT_VIEW);
  assert.deepEqual(parseExamResultView(''), DEFAULT_EXAM_RESULT_VIEW);
});

test('壞掉的 JSON 不能讓這一頁爆掉', () => {
  assert.deepEqual(parseExamResultView('{'), DEFAULT_EXAM_RESULT_VIEW);
  assert.deepEqual(parseExamResultView('"wrong"'), DEFAULT_EXAM_RESULT_VIEW);
  assert.deepEqual(parseExamResultView('null'), DEFAULT_EXAM_RESULT_VIEW);
  assert.deepEqual(parseExamResultView('[1,2]'), {
    ...DEFAULT_EXAM_RESULT_VIEW,
  });
});

test('完整的一份原樣還原', () => {
  assert.deepEqual(
    parseExamResultView('{"filter":"all","expandAll":true,"y":1234.5}'),
    { filter: 'all', expandAll: true, y: 1234.5 },
  );
});

test('認不得的 filter 落回預設,不是原樣傳出去', () => {
  // 上一版寫進去的值(欄位改名 / 多了一種篩選再拿掉)。原樣用的話清單會整個
  // 空掉、四顆篩選鈕沒有一顆是亮的 —— 看起來像資料壞了。
  assert.equal(parseExamResultView('{"filter":"unanswered"}').filter, 'wrong');
  assert.equal(parseExamResultView('{"filter":42}').filter, 'wrong');
  assert.equal(parseExamResultView('{}').filter, 'wrong');
});

test('y 只收有限的正數', () => {
  // `JSON.stringify(NaN)` 是 "null";`scrollTo(0, NaN)` 是靜靜不動,那會讓
  // 「還原壞掉」看起來像「根本沒有這個功能」。
  assert.equal(parseExamResultView('{"y":null}').y, 0);
  assert.equal(parseExamResultView('{"y":-30}').y, 0);
  assert.equal(parseExamResultView('{"y":"800"}').y, 0);
  assert.equal(parseExamResultView('{"y":800}').y, 800);
});

test('expandAll 只認真正的 true', () => {
  assert.equal(parseExamResultView('{"expandAll":true}').expandAll, true);
  assert.equal(parseExamResultView('{"expandAll":1}').expandAll, false);
  assert.equal(parseExamResultView('{"expandAll":"true"}').expandAll, false);
  assert.equal(parseExamResultView('{}').expandAll, false);
});
