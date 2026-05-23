import type { D1Database } from '@cloudflare/workers-types';
import type { Explanation } from '../types';

const LOCK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

export type LockResult =
  | { ok: true; until: number }
  | { ok: false; lockedBy: string; until: number };

/**
 * Try to acquire (or extend) the edit lock on an explanation.
 * If the existing lock is held by the same user OR has expired, we succeed.
 */
export async function tryLock(
  db: D1Database,
  questionId: string,
  email: string,
  now: number = Date.now()
): Promise<LockResult> {
  const row = await db
    .prepare('SELECT editing_by, editing_until FROM explanations WHERE question_id = ?')
    .bind(questionId)
    .first<{ editing_by: string | null; editing_until: number | null }>();

  if (!row) {
    // Auto-create explanation row if missing
    await db
      .prepare(
        `INSERT INTO explanations (question_id, editing_by, editing_until, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(questionId, email, now + LOCK_DURATION_MS, now)
      .run();
    return { ok: true, until: now + LOCK_DURATION_MS };
  }

  const isLocked =
    row.editing_by &&
    row.editing_until &&
    row.editing_until > now &&
    row.editing_by !== email;

  if (isLocked) {
    return {
      ok: false,
      lockedBy: row.editing_by!,
      until: row.editing_until!,
    };
  }

  const until = now + LOCK_DURATION_MS;
  await db
    .prepare(
      `UPDATE explanations SET editing_by = ?, editing_until = ? WHERE question_id = ?`
    )
    .bind(email, until, questionId)
    .run();

  return { ok: true, until };
}

export async function releaseLock(
  db: D1Database,
  questionId: string,
  email: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE explanations SET editing_by = NULL, editing_until = NULL
       WHERE question_id = ? AND editing_by = ?`
    )
    .bind(questionId, email)
    .run();
}

/**
 * Extract mentions from a TipTap doc JSON.
 * TipTap's @mention extension creates nodes like:
 *   { type: 'mention', attrs: { id: 'alice@example.com', label: 'Alice' } }
 */
export function extractMentions(contentJson: string): string[] {
  try {
    const doc = JSON.parse(contentJson);
    const emails = new Set<string>();
    walk(doc, (node) => {
      if (node?.type === 'mention' && node.attrs?.id) {
        emails.add(node.attrs.id);
      }
    });
    return [...emails];
  } catch {
    return [];
  }
}

function walk(node: any, fn: (n: any) => void) {
  if (!node) return;
  fn(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) walk(child, fn);
  }
}

/**
 * Lightweight excerpt from TipTap JSON for notification preview.
 */
export function excerpt(contentJson: string, maxLen = 80): string {
  try {
    const doc = JSON.parse(contentJson);
    const parts: string[] = [];
    walk(doc, (n) => {
      if (n?.type === 'text' && typeof n.text === 'string') parts.push(n.text);
    });
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  } catch {
    return '';
  }
}

export function uuid(): string {
  return crypto.randomUUID();
}
