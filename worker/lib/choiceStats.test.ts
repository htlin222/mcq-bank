import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyChoices } from './choiceStats.ts';
import { MIN_COHORT } from './pacing.ts';

const L = ['A', 'B', 'C', 'D'];

test('一人一票:同使用者多筆作答只算較新的那票', () => {
  const out = tallyChoices(
    [
      { user: 'a@x', chosen: 'A', at: 100 },
      { user: 'a@x', chosen: 'B', at: 200 }, // 較新 → 只算 B
      { user: 'b@x', chosen: 'B', at: 50 },
      { user: 'c@x', chosen: 'B', at: 50 },
      { user: 'd@x', chosen: 'C', at: 50 },
      { user: 'e@x', chosen: 'C', at: 50 },
    ],
    { letters: L, minResponders: 5 },
  );
  assert.equal(out.responders, 5);
  assert.deepEqual(out.counts, { A: 0, B: 3, C: 2, D: 0 });
  assert.equal(out.pct!.B, 60);
  assert.equal(out.suppressed, false);
});

test('忽略未作答(null/空字串)與非法選項值', () => {
  const votes = [
    { user: 'a@x', chosen: null, at: 1 },
    { user: 'b@x', chosen: '  ', at: 1 },
    { user: 'c@x', chosen: 'Z', at: 1 }, // 不在 letters
    { user: 'd@x', chosen: 'E', at: 1 }, // 本題沒有 E
    { user: 'e@x', chosen: 'b', at: 1 }, // 小寫 → 正規化成 B
    { user: 'f@x', chosen: ' A ', at: 1 },
  ];
  const out = tallyChoices(votes, { letters: L, minResponders: 2 });
  assert.equal(out.responders, 2);
  assert.deepEqual(out.counts, { A: 1, B: 1, C: 0, D: 0 });
});

test('低於匿名門檻 → suppressed,不吐 counts', () => {
  const out = tallyChoices(
    [
      { user: 'a@x', chosen: 'A', at: 1 },
      { user: 'b@x', chosen: 'B', at: 1 },
    ],
    { letters: L, minResponders: MIN_COHORT },
  );
  assert.equal(out.suppressed, true);
  assert.equal(out.responders, 2);
  assert.equal(out.counts, null);
  assert.equal(out.pct, null);
});

test('零票:responders=0、suppressed=true、不除以零', () => {
  const out = tallyChoices([], { letters: L, minResponders: MIN_COHORT });
  assert.deepEqual(out, {
    responders: 0,
    counts: null,
    pct: null,
    suppressed: true,
  });
});

test('百分比四捨五入到 0.1,分母是 responders', () => {
  const votes = ['a', 'b', 'c'].map((u) => ({ user: u, chosen: 'A', at: 1 }));
  votes.push({ user: 'd', chosen: 'B', at: 1 }, { user: 'e', chosen: 'B', at: 1 });
  votes.push({ user: 'f', chosen: 'C', at: 1 });
  const out = tallyChoices(votes, { letters: L, minResponders: 5 });
  assert.equal(out.responders, 6);
  assert.equal(out.pct!.A, 50);
  assert.equal(out.pct!.C, 16.7);
});

test('時間相同時取後出現者(來源順序即優先序)', () => {
  const out = tallyChoices(
    [
      { user: 'a', chosen: 'A', at: 5 },
      { user: 'a', chosen: 'D', at: 5 },
    ],
    { letters: L, minResponders: 1 },
  );
  assert.equal(out.counts!.D, 1);
  assert.equal(out.counts!.A, 0);
});

test('counts 加總 = responders', () => {
  const votes = 'abcdefg'.split('').map((u, i) => ({
    user: u,
    chosen: L[i % 4],
    at: i,
  }));
  const out = tallyChoices(votes, { letters: L, minResponders: MIN_COHORT });
  const sum = Object.values(out.counts!).reduce((a, b) => a + b, 0);
  assert.equal(sum, out.responders);
});
