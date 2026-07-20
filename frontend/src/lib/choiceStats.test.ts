import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choicePct, type StatsPayload } from './choiceStats.ts';

const base = {
  choices_state: 'ok',
  choice_pct: { A: 12.5, B: 62 },
} as Pick<StatsPayload, 'choices_state' | 'choice_pct'>;

test('choices_state 為 ok 時回百分比,缺的選項當 0', () => {
  assert.equal(choicePct(base, 'B'), 62);
  assert.equal(choicePct(base, 'D'), 0);
});

test('未作答 / 人數不足 / 無 stats 一律回 null(不畫長條)', () => {
  assert.equal(choicePct({ ...base, choices_state: 'not_answered' }, 'B'), null);
  assert.equal(choicePct({ ...base, choices_state: 'below_threshold' }, 'B'), null);
  assert.equal(choicePct(null, 'B'), null);
  assert.equal(choicePct(undefined, 'B'), null);
});
