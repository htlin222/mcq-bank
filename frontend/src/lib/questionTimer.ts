// 單題計時 — 純函式狀態機,不註冊 listener、不讀 Date.now(),
// 時間一律由呼叫端傳入(好測、也讓 React 端自己決定何時取樣)。
//
// 核心風險是「離開分頁去查資料」汙染耗時,所以只累加「可見且未暫停」
// 的區間。狀態欄位刻意與 worker 端 exam_sessions 的
// elapsed_ms / running_since 同構。

/** 單題硬上限 10 分鐘。超過即截斷並標 outlier;伺服器另有 30 分鐘的
 *  防護夾值(worker/lib/attempts.ts 的 MAX_ELAPSED_MS)。 */
export const MAX_QUESTION_MS = 10 * 60 * 1000;

export type TimerState = {
  accumulatedMs: number;
  /** null = 停止中(分頁隱藏或已暫停) */
  runningSince: number | null;
};

export function startTimer(now: number): TimerState {
  return { accumulatedMs: 0, runningSince: now };
}

/** 停止計時。已停止就原樣回傳(冪等 — 瀏覽器會重放 visibilitychange)。 */
function stop(t: TimerState, now: number): TimerState {
  if (t.runningSince === null) return t;
  return { accumulatedMs: t.accumulatedMs + (now - t.runningSince), runningSince: null };
}

/** 開始計時。已在跑就原樣回傳(冪等,不重設起點)。 */
function start(t: TimerState, now: number): TimerState {
  if (t.runningSince !== null) return t;
  return { accumulatedMs: t.accumulatedMs, runningSince: now };
}

// hide/show 與 pause/resume 共用實作,但保留兩組名稱以表達意圖:
// 前者來自 visibilitychange,後者來自模擬考的暫停鈕。
export const hide = stop;
export const show = start;
export const pause = stop;
export const resume = start;

export function read(t: TimerState, now: number): { elapsedMs: number; outlier: boolean } {
  const raw = t.accumulatedMs + (t.runningSince === null ? 0 : now - t.runningSince);
  return {
    elapsedMs: Math.min(raw, MAX_QUESTION_MS),
    outlier: raw > MAX_QUESTION_MS,
  };
}
