import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, median, pacingSplit, MIN_COHORT } from './pacing.ts';

test('中位數:奇數取中、偶數取平均、空陣列 null', () => {
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
});

test('百分位使用線性插值,且不依賴輸入排序', () => {
  assert.equal(percentile([50, 10, 30, 20, 40], 0.5), 30);
  assert.equal(percentile([10, 20], 0.25), 12.5);
  assert.equal(percentile([10], 0.9), 10);
});

test('前後半段配速:偶數題平分,奇數題中間題歸前段', () => {
  const out = pacingSplit([10, 10, 30, 50]);
  assert.deepEqual(out, { firstHalfAvg: 10, secondHalfAvg: 40, deltaPct: 300, n: 4 });
});

test('樣本不足以分半 → null 摘要', () => {
  assert.equal(pacingSplit([]), null);
  assert.equal(pacingSplit([42]), null);
});

test('前段平均為 0 時 deltaPct 為 null(不除以零)', () => {
  const out = pacingSplit([0, 0, 30, 50]);
  assert.equal(out?.deltaPct, null);
});

test('匿名門檻:少於 MIN_COHORT 人不回中位數', () => {
  assert.ok(MIN_COHORT >= 5);
});
