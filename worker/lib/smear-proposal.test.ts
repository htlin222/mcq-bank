import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProposal } from './smear-proposal.ts';

const agree = (n: number) => Array.from({ length: n }, () => ({ agree: true }));
const disagree = (n: number) => Array.from({ length: n }, () => ({ agree: false }));

test('低於門檻一律 open,不論票的方向', () => {
  assert.equal(resolveProposal([...agree(2)], 3), 'open');
  assert.equal(resolveProposal([...disagree(2)], 3), 'open');
  assert.equal(resolveProposal([], 3), 'open');
  assert.equal(resolveProposal([{ agree: true }], 5), 'open');
});

test('達門檻且同意過半 → accepted', () => {
  assert.equal(resolveProposal([...agree(3)], 3), 'accepted');
  assert.equal(resolveProposal([...agree(2), ...disagree(1)], 3), 'accepted');
  assert.equal(resolveProposal([...agree(5), ...disagree(1)], 3), 'accepted');
});

test('達門檻且反對過半 → rejected', () => {
  assert.equal(resolveProposal([...disagree(3)], 3), 'rejected');
  assert.equal(resolveProposal([...disagree(2), ...agree(1)], 3), 'rejected');
});

test('達門檻但打平 → 保守預設 rejected(不讓有爭議的寫法悄悄變成可判分)', () => {
  assert.equal(resolveProposal([...agree(2), ...disagree(2)], 4), 'rejected');
  assert.equal(resolveProposal([...agree(1), ...disagree(1)], 2), 'rejected');
});

test('剛好卡在門檻的邊界(quorum-1 票不算數,quorum 票才算)', () => {
  assert.equal(resolveProposal([...agree(2)], 3), 'open');
  assert.equal(resolveProposal([...agree(3)], 3), 'accepted');
});

test('quorum=0 是退化情況(不應該真的用在正式路徑上,但函式仍須是決定性的):\n' +
  '零票時視為打平,套用同一條保守預設規則 → rejected', () => {
  assert.equal(resolveProposal([], 0), 'rejected');
});

test('票數遠超門檻時,規則吃的是全部的票,不是只看前 quorum 筆', () => {
  assert.equal(resolveProposal([...agree(10), ...disagree(9)], 3), 'accepted');
  assert.equal(resolveProposal([...agree(9), ...disagree(10)], 3), 'rejected');
});
