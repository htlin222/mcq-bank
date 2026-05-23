/**
 * Pure state machine for answer-challenge resolution.
 * No DB, no Workers, no side effects — just inputs → next decision.
 * Lives in its own file so unit tests can import it with native node:test
 * without dragging in @cloudflare/workers-types or the D1 helpers.
 */

// ──────────────────────────────────────────────────────────────
// Tunables
// ──────────────────────────────────────────────────────────────

/** Open challenges promote when this many non-proposer 同意 votes arrive
 *  with zero 反對 votes. */
export const FAST_RULE_AGREES = 2;

/** Contested challenges (any 反對 cast) require this many 同意 to promote. */
export const STRICT_RULE_AGREES = 4;

/** Contested-to-promote net floor: (agrees − disagrees). */
export const STRICT_RULE_NET = 3;

/** Contested-to-reject net ceiling: (agrees − disagrees). */
export const REJECT_NET = -2;

/** Time that must elapse since `contested_at` before strict promote/reject fires. */
export const CONTESTED_GATE_MS = 48 * 60 * 60 * 1000; // 48h

/** Inactivity window after which a contested challenge is archived. */
export const ARCHIVE_GATE_MS = 14 * 24 * 60 * 60 * 1000; // 14d

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type ChallengeStatus =
  | 'open'
  | 'contested'
  | 'promoted'
  | 'rejected'
  | 'archived'
  | 'withdrawn';

export type DecisionInput = {
  status: ChallengeStatus;
  agrees: number;
  disagrees: number;
  /** ms timestamp when first disagree arrived; null while still 'open'. */
  contestedAt: number | null;
  /** ms timestamp of the most recent vote insert/update; falls back to challenge.created_at. */
  lastActivityAt: number;
  now: number;
};

export type Decision =
  | { next: 'no-change' }
  | { next: 'open->contested' }
  | { next: 'promote'; reason: 'auto:fast' | 'auto:strict' }
  | { next: 'reject'; reason: 'auto:rejected' }
  | { next: 'archive'; reason: 'auto:archived' };

// ──────────────────────────────────────────────────────────────
// Decision function
// ──────────────────────────────────────────────────────────────

/**
 * Decide the next transition based purely on inputs. No DB access.
 * Callers are responsible for applying the side effects (DB writes, notifications).
 *
 *  open
 *    + agrees ≥ FAST_RULE_AGREES + disagrees == 0       → promote (fast)
 *    + disagrees ≥ 1                                    → open->contested
 *  contested
 *    + agrees ≥ STRICT_RULE_AGREES
 *      AND (agrees − disagrees) ≥ STRICT_RULE_NET
 *      AND (now − contested_at) ≥ CONTESTED_GATE_MS    → promote (strict)
 *    + (agrees − disagrees) ≤ REJECT_NET
 *      AND (now − contested_at) ≥ CONTESTED_GATE_MS    → reject
 *    + (now − lastActivityAt) ≥ ARCHIVE_GATE_MS         → archive
 *  terminal states: no-change
 */
export function decide(d: DecisionInput): Decision {
  if (
    d.status === 'promoted' ||
    d.status === 'rejected' ||
    d.status === 'archived' ||
    d.status === 'withdrawn'
  ) {
    return { next: 'no-change' };
  }

  const net = d.agrees - d.disagrees;

  if (d.status === 'open') {
    if (d.agrees >= FAST_RULE_AGREES && d.disagrees === 0) {
      return { next: 'promote', reason: 'auto:fast' };
    }
    if (d.disagrees >= 1) {
      return { next: 'open->contested' };
    }
    return { next: 'no-change' };
  }

  // status === 'contested'
  const contestedFor = d.contestedAt === null ? 0 : d.now - d.contestedAt;

  if (
    d.agrees >= STRICT_RULE_AGREES &&
    net >= STRICT_RULE_NET &&
    contestedFor >= CONTESTED_GATE_MS
  ) {
    return { next: 'promote', reason: 'auto:strict' };
  }
  if (net <= REJECT_NET && contestedFor >= CONTESTED_GATE_MS) {
    return { next: 'reject', reason: 'auto:rejected' };
  }
  if (d.now - d.lastActivityAt >= ARCHIVE_GATE_MS) {
    return { next: 'archive', reason: 'auto:archived' };
  }
  return { next: 'no-change' };
}
