import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helpfulScore, rankByHelpful } from './helpful.ts';

const DAY = 86_400_000;
const now = 10 * DAY;

test('零票得零分,票數越多分越高', () => {
  assert.equal(helpfulScore({ helpful_count: 0, created_at: now }, now), 0);
  assert.ok(
    helpfulScore({ helpful_count: 3, created_at: now }, now) >
      helpfulScore({ helpful_count: 1, created_at: now }, now)
  );
});

test('同票數時較新者分數較高(避免早發言者永遠壓死後發言者)', () => {
  assert.ok(
    helpfulScore({ helpful_count: 2, created_at: now }, now) >
      helpfulScore({ helpful_count: 2, created_at: now - 30 * DAY }, now)
  );
});

test('被採納者強制置頂,即使零票', () => {
  const out = rankByHelpful(
    [
      { id: 'a', helpful_count: 9, created_at: now },
      { id: 'b', helpful_count: 0, created_at: now, adopted: true },
    ],
    now
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ['b', 'a']
  );
});

test('分數相同時比時間(較早者在前)', () => {
  const out = rankByHelpful(
    [
      { id: 'late', helpful_count: 0, created_at: now },
      { id: 'early', helpful_count: 0, created_at: now - DAY },
    ],
    now
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ['early', 'late']
  );
});

test('不改動輸入陣列', () => {
  const input = [
    { id: 'a', helpful_count: 0, created_at: now },
    { id: 'b', helpful_count: 5, created_at: now },
  ];
  rankByHelpful(input, now);
  assert.deepEqual(
    input.map((r) => r.id),
    ['a', 'b']
  );
});

test('未來時戳(時鐘偏移)不會拿到超額分數', () => {
  // ageDays 夾在 0:否則 (ageDays + 2) < 2 會把分數放大。
  assert.equal(
    helpfulScore({ helpful_count: 4, created_at: now + 5 * DAY }, now),
    helpfulScore({ helpful_count: 4, created_at: now }, now)
  );
});
