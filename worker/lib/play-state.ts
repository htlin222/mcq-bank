// 2048 盤面的伺服器端驗證。
//
// 立場先講明白:**這裡不防作弊,只防資料汙染。** 要真的防作弊,得在 server
// 重放整局移動;對 20 個熟人的休息小遊戲那是過度設計。這個函式的工作只是讓
// 一個壞掉的 client、或一次手滑的 curl,不會把 Durable Object 塞進之後解析
// 不出來的狀態。榜單上出現離譜分數,社交壓力自會處理。
//
// GameState 的型別在 frontend/src/lib/game2048.ts —— 這裡刻意不跨界 import
// (跟 worker/lib/helpful.ts ↔ frontend/src/lib/helpful.ts 同樣的處理),
// 只複寫一份結構檢查。改動盤面形狀時兩邊要一起改。

/** 16 格的 4×4 盤面。 */
export const CELLS = 16;

/** 2^17。真人玩不到,但留足空間讓合法的極端局面不會被誤擋。 */
export const MAX_TILE = 131072;

/** 分數上限,同樣只是防呆用的天花板。 */
export const MAX_SCORE = 10_000_000;

export type StoredState = {
  board: (number | null)[];
  score: number;
  won: boolean;
  over: boolean;
};

function isPowerOfTwoTile(v: number): boolean {
  return (
    Number.isInteger(v) &&
    v >= 2 &&
    v <= MAX_TILE &&
    (v & (v - 1)) === 0 // 2 的次方:二進位只有一個 1
  );
}

export function isValidState(v: unknown): v is StoredState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;

  if (typeof s.won !== 'boolean' || typeof s.over !== 'boolean') return false;

  if (
    typeof s.score !== 'number' ||
    !Number.isInteger(s.score) ||
    s.score < 0 ||
    s.score > MAX_SCORE
  ) {
    return false;
  }

  if (!Array.isArray(s.board) || s.board.length !== CELLS) return false;
  for (const cell of s.board) {
    if (cell === null) continue;
    if (typeof cell !== 'number' || !isPowerOfTwoTile(cell)) return false;
  }

  return true;
}
