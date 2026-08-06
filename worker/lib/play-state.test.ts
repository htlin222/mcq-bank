import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidState, MAX_TILE, MAX_SCORE } from './play-state.ts';

const N = null;

function ok(board: (number | null)[], score = 0) {
  return { board, score, won: false, over: false };
}

const EMPTY = new Array(16).fill(null);

function withTiles(...pairs: [number, number][]) {
  const b = EMPTY.slice();
  for (const [i, v] of pairs) b[i] = v;
  return b;
}

test('接受合法的開局盤面', () => {
  assert.equal(isValidState(ok(withTiles([0, 2], [5, 4]))), true);
});

test('接受全空的盤面', () => {
  assert.equal(isValidState(ok(EMPTY)), true);
});

test('拒絕 null / 非物件', () => {
  assert.equal(isValidState(null), false);
  assert.equal(isValidState('board'), false);
  assert.equal(isValidState(42), false);
  assert.equal(isValidState([]), false);
});

test('拒絕長度不是 16 的 board', () => {
  assert.equal(isValidState(ok(new Array(15).fill(N))), false);
  assert.equal(isValidState(ok(new Array(17).fill(N))), false);
});

test('拒絕 board 不是陣列', () => {
  assert.equal(isValidState({ board: 'xxxx', score: 0, won: false, over: false }), false);
});

test('拒絕不是 2 的次方的格值', () => {
  assert.equal(isValidState(ok(withTiles([0, 3]))), false);
  assert.equal(isValidState(ok(withTiles([0, 100]))), false);
});

test('拒絕 1 與 0(2048 的磚最小是 2)', () => {
  assert.equal(isValidState(ok(withTiles([0, 1]))), false);
  assert.equal(isValidState(ok(withTiles([0, 0]))), false);
});

test('拒絕超過上限的格值', () => {
  assert.equal(isValidState(ok(withTiles([0, MAX_TILE]))), true);
  assert.equal(isValidState(ok(withTiles([0, MAX_TILE * 2]))), false);
});

test('拒絕負值與非整數格值', () => {
  assert.equal(isValidState(ok(withTiles([0, -2]))), false);
  assert.equal(isValidState(ok(withTiles([0, 2.5]))), false);
});

test('拒絕負分、非整數分、超過上限的分數', () => {
  assert.equal(isValidState(ok(EMPTY, -1)), false);
  assert.equal(isValidState(ok(EMPTY, 1.5)), false);
  assert.equal(isValidState(ok(EMPTY, MAX_SCORE + 1)), false);
  assert.equal(isValidState(ok(EMPTY, MAX_SCORE)), true);
});

test('拒絕 NaN / Infinity', () => {
  assert.equal(isValidState(ok(EMPTY, Number.NaN)), false);
  assert.equal(isValidState(ok(EMPTY, Number.POSITIVE_INFINITY)), false);
  assert.equal(isValidState(ok(withTiles([0, Number.NaN]))), false);
});

test('拒絕 won / over 不是布林', () => {
  assert.equal(isValidState({ board: EMPTY, score: 0, won: 'yes', over: false }), false);
  assert.equal(isValidState({ board: EMPTY, score: 0, won: false, over: 1 }), false);
});

test('拒絕缺欄位', () => {
  assert.equal(isValidState({ board: EMPTY, score: 0 }), false);
});
