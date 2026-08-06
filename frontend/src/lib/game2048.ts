// 2048 的遊戲引擎 —— 純函式,沒有 React、沒有 fetch、不碰 Math.random()。
//
// 移動合併的規則移植自原版(gabrielecirulli/2048,MIT),不重寫:其中
// 「同一次移動中已經合併過的磚,不能再參與第二次合併」這條,憑印象寫很容易
// 錯,而錯了之後只是玩起來怪怪的,不會壞給你看。
//
// rng 由呼叫端注入(正常玩傳 Math.random,測試傳固定序列),所以「新磚落在
// 哪一格」在測試裡是可決定的。spawn 會呼叫 rng 兩次:**先位置、後決定 2/4**。
//
// GameState 直接可 JSON 序列化,也就是直接可以塞進 Durable Object,中間不需要
// 任何轉換層。

export const SIZE = 4;
export const CELLS = SIZE * SIZE;

/** 扁平的 4×4 盤面,索引 = row * 4 + col。空格是 null。 */
export type Board = (number | null)[];
export type Dir = 'up' | 'down' | 'left' | 'right';
export type Rng = () => number;

export type GameState = {
  board: Board;
  score: number;
  /** 曾經合出 2048。合出來之後仍可續玩,所以這個旗標只會由 false 變 true。 */
  won: boolean;
  over: boolean;
};

/** 新磚是 4 而不是 2 的機率門檻 —— rng() >= 0.9 才給 4,跟原版一致。 */
const FOUR_THRESHOLD = 0.9;

export const DIRS: Dir[] = ['up', 'down', 'left', 'right'];

export function emptyBoard(): Board {
  return new Array<number | null>(CELLS).fill(null);
}

/**
 * 一條線往「前緣」滑動並合併。這是整個引擎唯一有合併邏輯的地方 —— 四個方向
 * 都化約成對這個函式的呼叫,所以規則只需要正確一次。
 *
 * merged 旗標擋掉連鎖合併:[2,2,4] → [4,4],不是 [8]。
 */
export function slideLine(line: (number | null)[]): {
  line: (number | null)[];
  gained: number;
} {
  const tiles = line.filter((c): c is number => c !== null);
  const out: (number | null)[] = [];
  let gained = 0;

  for (let i = 0; i < tiles.length; i++) {
    // 後一顆同值,而且這一顆還沒被合併過 → 吃掉它。
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const merged = tiles[i] * 2;
      out.push(merged);
      gained += merged;
      i++; // 跳過被吃掉的那顆,它不能再參與下一次合併
    } else {
      out.push(tiles[i]);
    }
  }

  while (out.length < SIZE) out.push(null);
  return { line: out, gained };
}

/**
 * 某個方向的第 n 條線,依「離前緣由近到遠」列出盤面索引。
 * 例如 'right' 的第 0 列是 [3, 2, 1, 0] —— 前緣在右邊。
 */
function lineIndices(dir: Dir, n: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < SIZE; i++) {
    switch (dir) {
      case 'left':
        idx.push(n * SIZE + i);
        break;
      case 'right':
        idx.push(n * SIZE + (SIZE - 1 - i));
        break;
      case 'up':
        idx.push(i * SIZE + n);
        break;
      case 'down':
        idx.push((SIZE - 1 - i) * SIZE + n);
        break;
    }
  }
  return idx;
}

/** 落一顆新磚。盤面沒空格時原樣回傳。 */
function spawn(board: Board, rng: Rng): Board {
  const empty: number[] = [];
  for (let i = 0; i < board.length; i++) if (board[i] === null) empty.push(i);
  if (empty.length === 0) return board;

  const at = empty[Math.min(empty.length - 1, Math.floor(rng() * empty.length))];
  const next = board.slice();
  next[at] = rng() < FOUR_THRESHOLD ? 2 : 4;
  return next;
}

export function isGameOver(board: Board): boolean {
  if (board.some((c) => c === null)) return false;

  // 滿盤時只要還有任何一對相鄰同值,就還有得走。
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board[r * SIZE + c];
      if (c + 1 < SIZE && board[r * SIZE + c + 1] === v) return false;
      if (r + 1 < SIZE && board[(r + 1) * SIZE + c] === v) return false;
    }
  }
  return true;
}

export function newGame(rng: Rng): GameState {
  return {
    board: spawn(spawn(emptyBoard(), rng), rng),
    score: 0,
    won: false,
    over: false,
  };
}

/**
 * 往 dir 移動一步。沒有任何磚移動時(moved === false),盤面、分數都原樣回傳,
 * 而且**不落新磚** —— 撞牆不該平白送你一顆。
 */
export function move(
  state: GameState,
  dir: Dir,
  rng: Rng,
): GameState & { moved: boolean } {
  const next = state.board.slice();
  let gained = 0;

  for (let n = 0; n < SIZE; n++) {
    const idx = lineIndices(dir, n);
    const { line, gained: g } = slideLine(idx.map((i) => state.board[i]));
    idx.forEach((boardIdx, i) => {
      next[boardIdx] = line[i];
    });
    gained += g;
  }

  const moved = next.some((c, i) => c !== state.board[i]);
  if (!moved) return { ...state, moved: false };

  const board = spawn(next, rng);
  return {
    board,
    score: state.score + gained,
    won: state.won || board.some((c) => c !== null && c >= 2048),
    over: isGameOver(board),
    moved: true,
  };
}
