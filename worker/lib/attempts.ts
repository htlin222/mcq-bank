import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

/** 單題耗時上限 30 分鐘。前端已在 10 分鐘截斷(questionTimer),
 *  這層只防惡意 / 時鐘跳動的離譜值。 */
export const MAX_ELAPSED_MS = 30 * 60 * 1000;

export type AttemptSource = 'review' | 'exam' | 'drill' | 'anki';

/** 不信任 client:非有限數字一律 null,其餘夾進 [0, MAX_ELAPSED_MS]。 */
export function clampElapsedMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(Math.max(Math.trunc(v), 0), MAX_ELAPSED_MS);
}

/** Append 一筆作答事件。回傳 statement(不執行),讓呼叫端併進 batch()
 *  與聚合寫入同一交易。 */
export function insertAttemptOp(args: {
  db: D1Database;
  email: string;
  questionId: string;
  chosen: string | null;
  isCorrect: 0 | 1 | null;
  source: AttemptSource;
  sessionId?: string | null;
  elapsedMs: number | null;
  now: number;
}): D1PreparedStatement {
  return args.db
    .prepare(
      `INSERT INTO attempts
       (user_email, question_id, chosen, is_correct, source, session_id, elapsed_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      args.email,
      args.questionId,
      args.chosen,
      args.isCorrect,
      args.source,
      args.sessionId ?? null,
      args.elapsedMs,
      args.now,
    );
}
