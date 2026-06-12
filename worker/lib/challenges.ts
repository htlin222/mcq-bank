import type { D1Database } from '@cloudflare/workers-types';
import { uuid, excerpt, optionsToRecord } from './db';
import { decide, type ChallengeStatus } from './challenges-state';

// Re-export so consumers can keep importing from this module.
export {
  decide,
  FAST_RULE_AGREES,
  STRICT_RULE_AGREES,
  STRICT_RULE_NET,
  REJECT_NET,
  CONTESTED_GATE_MS,
  ARCHIVE_GATE_MS,
} from './challenges-state';
export type { ChallengeStatus, DecisionInput, Decision } from './challenges-state';

const VALID_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
type Letter = (typeof VALID_LETTERS)[number];

// ──────────────────────────────────────────────────────────────
// DB row types
// ──────────────────────────────────────────────────────────────

export type Challenge = {
  id: string;
  question_id: string;
  proposer_email: string;
  proposed_answer: string;
  original_answer_at_challenge: string;
  rationale_json: string;
  status: ChallengeStatus;
  contested_at: number | null;
  created_at: number;
  resolved_at: number | null;
  resolution_reason: string | null;
};

export type ChallengeCounts = {
  agrees: number;
  disagrees: number;
  /** Most-recent vote upsert timestamp; null when no votes exist yet. */
  last_vote_at: number | null;
};

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function isLetter(s: string): s is Letter {
  return (VALID_LETTERS as readonly string[]).includes(s);
}

async function loadChallenge(db: D1Database, id: string): Promise<Challenge | null> {
  return db
    .prepare('SELECT * FROM answer_challenges WHERE id = ?')
    .bind(id)
    .first<Challenge>();
}

async function loadCounts(db: D1Database, id: string): Promise<ChallengeCounts> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN vote = 'agree'    THEN 1 ELSE 0 END) AS agrees,
         SUM(CASE WHEN vote = 'disagree' THEN 1 ELSE 0 END) AS disagrees,
         MAX(updated_at) AS last_vote_at
       FROM challenge_votes
       WHERE challenge_id = ?`
    )
    .bind(id)
    .first<{ agrees: number | null; disagrees: number | null; last_vote_at: number | null }>();
  return {
    agrees: row?.agrees ?? 0,
    disagrees: row?.disagrees ?? 0,
    last_vote_at: row?.last_vote_at ?? null,
  };
}

async function loadAllUserEmails(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT email FROM users').all<{ email: string }>();
  return results.map((r) => r.email);
}

function buildSystemNote(prevAnswer: string, newAnswer: string, now: number): unknown {
  const date = new Date(now).toLocaleDateString('zh-TW');
  const text = `⚠️ 本題答案於 ${date} 經社群挑戰修正為 ${newAnswer}(原為 ${prevAnswer})。詳解可能需要更新。`;
  return {
    type: 'blockquote',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', marks: [{ type: 'italic' }], text }],
      },
    ],
  };
}

function prependSystemNote(contentJson: string, note: unknown): string {
  try {
    const doc = JSON.parse(contentJson);
    if (doc && doc.type === 'doc' && Array.isArray(doc.content)) {
      doc.content = [note, ...doc.content];
      return JSON.stringify(doc);
    }
  } catch {
    /* fall through */
  }
  // Fallback: wrap whatever we have in a fresh doc with the note up top.
  return JSON.stringify({ type: 'doc', content: [note] });
}

// ──────────────────────────────────────────────────────────────
// Public: createChallenge
// ──────────────────────────────────────────────────────────────

export type CreateChallengeResult =
  | { ok: true; id: string }
  | { ok: false; status: 400 | 409; error: string };

export async function createChallenge(
  db: D1Database,
  proposerEmail: string,
  questionId: string,
  proposedAnswer: string,
  rationaleJson: unknown,
  now: number = Date.now()
): Promise<CreateChallengeResult> {
  if (!isLetter(proposedAnswer)) {
    return { ok: false, status: 400, error: 'invalid proposed_answer (must be A-E)' };
  }

  const q = await db
    .prepare('SELECT id, answer, options_json FROM questions WHERE id = ?')
    .bind(questionId)
    .first<{ id: string; answer: string; options_json: string }>();
  if (!q) return { ok: false, status: 400, error: 'question not found' };

  if (proposedAnswer === q.answer) {
    return { ok: false, status: 400, error: 'proposed_answer equals current answer' };
  }
  const options = optionsToRecord(q.options_json);
  if (!options[proposedAnswer]) {
    return { ok: false, status: 400, error: 'proposed_answer is not an option of this question' };
  }

  // Multiple actives per question are allowed, but only one per proposed
  // letter — a second person proposing the same answer should vote on the
  // existing challenge instead.
  const active = await db
    .prepare(
      `SELECT id FROM answer_challenges
       WHERE question_id = ? AND proposed_answer = ? AND status IN ('open', 'contested')
       LIMIT 1`
    )
    .bind(questionId, proposedAnswer)
    .first<{ id: string }>();
  if (active) {
    return { ok: false, status: 409, error: 'an active challenge for this answer already exists' };
  }

  const id = uuid();
  const rationaleStr = JSON.stringify(rationaleJson);
  try {
    await db
      .prepare(
        `INSERT INTO answer_challenges
           (id, question_id, proposer_email, proposed_answer,
            original_answer_at_challenge, rationale_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
      )
      .bind(id, questionId, proposerEmail, proposedAnswer, q.answer, rationaleStr, now)
      .run();
  } catch (e) {
    // Race on the partial UNIQUE (question_id, proposed_answer) index.
    if (String(e).includes('UNIQUE')) {
      return { ok: false, status: 409, error: 'an active challenge for this answer already exists' };
    }
    throw e;
  }

  await fanoutFiledNotifications(db, {
    challengeId: id,
    questionId,
    proposerEmail,
    proposedAnswer,
    originalAnswer: q.answer,
    rationaleStr,
    now,
  });

  return { ok: true, id };
}

async function fanoutFiledNotifications(
  db: D1Database,
  args: {
    challengeId: string;
    questionId: string;
    proposerEmail: string;
    proposedAnswer: string;
    originalAnswer: string;
    rationaleStr: string;
    now: number;
  }
) {
  const emails = await loadAllUserEmails(db);
  const recipients = emails.filter((e) => e !== args.proposerEmail);
  if (recipients.length === 0) return;
  const rationaleExcerpt = excerpt(args.rationaleStr, 60);
  const preview = `主張答案應為 ${args.proposedAnswer}(原 ${args.originalAnswer})${rationaleExcerpt ? ' · ' + rationaleExcerpt : ''}`;
  const ops = recipients.map((r) =>
    db
      .prepare(
        `INSERT INTO notifications
           (id, recipient, kind, question_id, challenge_id, actor_email, preview, created_at)
         VALUES (?, ?, 'challenge_filed', ?, ?, ?, ?, ?)`
      )
      .bind(uuid(), r, args.questionId, args.challengeId, args.proposerEmail, preview, args.now)
  );
  await db.batch(ops);
}

// ──────────────────────────────────────────────────────────────
// Public: castVote / retractVote
// ──────────────────────────────────────────────────────────────

export type CastVoteResult =
  | { ok: true; status: ChallengeStatus; resolution?: 'promote' | 'reject' | 'archive' }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

export async function castVote(
  db: D1Database,
  voterEmail: string,
  challengeId: string,
  vote: 'agree' | 'disagree',
  commentJson: unknown | null,
  now: number = Date.now()
): Promise<CastVoteResult> {
  if (vote !== 'agree' && vote !== 'disagree') {
    return { ok: false, status: 400, error: 'vote must be agree|disagree' };
  }

  const ch = await loadChallenge(db, challengeId);
  if (!ch) return { ok: false, status: 404, error: 'challenge not found' };
  if (ch.proposer_email === voterEmail) {
    return { ok: false, status: 403, error: 'proposer cannot vote on own challenge' };
  }
  if (ch.status !== 'open' && ch.status !== 'contested') {
    return { ok: false, status: 409, error: `challenge is already ${ch.status}` };
  }

  const commentStr = commentJson == null ? null : JSON.stringify(commentJson);
  await db
    .prepare(
      `INSERT INTO challenge_votes
         (challenge_id, voter_email, vote, comment_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(challenge_id, voter_email)
       DO UPDATE SET vote = excluded.vote,
                     comment_json = excluded.comment_json,
                     updated_at = excluded.updated_at`
    )
    .bind(challengeId, voterEmail, vote, commentStr, now, now)
    .run();

  return await recomputeAndMaybeResolve(db, challengeId, now);
}

export async function retractVote(
  db: D1Database,
  voterEmail: string,
  challengeId: string,
  now: number = Date.now()
): Promise<CastVoteResult> {
  const ch = await loadChallenge(db, challengeId);
  if (!ch) return { ok: false, status: 404, error: 'challenge not found' };
  if (ch.status !== 'open' && ch.status !== 'contested') {
    return { ok: false, status: 409, error: `challenge is already ${ch.status}` };
  }

  await db
    .prepare('DELETE FROM challenge_votes WHERE challenge_id = ? AND voter_email = ?')
    .bind(challengeId, voterEmail)
    .run();

  return await recomputeAndMaybeResolve(db, challengeId, now);
}

// ──────────────────────────────────────────────────────────────
// Public: withdraw
// ──────────────────────────────────────────────────────────────

export async function withdrawChallenge(
  db: D1Database,
  email: string,
  challengeId: string,
  now: number = Date.now()
): Promise<CastVoteResult> {
  const ch = await loadChallenge(db, challengeId);
  if (!ch) return { ok: false, status: 404, error: 'challenge not found' };
  if (ch.proposer_email !== email) {
    return { ok: false, status: 403, error: 'only the proposer can withdraw' };
  }
  if (ch.status !== 'open' && ch.status !== 'contested') {
    return { ok: false, status: 409, error: `challenge is already ${ch.status}` };
  }
  await db
    .prepare(
      `UPDATE answer_challenges
         SET status = 'withdrawn', resolved_at = ?, resolution_reason = 'withdrawn'
       WHERE id = ? AND status IN ('open', 'contested')`
    )
    .bind(now, challengeId)
    .run();
  return { ok: true, status: 'withdrawn' };
}

// ──────────────────────────────────────────────────────────────
// Public: recomputeAndMaybeResolve — called after each vote insert/update/delete
// and lazily on GETs of an active challenge.
// ──────────────────────────────────────────────────────────────

export async function recomputeAndMaybeResolve(
  db: D1Database,
  challengeId: string,
  now: number = Date.now()
): Promise<CastVoteResult> {
  const ch = await loadChallenge(db, challengeId);
  if (!ch) return { ok: false, status: 404, error: 'challenge not found' };
  if (ch.status !== 'open' && ch.status !== 'contested') {
    return { ok: true, status: ch.status };
  }

  const counts = await loadCounts(db, challengeId);
  const decision = decide({
    status: ch.status,
    agrees: counts.agrees,
    disagrees: counts.disagrees,
    contestedAt: ch.contested_at,
    lastActivityAt: counts.last_vote_at ?? ch.created_at,
    now,
  });

  if (decision.next === 'no-change') {
    return { ok: true, status: ch.status };
  }

  if (decision.next === 'open->contested') {
    // Promote to contested. Use a guarded UPDATE so concurrent transitions
    // don't double-set contested_at.
    await db
      .prepare(
        `UPDATE answer_challenges
           SET status = 'contested', contested_at = ?
         WHERE id = ? AND status = 'open'`
      )
      .bind(now, challengeId)
      .run();
    return { ok: true, status: 'contested' };
  }

  if (decision.next === 'promote') {
    await promote(db, ch, decision.reason, now);
    return { ok: true, status: 'promoted', resolution: 'promote' };
  }
  if (decision.next === 'reject') {
    await reject(db, ch, decision.reason, now);
    return { ok: true, status: 'rejected', resolution: 'reject' };
  }
  // archive
  await archive(db, ch, decision.reason, now);
  return { ok: true, status: 'archived', resolution: 'archive' };
}

// ──────────────────────────────────────────────────────────────
// Promote: flip the answer atomically with history + stale note + notifs.
// ──────────────────────────────────────────────────────────────

async function promote(
  db: D1Database,
  ch: Challenge,
  reason: 'auto:fast' | 'auto:strict',
  now: number
): Promise<void> {
  // Re-read current question.answer in case it has changed since the challenge
  // was filed (paranoid but cheap). The history row records the *actual* flip.
  const q = await db
    .prepare('SELECT answer FROM questions WHERE id = ?')
    .bind(ch.question_id)
    .first<{ answer: string }>();
  if (!q) return; // question gone; nothing to do

  const previousAnswer = q.answer;
  const newAnswer = ch.proposed_answer;

  // Lazy-insert the original baseline if this is the question's first flip.
  const hasHistory = await db
    .prepare('SELECT 1 FROM answer_history WHERE question_id = ? LIMIT 1')
    .bind(ch.question_id)
    .first<{ '1': number }>();

  const ops: ReturnType<D1Database['prepare']>[] = [];

  if (!hasHistory) {
    ops.push(
      db
        .prepare(
          `INSERT INTO answer_history
             (question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at)
           VALUES (?, ?, ?, 'original', NULL, NULL, ?)`
        )
        .bind(ch.question_id, previousAnswer, previousAnswer, now)
    );
  }
  ops.push(
    db
      .prepare(
        `INSERT INTO answer_history
           (question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at)
         VALUES (?, ?, ?, 'challenge', ?, ?, ?)`
      )
      .bind(ch.question_id, previousAnswer, newAnswer, ch.id, ch.proposer_email, now)
  );

  // Guarded flip: only if questions.answer hasn't been touched concurrently.
  ops.push(
    db
      .prepare('UPDATE questions SET answer = ? WHERE id = ? AND answer = ?')
      .bind(newAnswer, ch.question_id, previousAnswer)
  );

  // Guarded challenge resolution: only if still active.
  ops.push(
    db
      .prepare(
        `UPDATE answer_challenges
           SET status = 'promoted', resolved_at = ?, resolution_reason = ?
         WHERE id = ? AND status IN ('open', 'contested')`
      )
      .bind(now, reason, ch.id)
  );

  await db.batch(ops);

  // Explanation staleness — auto-prepend system note + set stale_since.
  const exp = await db
    .prepare('SELECT content_json, version FROM explanations WHERE question_id = ?')
    .bind(ch.question_id)
    .first<{ content_json: string; version: number }>();
  if (exp) {
    const note = buildSystemNote(previousAnswer, newAnswer, now);
    const newContent = prependSystemNote(exp.content_json, note);
    const newVersion = exp.version + 1;
    await db.batch([
      db
        .prepare(
          `UPDATE explanations
             SET content_json = ?, version = ?, updated_by = NULL, updated_at = ?, stale_since = ?
           WHERE question_id = ?`
        )
        .bind(newContent, newVersion, now, now, ch.question_id),
      db
        .prepare(
          `INSERT INTO explanation_history
             (question_id, version, content_json, updated_by, updated_at)
           VALUES (?, ?, ?, '_system:challenge', ?)`
        )
        .bind(ch.question_id, newVersion, newContent, now),
    ]);
  }

  await fanoutResolvedNotifications(db, {
    kind: 'challenge_promoted',
    challenge: ch,
    previousAnswer,
    newAnswer,
    now,
  });

  await supersedeSiblings(db, ch, now);
}

// The answer just flipped, so every other active challenge on this question
// argues against a baseline that no longer exists. Archive them and tell
// their proposers they may re-file against the new answer.
async function supersedeSiblings(db: D1Database, promoted: Challenge, now: number): Promise<void> {
  const { results: siblings } = await db
    .prepare(
      `SELECT * FROM answer_challenges
         WHERE question_id = ? AND id != ? AND status IN ('open', 'contested')`
    )
    .bind(promoted.question_id, promoted.id)
    .all<Challenge>();
  if (siblings.length === 0) return;

  const ops: ReturnType<D1Database['prepare']>[] = siblings.map((s) =>
    db
      .prepare(
        `UPDATE answer_challenges
           SET status = 'archived', resolved_at = ?, resolution_reason = 'auto:superseded'
         WHERE id = ? AND status IN ('open', 'contested')`
      )
      .bind(now, s.id)
  );
  for (const s of siblings) {
    ops.push(
      db
        .prepare(
          `INSERT INTO notifications
             (id, recipient, kind, question_id, challenge_id, actor_email, preview, created_at)
           VALUES (?, ?, 'challenge_superseded', ?, ?, NULL, ?, ?)`
        )
        .bind(
          uuid(),
          s.proposer_email,
          s.question_id,
          s.id,
          `本題答案已修正為 ${promoted.proposed_answer},你主張 ${s.proposed_answer} 的挑戰已失效,可重新發起`,
          now
        )
    );
  }
  await db.batch(ops);
}

async function reject(
  db: D1Database,
  ch: Challenge,
  reason: 'auto:rejected',
  now: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE answer_challenges
         SET status = 'rejected', resolved_at = ?, resolution_reason = ?
       WHERE id = ? AND status IN ('open', 'contested')`
    )
    .bind(now, reason, ch.id)
    .run();

  await fanoutResolvedNotifications(db, {
    kind: 'challenge_rejected',
    challenge: ch,
    previousAnswer: ch.original_answer_at_challenge,
    newAnswer: ch.proposed_answer,
    now,
  });
}

async function archive(
  db: D1Database,
  ch: Challenge,
  reason: 'auto:archived',
  now: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE answer_challenges
         SET status = 'archived', resolved_at = ?, resolution_reason = ?
       WHERE id = ? AND status IN ('open', 'contested')`
    )
    .bind(now, reason, ch.id)
    .run();
  // No notifications on silent timeout.
}

async function fanoutResolvedNotifications(
  db: D1Database,
  args: {
    kind: 'challenge_promoted' | 'challenge_rejected';
    challenge: Challenge;
    previousAnswer: string;
    newAnswer: string;
    now: number;
  }
): Promise<void> {
  // Recipients: proposer + everyone who voted.
  const { results: voters } = await db
    .prepare('SELECT DISTINCT voter_email AS email FROM challenge_votes WHERE challenge_id = ?')
    .bind(args.challenge.id)
    .all<{ email: string }>();
  const recipients = new Set<string>([
    args.challenge.proposer_email,
    ...voters.map((v) => v.email),
  ]);
  if (recipients.size === 0) return;

  const preview =
    args.kind === 'challenge_promoted'
      ? `已修正:${args.previousAnswer} → ${args.newAnswer}`
      : `挑戰未通過 (${args.challenge.original_answer_at_challenge} → ${args.challenge.proposed_answer})`;

  const ops = [...recipients].map((r) =>
    db
      .prepare(
        `INSERT INTO notifications
           (id, recipient, kind, question_id, challenge_id, actor_email, preview, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .bind(uuid(), r, args.kind, args.challenge.question_id, args.challenge.id, preview, args.now)
  );
  if (ops.length) await db.batch(ops);
}

// ──────────────────────────────────────────────────────────────
// Public: read helpers (for routes)
// ──────────────────────────────────────────────────────────────

export type ChallengeWithCounts = Challenge & {
  agrees: number;
  disagrees: number;
  my_vote: 'agree' | 'disagree' | null;
  proposer_name: string | null;
};

export async function getActiveChallenges(
  db: D1Database,
  questionId: string,
  meEmail: string,
  now: number = Date.now()
): Promise<ChallengeWithCounts[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM answer_challenges
         WHERE question_id = ? AND status IN ('open','contested')
         ORDER BY created_at ASC`
    )
    .bind(questionId)
    .all<Challenge>();

  const out: ChallengeWithCounts[] = [];
  for (const ch of results) {
    // Lazy-evaluate time-based transitions on read. Note a promote here
    // supersedes the remaining siblings; their recompute below then sees a
    // terminal status and they drop out of the list naturally.
    const decision = await recomputeAndMaybeResolve(db, ch.id, now);
    if (!decision.ok || (decision.status !== 'open' && decision.status !== 'contested')) {
      continue;
    }

    const counts = await loadCounts(db, ch.id);
    const myVoteRow = await db
      .prepare(
        'SELECT vote FROM challenge_votes WHERE challenge_id = ? AND voter_email = ?'
      )
      .bind(ch.id, meEmail)
      .first<{ vote: 'agree' | 'disagree' }>();
    const proposer = await db
      .prepare('SELECT display_name FROM users WHERE email = ?')
      .bind(ch.proposer_email)
      .first<{ display_name: string | null }>();

    // Re-read the post-transition row so contested_at is current.
    const fresh = (await loadChallenge(db, ch.id)) ?? ch;

    out.push({
      ...fresh,
      agrees: counts.agrees,
      disagrees: counts.disagrees,
      my_vote: myVoteRow?.vote ?? null,
      proposer_name: proposer?.display_name ?? null,
    });
  }
  return out;
}

export async function listChallengesForQuestion(
  db: D1Database,
  questionId: string,
  limit = 10
): Promise<Challenge[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM answer_challenges
         WHERE question_id = ?
         ORDER BY created_at DESC LIMIT ?`
    )
    .bind(questionId, limit)
    .all<Challenge>();
  return results;
}

export type RecentChallenge = {
  id: string;
  question_id: string;
  year: number;
  number: number;
  stem: string;
  proposer_email: string;
  proposer_name: string | null;
  proposed_answer: string;
  original_answer_at_challenge: string;
  status: ChallengeStatus;
  contested_at: number | null;
  created_at: number;
  resolved_at: number | null;
  agrees: number;
  disagrees: number;
};

export async function listRecentChallenges(
  db: D1Database,
  opts: { statuses: ChallengeStatus[]; limit: number }
): Promise<RecentChallenge[]> {
  const placeholders = opts.statuses.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT c.id, c.question_id, c.proposer_email, c.proposed_answer,
              c.original_answer_at_challenge, c.status, c.contested_at,
              c.created_at, c.resolved_at,
              q.year, q.number, q.stem,
              u.display_name AS proposer_name,
              (SELECT COUNT(*) FROM challenge_votes v
                WHERE v.challenge_id = c.id AND v.vote = 'agree')    AS agrees,
              (SELECT COUNT(*) FROM challenge_votes v
                WHERE v.challenge_id = c.id AND v.vote = 'disagree') AS disagrees
         FROM answer_challenges c
         JOIN questions q ON q.id = c.question_id
         LEFT JOIN users u ON u.email = c.proposer_email
         WHERE c.status IN (${placeholders})
         ORDER BY COALESCE(c.resolved_at, c.created_at) DESC
         LIMIT ?`
    )
    .bind(...opts.statuses, opts.limit)
    .all<RecentChallenge>();
  return results;
}
