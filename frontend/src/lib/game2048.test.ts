// 2048 引擎的單元測試。
//
// 這支測試存在的理由是「合併規則的邊角案例」——2048 看起來簡單,但一次移動
// 中「已經合併過的磚不能再合併」這條規則,自己憑印象寫十之八九會錯,而錯了
// 之後玩起來只是「怪怪的」,不會壞給你看。
//
// 引擎不直接呼叫 Math.random():rng 由呼叫端注入,所以「新磚落在哪一格」在
// 測試裡是可決定的。spawn 會呼叫 rng 兩次,**先位置、後決定 2 或 4**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame,
  move,
  isGameOver,
  slideLine,
  type Board,
  type GameState,
} from './game2048.ts';

// 依序回傳給定的值;用完之後一律回 0。
function seqRng(...vals: number[]): () => number {
  let i = 0;
  return () => (i < vals.length ? vals[i] ?? 0 : 0);
}

// 讓新磚落在**最後一個**空格,這樣它不會污染我們正在斷言的那幾格。
// 0.99 → floor(0.99 × 空格數) = 空格數 - 1;第二個 0 → 生成 2。
const rngLast = () => seqRng(0.99, 0);

// 把 4×4 的二維寫法攤平成引擎用的扁平陣列,讓測試讀起來像棋盤。
function board(...rows: (number | null)[][]): Board {
  return rows.flat();
}

const N = null;

function state(b: Board, score = 0): GameState {
  return { board: b, score, won: false, over: false };
}

// ---------------------------------------------------------------- slideLine

test('slideLine 把磚推到前緣並補 null', () => {
  assert.deepEqual(slideLine([N, 2, N, 4]), { line: [2, 4, N, N], gained: 0 });
});

test('slideLine 合併相鄰同值,gained 是合併結果之和', () => {
  assert.deepEqual(slideLine([2, 2, N, N]), { line: [4, N, N, N], gained: 4 });
});

test('slideLine 一次移動中已合併的磚不再參與合併', () => {
  // [2,2,4] 左滑的正解是 [4,4],不是 [8]:新生成的 4 不能再吃掉原本的 4。
  assert.deepEqual(slideLine([2, 2, 4, N]), { line: [4, 4, N, N], gained: 4 });
});

test('slideLine 合併發生在移動方向的前緣', () => {
  // [2,_,2,2] 左滑:前兩個 2 先合併,剩下的 2 留著 —— 不是後兩個先合併。
  assert.deepEqual(slideLine([2, N, 2, 2]), { line: [4, 2, N, N], gained: 4 });
});

test('slideLine 四個同值合成兩對,不是一個', () => {
  assert.deepEqual(slideLine([4, 4, 4, 4]), { line: [8, 8, N, N], gained: 16 });
});

test('slideLine 對已靠前且無可合併的線不做事', () => {
  assert.deepEqual(slideLine([2, 4, 8, 16]), {
    line: [2, 4, 8, 16],
    gained: 0,
  });
});

// --------------------------------------------------------------------- move

test('move 左移:合併只發生一次,且新磚不會落在合併結果上', () => {
  const s = state(
    board([2, 2, 4, N], [N, N, N, N], [N, N, N, N], [N, N, N, N]),
  );
  const next = move(s, 'left', rngLast());
  assert.deepEqual(next.board.slice(0, 4), [4, 4, N, N]);
  assert.equal(next.moved, true);
});

test('move 四個方向彼此對稱', () => {
  const s = state(
    board([2, 2, N, N], [N, N, N, N], [N, N, N, N], [N, N, N, N]),
  );
  // 右移:同一列的磚被推到最右端。
  assert.deepEqual(move(s, 'right', rngLast()).board.slice(0, 4), [N, N, N, 4]);

  const col = state(
    board([2, N, N, N], [2, N, N, N], [N, N, N, N], [N, N, N, N]),
  );
  // 上移:第 0 行合成 4 落在頂端。
  assert.equal(move(col, 'up', rngLast()).board[0], 4);
  // 下移:同樣合成 4,落在該行底端(索引 12)。
  assert.equal(move(col, 'down', rngLast()).board[12], 4);
});

test('move 分數累加本次所有合併結果之和', () => {
  const s = state(
    board([2, 2, N, N], [4, 4, N, N], [N, N, N, N], [N, N, N, N]),
    100,
  );
  // 4 + 8 = 12
  assert.equal(move(s, 'left', rngLast()).score, 112);
});

test('move 沒有磚移動時:盤面不變、不落新磚、不加分', () => {
  const b = board([2, 4, 8, 16], [N, N, N, N], [N, N, N, N], [N, N, N, N]);
  const s = state(b, 50);
  const next = move(s, 'left', rngLast());
  assert.equal(next.moved, false);
  assert.deepEqual(next.board, b);
  assert.equal(next.score, 50);
  // 原本就 4 顆,撞牆後還是 4 顆 —— 撞牆不該平白送一顆新磚。
  assert.equal(next.board.filter((c) => c !== null).length, 4);
});

test('move 落下的新磚只在空格,且是 2 或 4', () => {
  const s = state(
    board([2, 2, N, N], [N, N, N, N], [N, N, N, N], [N, N, N, N]),
  );
  // rng: 位置 0 → 第一個空格;值 0.95 → 4(門檻是 0.9)
  const next = move(s, 'left', seqRng(0, 0.95));
  const spawned = next.board.filter((c) => c === 4);
  assert.equal(spawned.length, 1, '應該只落一顆 4');
  assert.equal(next.board.filter((c) => c !== null).length, 2);
});

test('move 合出 2048 時 won 為真,而且還能繼續玩', () => {
  const s = state(
    board([1024, 1024, N, N], [N, N, N, N], [N, N, N, N], [N, N, N, N]),
  );
  const next = move(s, 'left', rngLast());
  assert.equal(next.won, true);
  assert.equal(next.over, false);
});

test('move 保留已經達成的 won,不會在後續移動中被清掉', () => {
  const s: GameState = {
    board: board([2, 2, N, N], [N, N, N, N], [N, N, N, N], [N, N, N, N]),
    score: 0,
    won: true,
    over: false,
  };
  assert.equal(move(s, 'left', rngLast()).won, true);
});

// --------------------------------------------------------------- isGameOver

test('isGameOver:棋盤滿但仍有相鄰同值 → 沒結束', () => {
  const b = board(
    [2, 2, 4, 8],
    [4, 8, 16, 32],
    [2, 4, 8, 16],
    [4, 8, 16, 32],
  );
  assert.equal(isGameOver(b), false);
});

test('isGameOver:棋盤滿且四方向皆無可合併 → 結束', () => {
  const b = board(
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  );
  assert.equal(isGameOver(b), true);
});

test('isGameOver:還有空格就一定沒結束', () => {
  const b = board(
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, N],
  );
  assert.equal(isGameOver(b), false);
});

test('isGameOver 認得直向的可合併', () => {
  const b = board(
    [2, 4, 2, 4],
    [2, 2, 4, 2],
    [4, 4, 2, 4],
    [2, 2, 4, 2],
  );
  assert.equal(isGameOver(b), false);
});

// ------------------------------------------------------------------ newGame

test('newGame 落兩顆磚、零分、未結束', () => {
  const s = newGame(seqRng(0, 0, 0, 0));
  assert.equal(s.board.length, 16);
  assert.equal(s.board.filter((c) => c !== null).length, 2);
  assert.equal(s.score, 0);
  assert.equal(s.won, false);
  assert.equal(s.over, false);
});

test('newGame 的兩顆磚不會疊在同一格', () => {
  // 兩次都要求「第一個空格」,第二顆仍必須另外找位置。
  const s = newGame(seqRng(0, 0, 0, 0));
  const filled = s.board
    .map((c, i) => (c !== null ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(new Set(filled).size, 2);
});
