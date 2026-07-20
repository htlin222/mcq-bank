// 這份測試存在的唯一理由:frontend/src/lib/helpful.ts 是 worker/lib/helpful.ts
// 的手抄副本(tsconfig 邊界不允許跨界 import)。同一組行為斷言在兩邊各跑一次,
// 副本漂移時會在 CI 就爆掉,而不是在使用者眼前排錯序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpfulScore, rankByHelpful } from './helpful.ts';

const DAY = 86_400_000;
const now = 10 * DAY;

test('前端副本:零票得零分,票數越多分越高', () => {
  assert.equal(helpfulScore({ helpful_count: 0, created_at: now }, now), 0);
  assert.ok(
    helpfulScore({ helpful_count: 3, created_at: now }, now) >
      helpfulScore({ helpful_count: 1, created_at: now }, now)
  );
});

test('前端副本:同票數時較新者分數較高', () => {
  assert.ok(
    helpfulScore({ helpful_count: 2, created_at: now }, now) >
      helpfulScore({ helpful_count: 2, created_at: now - 30 * DAY }, now)
  );
});

test('前端副本:被採納者置頂,且吃得下 D1 回來的 0/1', () => {
  const out = rankByHelpful(
    [
      { id: 'a', helpful_count: 9, created_at: now, adopted: 0 },
      { id: 'b', helpful_count: 0, created_at: now, adopted: 1 },
    ],
    now
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ['b', 'a']
  );
});

test('前端副本:分數相同時較早者在前,且不改動輸入', () => {
  const input = [
    { id: 'late', helpful_count: 0, created_at: now },
    { id: 'early', helpful_count: 0, created_at: now - DAY },
  ];
  const out = rankByHelpful(input, now);
  assert.deepEqual(
    out.map((r) => r.id),
    ['early', 'late']
  );
  assert.deepEqual(
    input.map((r) => r.id),
    ['late', 'early']
  );
});
