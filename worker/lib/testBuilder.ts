// 自訂測驗的篩選編譯器。純函式:輸入條件 → SQL 片段 + 參數,
// preview(算 COUNT)與 build(選題建 session)共用同一份,避免兩邊漂移。
//
// 語意:
//   status 之間 OR(「未做過 或 最近答錯」= 兩者聯集)
//   scope(year / group / tag)之間 AND,同一維度內部 OR
//   tag 用 OR — 與 GET /api/questions 的 AND(questions.ts 的
//   `HAVING COUNT(DISTINCT tag) = ?`)刻意不同:組卷時多選 tag 若取交集
//   幾乎必然回 0 題,使用者要的是「AML 或 MDS 都算」。

import { WRONG_PREDICATE } from './wrong-criterion.ts';

export type TestStatus = 'unseen' | 'wrong' | 'correct' | 'bookmarked';
export const ALL_STATUS: TestStatus[] = ['unseen', 'wrong', 'correct', 'bookmarked'];

export const DEFAULT_COUNT = 20;
export const MAX_COUNT = 100;

export type TestFilters = {
  status: TestStatus[]; // 空 = 不限
  years: number[];      // 空 = 不限
  groups: string[];     // 空 = 不限
  tags: string[];       // 空 = 不限
  count: number;        // 1..MAX_COUNT
  tutor: boolean;       // true = 每題作答後立刻揭曉答案與詳解
  timed: boolean;       // false = 不計時(碼表往上跑)
};

export type RawTestFilters = Partial<{
  status: TestStatus[];
  years: number[];
  groups: string[];
  tags: string[];
  count: number;
  tutor: boolean;
  timed: boolean;
}>;

/** 去重 + 保序。 */
function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return uniq(
    v
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

function intList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return uniq(
    v
      .map((x) => (typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN))
      .filter((n) => Number.isFinite(n))
      .map((n) => Math.trunc(n)),
  );
}

/** 不信任 client:未知狀態剔除、題數夾值、空陣列一律代表「不限」。 */
export function normalizeFilters(raw: RawTestFilters | undefined): TestFilters {
  const r = raw ?? {};
  const rawCount = typeof r.count === 'number' && Number.isFinite(r.count) ? Math.trunc(r.count) : DEFAULT_COUNT;
  return {
    status: strList(r.status).filter((s): s is TestStatus => (ALL_STATUS as string[]).includes(s)),
    years: intList(r.years),
    groups: strList(r.groups),
    tags: strList(r.tags),
    count: Math.min(Math.max(rawCount, 1), MAX_COUNT),
    tutor: r.tutor === true,
    timed: r.timed !== false, // 預設計時
  };
}

// 狀態片段。「最近答錯」跟錯題回顧共用同一個定義(lib/wrong-criterion.ts)——
// 出卷精靈這顆勾選框正是清單頁「把這些出成一份測驗 →」連過來的目的地,兩邊判準
// 不同的話,出來的題目跟畫面上那份清單對不起來。
const STATUS_SQL: Record<TestStatus, string> = {
  unseen: '(rp.question_id IS NULL OR rp.times_seen = 0)',
  wrong: WRONG_PREDICATE,
  correct: '(rp.times_correct > 0)',
  bookmarked: '(bi.question_id IS NOT NULL)',
};

// 兩個 LEFT JOIN 固定存在(狀態判斷需要),所以 params 前兩個永遠是 email。
export const TEST_JOIN_SQL =
  'LEFT JOIN review_progress rp ON rp.question_id = q.id AND rp.user_email = ? ' +
  'LEFT JOIN bookmark_items  bi ON bi.question_id = q.id AND bi.user_email = ?';

export function buildTestFilter(
  f: TestFilters,
  email: string,
): { joinSql: string; whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [email, email];

  if (f.status.length > 0) {
    clauses.push('(' + f.status.map((s) => STATUS_SQL[s]).join(' OR ') + ')');
  }
  if (f.years.length > 0) {
    clauses.push(`q.year IN (${f.years.map(() => '?').join(',')})`);
    params.push(...f.years);
  }
  if (f.groups.length > 0) {
    clauses.push(`q."group" IN (${f.groups.map(() => '?').join(',')})`);
    params.push(...f.groups);
  }
  if (f.tags.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM question_tags qt WHERE qt.question_id = q.id AND qt.tag IN (${f.tags
        .map(() => '?')
        .join(',')}))`,
    );
    params.push(...f.tags);
  }

  return {
    joinSql: TEST_JOIN_SQL,
    whereSql: clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '',
    params,
  };
}
