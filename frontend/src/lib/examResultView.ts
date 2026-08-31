/**
 * 成績頁的「我剛才看到哪裡」—— 篩選、展開全部、捲動位置。
 *
 * 從 `/exam/:sid/result` 點進某一題再走回來(見 Question.tsx 的「全真結果」),
 * 舊版一律回到列表最上面。檢討一百題時那代表每看一題就要重新捲一次,而使用者
 * 記得的是「我剛才在中間偏下」,不是第幾題。
 *
 * ## 為什麼只存捲動位置不夠
 *
 * 這一頁的預設篩選是「答錯/未答」,而列表長度隨篩選變。只還原 y 的話,使用者
 * 切到「全部」看到一半點進去,回來會落在一份**比較短的清單**上的同一個 y ——
 * 位置是錯的,而且看起來像「隨便跳」。`expandAll` 同理(展開全部之後整頁高度
 * 是好幾倍)。所以三個一起存,還原的才是「同一個畫面」。
 *
 * ## 為什麼是 sessionStorage
 *
 * 這是**畫面狀態**不是 app state(CLAUDE.md 那條「localStorage for app state」
 * 講的是後者)—— 伺服器不需要知道,別的裝置也不該跟著跳。sessionStorage 還順手
 * 給了一個正確的壽命:分頁關掉就沒了,所以下次重新打開這場成績是從頭開始看,
 * 而不是掉進三週前的捲動位置。同 `lib/drafts.ts`。
 */

export type ExamResultFilter = 'all' | 'wrong' | 'right' | 'flagged';

export type ExamResultView = {
  filter: ExamResultFilter;
  expandAll: boolean;
  /** window.scrollY */
  y: number;
};

const FILTERS: ExamResultFilter[] = ['all', 'wrong', 'right', 'flagged'];

/** 沒存過、存壞了、或形狀過期時的落點 —— 就是這一頁原本的初始狀態。 */
export const DEFAULT_EXAM_RESULT_VIEW: ExamResultView = {
  filter: 'wrong',
  expandAll: false,
  y: 0,
};

const PREFIX = 'exam-result-view:';

/**
 * ⚠️ 每個欄位都要驗,不能 `JSON.parse` 完直接用。存進去的是**上一版的前端**寫的,
 * 而這一頁的篩選值改過名字的話,`filter` 會是一個誰都不認得的字串 —— 症狀是
 * 列表整個空掉、四顆篩選鈕沒有一顆是亮的,看起來像資料壞了而不是快取過期。
 */
export function parseExamResultView(raw: string | null): ExamResultView {
  if (!raw) return DEFAULT_EXAM_RESULT_VIEW;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return DEFAULT_EXAM_RESULT_VIEW;
  }
  if (typeof v !== 'object' || v === null) return DEFAULT_EXAM_RESULT_VIEW;
  const o = v as Record<string, unknown>;
  const filter = FILTERS.includes(o.filter as ExamResultFilter)
    ? (o.filter as ExamResultFilter)
    : DEFAULT_EXAM_RESULT_VIEW.filter;
  // 非有限數(NaN / Infinity,`JSON.stringify` 會寫成 null)與負數一律歸零 ——
  // `scrollTo` 吃到 NaN 是靜靜不動,那會讓「還原壞掉」看起來像「沒有這個功能」。
  const n = o.y;
  const y = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  return { filter, expandAll: o.expandAll === true, y };
}

export function readExamResultView(sid: string | undefined): ExamResultView {
  if (!sid) return DEFAULT_EXAM_RESULT_VIEW;
  try {
    return parseExamResultView(sessionStorage.getItem(PREFIX + sid));
  } catch {
    return DEFAULT_EXAM_RESULT_VIEW;
  }
}

export function writeExamResultView(sid: string | undefined, v: ExamResultView) {
  if (!sid) return;
  try {
    sessionStorage.setItem(PREFIX + sid, JSON.stringify(v));
  } catch {
    /* 私密瀏覽 / 配額 —— 還原不了就是回到最上面,跟以前一樣 */
  }
}
