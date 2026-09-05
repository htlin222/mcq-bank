import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMcqDistractors, pickMcqOptions, type McqCandidate } from './smear-mcq.ts';

const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

const cand = (id: string, topic: string, label = id): McqCandidate => ({ id, topic, label });

test('同 topic 優先抽干擾項', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte');
  const pool = [
    cand('schistocyte', 'rbc'),
    cand('spherocyte', 'rbc'),
    cand('target-cell', 'rbc'),
    cand('burr-cell', 'rbc'),
    cand('aml', 'myeloid'),
    cand('cll', 'lymphoid'),
  ];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert.equal(got.length, 4);
  // 四個同 topic 候選剛好等於名額，一個跨 topic 的都不該出現
  assert.ok(!got.includes('aml'));
  assert.ok(!got.includes('cll'));
});

test('⚠️ 同 topic 不足時，缺額要從其他 topic 回填 —— 不准少於 count', () => {
  const correct = cand('rare-dx', 'infection', 'rare-dx');
  const pool = [
    cand('other-infection', 'infection'),
    cand('aml', 'myeloid'),
    cand('cll', 'lymphoid'),
    cand('platelet-dx', 'platelet'),
    cand('storage-dx', 'other'),
  ];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2, 0.3, 0.4]));
  assert.equal(got.length, 4); // 同 topic 只有 1 個候選，其餘 3 個從別 topic 回填
});

test('正解永遠不會出現在自己的干擾項清單裡', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte');
  const pool = [correct, cand('schistocyte', 'rbc'), cand('spherocyte', 'rbc')];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2]));
  assert.ok(!got.includes('dacrocyte'));
});

test('pickMcqOptions：正解一定在洗牌後的清單裡，且不重複', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte-label');
  const pool = [
    cand('schistocyte', 'rbc', 'schistocyte-label'),
    cand('spherocyte', 'rbc', 'spherocyte-label'),
    cand('target-cell', 'rbc', 'target-cell-label'),
    cand('burr-cell', 'rbc', 'burr-cell-label'),
  ];
  const got = pickMcqOptions(correct, pool, seq([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert.equal(got.length, 5);
  assert.equal(new Set(got).size, 5);
  assert.ok(got.includes('dacrocyte-label'));
});

test('題庫小到湊不出 4 個干擾項時，回傳能湊到的數量，不丟例外', () => {
  const correct = cand('only-dx', 'rbc', 'only-dx');
  const got = pickMcqDistractors(correct, [correct], 4, seq([0.1]));
  assert.equal(got.length, 0);
});
