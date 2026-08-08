import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { RotateCcw, Trophy } from 'lucide-react';
import { api } from '../lib/api';
import { Avatar } from '../components/Avatar';
import {
  newGame,
  move,
  type Dir,
  type GameState,
} from '../lib/game2048';

// 2048 —— 純休息用,跟題庫完全解耦。
//
// 引擎在 ../lib/game2048.ts(純函式,有單元測試),這一頁只負責:接使用者的
// 輸入、畫盤面、把狀態 debounce 推到 Durable Object。
//
// 資料流單向:掛載時 GET 一次當初始值,之後只往外推,伺服器從不回推。同一個
// 人不會同時在兩台裝置上玩同一局,所以不需要即時同步。

type Saved = { state: GameState | null; best: number; at: number | null };
type LeaderRow = {
  email: string;
  displayName: string;
  avatarKey: string | null;
  best: number;
  at: number;
  me: boolean;
};

// 磚塊配色:單一色相的明度階梯,低數字貼近 cream 底、越大越往 ink 走,
// 最後兩階交給 accent 收尾。不發明九種顏色,對比度也就不必逐格調。
// 電子紙:九階明度在 1-bit 下會全部塌成白底,盤面只剩浮空的數字、看不出格線
// (實際截圖確認過)。改用三階的框線語彙 —— 數字本身才是這個遊戲的主要資訊,
// 明度階梯一直都只是輔助。
const TILE: Record<number, string> = {
  2: 'bg-ink-100 text-ink-600 dark:bg-ink-700 dark:text-ink-200 eink:border eink:border-black',
  4: 'bg-ink-200 text-ink-700 dark:bg-ink-600 dark:text-ink-100 eink:border eink:border-black',
  8: 'bg-ink-300 text-ink-800 dark:bg-ink-500 dark:text-ink-50 eink:border eink:border-black',
  16: 'bg-ink-400 text-ink-50 eink:border eink:border-black',
  32: 'bg-ink-500 text-ink-50 eink:border eink:border-black',
  64: 'bg-ink-600 text-ink-50 eink:border eink:border-black',
  128: 'bg-ink-700 text-ink-50 eink:border-2 eink:border-black',
  256: 'bg-ink-800 text-ink-50 eink:border-2 eink:border-black',
  512: 'bg-ink-900 text-ink-50 eink:border-2 eink:border-black',
  1024: 'bg-accent-light text-white eink-invert',
};
const TILE_2048 = 'bg-accent text-white eink-invert';

function tileClass(v: number): string {
  return TILE[v] ?? TILE_2048;
}

// 四位數要縮字級,否則在手機上會被擠出格子。
function tileFont(v: number): string {
  if (v >= 1024) return 'text-lg sm:text-2xl';
  if (v >= 128) return 'text-xl sm:text-3xl';
  return 'text-2xl sm:text-4xl';
}

const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// 滑動判定門檻,避免把點擊誤判成一次移動。
const SWIPE_MIN = 30;

type Action =
  | { type: 'load'; state: GameState }
  | { type: 'move'; dir: Dir }
  | { type: 'new' };

function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'load':
      return action.state;
    case 'new':
      return newGame(Math.random);
    case 'move': {
      if (state.over) return state;
      const { moved, ...next } = move(state, action.dir, Math.random);
      return moved ? next : state;
    }
  }
}

export function Play() {
  const [state, dispatch] = useReducer(reducer, null, () => newGame(Math.random));
  const [best, setBest] = useState(0);
  const [board, setBoard] = useState<LeaderRow[] | null>(null);
  // 還沒把伺服器的存檔接回來之前不要往外推,否則會用開局盤面蓋掉舊局。
  const [loaded, setLoaded] = useState(false);

  // ---------------------------------------------------------------- 載入存檔
  useEffect(() => {
    let cancelled = false;
    api
      .get<Saved>('/api/play')
      .then((saved) => {
        if (cancelled) return;
        if (saved.state) dispatch({ type: 'load', state: saved.state });
        setBest(saved.best);
      })
      .catch(() => {
        /* 離線或沒存檔 —— 就從剛才開的新局玩起 */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    api
      .get<LeaderRow[]>('/api/play/leaderboard')
      .then(setBoard)
      .catch(() => setBoard([]));
  }, []);

  // ------------------------------------------------------------ 存檔(debounce)
  // 用 ref 拿最新的 state,這樣 flush 不必進 effect 的相依陣列、也就不會每一步
  // 都重掛監聽器。
  const latest = useRef(state);
  latest.current = state;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const flush = useCallback(() => {
    if (!dirty.current) return;
    dirty.current = false;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    api
      .put<{ ok: true; best: number }>('/api/play/state', { state: latest.current })
      // 回應形狀不對就當沒發生 —— 否則 setBest(undefined) 會讓「最高」顯示 NaN。
      .then((r) => {
        if (typeof r?.best === 'number') setBest(r.best);
      })
      .catch(() => {
        /* 離線:下一步移動會再試一次 */
      });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, loaded, flush]);

  // 手機最常見的離開方式是切到背景,那不會觸發 beforeunload —— 兩個都要接,
  // 否則最後幾步會掉。
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', flush);
    };
  }, [flush]);

  // -------------------------------------------------------------------- 輸入
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_DIR[e.key];
      if (!dir) return;
      // 不擋的話整頁會跟著方向鍵捲動。
      e.preventDefault();
      dispatch({ type: 'move', dir });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) return;
    const dir: Dir =
      Math.abs(dx) > Math.abs(dy)
        ? dx > 0
          ? 'right'
          : 'left'
        : dy > 0
          ? 'down'
          : 'up';
    dispatch({ type: 'move', dir });
  };

  const restart = () => {
    dispatch({ type: 'new' });
  };

  // -------------------------------------------------------------------- 畫面
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="font-serif text-2xl text-ink-900 dark:text-ink-100">2048</h1>
        <p className="text-sm text-ink-500 dark:text-ink-400 mt-1">
          讀累了就玩一下。方向鍵或滑動操作,進度會自己存,換裝置接得回來。
        </p>
      </header>

      <div className="flex flex-col lg:flex-row gap-8 items-start">
        <div className="w-full lg:max-w-[420px]">
          <div className="flex items-end justify-between mb-3">
            <div className="flex gap-6">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-ink-400 dark:text-ink-500">
                  分數
                </div>
                <div className="text-2xl font-mono text-ink-900 dark:text-ink-100 tabular-nums">
                  {state.score}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-ink-400 dark:text-ink-500">
                  最高
                </div>
                <div className="text-2xl font-mono text-ink-500 dark:text-ink-400 tabular-nums">
                  {Math.max(best, state.score)}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={restart}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-ink-600 dark:text-ink-300 border border-ink-200 dark:border-ink-700 rounded hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              <RotateCcw size={14} /> 新局
            </button>
          </div>

          <div
            className="relative aspect-square w-full bg-ink-100 dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-2 touch-none select-none"
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
          >
            <div className="grid grid-cols-4 grid-rows-4 gap-2 w-full h-full">
              {state.board.map((cell, i) => (
                <div
                  key={i}
                  className={
                    'flex items-center justify-center rounded font-mono font-semibold tabular-nums ' +
                    (cell === null
                      ? 'bg-ink-50 dark:bg-ink-900/50'
                      : `${tileClass(cell)} ${tileFont(cell)}`)
                  }
                >
                  {cell ?? ''}
                </div>
              ))}
            </div>

            {state.over && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-50/90 dark:bg-ink-900/90 rounded-lg">
                <div className="font-serif text-xl text-ink-900 dark:text-ink-100">
                  沒有路了
                </div>
                <div className="text-sm text-ink-500 dark:text-ink-400">
                  這局 {state.score} 分
                </div>
                <button
                  type="button"
                  onClick={restart}
                  className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-dark"
                >
                  再來一局
                </button>
              </div>
            )}
          </div>

          <p className="mt-3 text-xs text-ink-400 dark:text-ink-500">
            {state.won ? '已經合出 2048 了 —— 想繼續就繼續。' : '目標:合出 2048。'}
          </p>
        </div>

        <section className="w-full lg:flex-1">
          <h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 inline-flex items-center gap-2 mb-3">
            <Trophy size={16} className="text-accent" /> 最高分
          </h2>
          {board === null ? (
            <p className="text-sm text-ink-400 dark:text-ink-500 italic">載入中…</p>
          ) : board.length === 0 ? (
            <p className="text-sm text-ink-400 dark:text-ink-500 italic">
              還沒有人玩過。第一個上榜的就是你。
            </p>
          ) : (
            <ol className="space-y-1">
              {board.map((row, i) => (
                <li
                  key={row.email}
                  className={
                    'flex items-center gap-3 px-3 py-2 rounded border ' +
                    (row.me
                      ? 'bg-accent/5 border-accent/30'
                      : 'bg-white dark:bg-ink-800 border-ink-100 dark:border-ink-700')
                  }
                >
                  <span className="w-5 text-right text-sm font-mono text-ink-400 dark:text-ink-500 tabular-nums">
                    {i + 1}
                  </span>
                  <Avatar
                    email={row.email}
                    avatarKey={row.avatarKey}
                    name={row.displayName}
                    size={24}
                  />
                  <span className="flex-1 min-w-0 truncate text-sm text-ink-800 dark:text-ink-200">
                    {row.displayName}
                  </span>
                  <span className="font-mono text-sm text-ink-900 dark:text-ink-100 tabular-nums">
                    {row.best}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
