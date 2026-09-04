/**
 * 「這個寫法也該算對」提報與投票 —— C2。
 *
 * 沿用 answer_challenges (lib/challenges.ts) 的形狀,但語意相反:MCQ 挑戰是
 * 「正解該換掉」(取代,唯一鍵是「一個題目一次只能有一個 active 的某個字母」);
 * 這裡是「這個寫法也該收」(新增,唯一鍵是 (dx_id, normalized_text) —— 同一個
 * 診斷可以同時有好幾個詞在投票,彼此不衝突)。
 *
 * ⚠️ 被否決的詞留墓碑(status='rejected'),不能刪列 —— 見 migration 0043 的
 *    表註解。⚠️ 通過後不追溯改分 —— /finish 已經寫進 smear_answers.tier 的列
 *    一律不動,檢討頁另外查一次「這個寫法後來被接受了嗎」。
 */
import type { D1Database } from '@cloudflare/workers-types';
import { uuid } from './db.ts';
import { normalizeTerm } from './smear-grade.ts';

export type ProposalStatus = 'open' | 'accepted' | 'rejected';
export type Tier = 'full' | 'half' | 'lay';
export type Form = 'long' | 'abbrev';

/**
 * 小規模讀書會(~20 人),門檻刻意訂低 —— 不是給上千人投票的系統。
 */
export const PROPOSAL_QUORUM = 3;

/**
 * 純函式:決定一個提報目前該落在 open / accepted / rejected 的哪一格。
 * 不碰 DB、不吃時間 —— 呼叫端負責重新載入票數、套用副作用。
 *
 * 規則:
 *   - 票數 < quorum                        → open(不論同意/反對票各是多少)
 *   - 票數 ≥ quorum 且 同意 > 反對          → accepted
 *   - 票數 ≥ quorum 且 反對 > 同意          → rejected
 *   - 票數 ≥ quorum 且 同意 == 反對(含 0=0) → rejected(保守預設:有爭議的
 *     寫法不該悄悄變成可判分的;「打平」在語意上就是還沒有清楚共識)
 */
export function resolveProposal(
  votes: { agree: boolean }[],
  quorum: number,
): ProposalStatus {
  if (votes.length < quorum) return 'open';
  let agreeCount = 0;
  for (const v of votes) if (v.agree) agreeCount++;
  const disagreeCount = votes.length - agreeCount;
  if (agreeCount > disagreeCount) return 'accepted';
  return 'rejected';
}

// ──────────────────────────────────────────────────────────────
// DB row types
// ──────────────────────────────────────────────────────────────

export type SmearTerm = {
  id: string;
  dx_id: string;
  text: string;
  norm: string;
  tier: Tier;
  form: Form;
  status: ProposalStatus;
  rationale: string | null;
  proposed_by: string | null;
  created_at: number;
  resolved_at: number | null;
};

type VoteTally = { agree: number; disagree: number };

async function loadTerm(db: D1Database, id: string): Promise<SmearTerm | null> {
  return db.prepare('SELECT * FROM smear_terms WHERE id = ?').bind(id).first<SmearTerm>();
}

async function loadVotes(db: D1Database, termId: string): Promise<{ agree: boolean }[]> {
  const { results } = await db
    .prepare('SELECT agree FROM smear_term_votes WHERE term_id = ?')
    .bind(termId)
    .all<{ agree: number }>();
  return (results ?? []).map((r) => ({ agree: !!r.agree }));
}

function tally(votes: { agree: boolean }[]): VoteTally {
  const agree = votes.filter((v) => v.agree).length;
  return { agree, disagree: votes.length - agree };
}

function isTier(s: unknown): s is Tier {
  return s === 'full' || s === 'half' || s === 'lay';
}

function isForm(s: unknown): s is Form {
  return s === 'long' || s === 'abbrev';
}

// ──────────────────────────────────────────────────────────────
// Public: proposeTerm
// ──────────────────────────────────────────────────────────────

export type ProposeTermResult =
  | { ok: true; term: SmearTerm }
  | { ok: false; status: 400 | 404 | 409; error: string; existingTermId?: string };

export async function proposeTerm(
  db: D1Database,
  dxId: string,
  proposedBy: string,
  input: { text?: unknown; tier?: unknown; form?: unknown; rationale?: unknown },
  now: number = Date.now(),
): Promise<ProposeTermResult> {
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    return { ok: false, status: 400, error: 'text is required' };
  }
  if (!isTier(input.tier)) {
    return { ok: false, status: 400, error: "tier must be 'full' | 'half' | 'lay'" };
  }
  if (!isForm(input.form)) {
    return { ok: false, status: 400, error: "form must be 'long' | 'abbrev'" };
  }
  const rationale =
    typeof input.rationale === 'string' && input.rationale.trim() !== ''
      ? input.rationale
      : null;

  const dx = await db.prepare('SELECT id FROM smear_dx WHERE id = ?').bind(dxId).first<{ id: string }>();
  if (!dx) return { ok: false, status: 404, error: 'diagnosis not found' };

  const text = input.text.trim();
  const norm = normalizeTerm(text);
  if (!norm) return { ok: false, status: 400, error: 'text does not normalize to anything usable' };

  const existing = await db
    .prepare('SELECT id, status FROM smear_terms WHERE dx_id = ? AND norm = ?')
    .bind(dxId, norm)
    .first<{ id: string; status: ProposalStatus }>();

  // 三種既有狀態一律回 409 並附上既有列的 id,不悄悄建第二列(會撞
  // UNIQUE(dx_id, norm))、也不悄悄幫使用者投票(投票是另一個明確的動作)。
  if (existing) {
    if (existing.status === 'accepted') {
      return {
        ok: false,
        status: 409,
        error: 'this wording is already accepted for this diagnosis',
        existingTermId: existing.id,
      };
    }
    if (existing.status === 'rejected') {
      return {
        ok: false,
        status: 409,
        error: 'this exact wording was already proposed and rejected',
        existingTermId: existing.id,
      };
    }
    return {
      ok: false,
      status: 409,
      error: 'this wording is already open for voting — vote on the existing proposal instead',
      existingTermId: existing.id,
    };
  }

  const id = uuid();
  try {
    await db
      .prepare(
        `INSERT INTO smear_terms
           (id, dx_id, text, norm, tier, form, status, rationale, proposed_by, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`,
      )
      .bind(id, dxId, text, norm, input.tier, input.form, rationale, proposedBy, now)
      .run();
  } catch (e) {
    // Race on the UNIQUE(dx_id, norm) index — someone else's proposal landed
    // between our SELECT and this INSERT. Report cleanly instead of a 500.
    if (String(e).includes('UNIQUE')) {
      const race = await db
        .prepare('SELECT id FROM smear_terms WHERE dx_id = ? AND norm = ?')
        .bind(dxId, norm)
        .first<{ id: string }>();
      return {
        ok: false,
        status: 409,
        error: 'this wording was just proposed by someone else',
        existingTermId: race?.id,
      };
    }
    throw e;
  }

  const term = await loadTerm(db, id);
  return { ok: true, term: term! };
}

// ──────────────────────────────────────────────────────────────
// Public: castProposalVote / retractProposalVote
// ──────────────────────────────────────────────────────────────

export type VoteResult =
  | { ok: true; term: SmearTerm; tally: VoteTally; justResolved: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

export async function castProposalVote(
  db: D1Database,
  voterEmail: string,
  termId: string,
  agree: boolean,
  now: number = Date.now(),
): Promise<VoteResult> {
  if (typeof agree !== 'boolean') {
    return { ok: false, status: 400, error: 'agree must be a boolean' };
  }

  const term = await loadTerm(db, termId);
  if (!term) return { ok: false, status: 404, error: 'term not found' };
  if (term.proposed_by === voterEmail) {
    return { ok: false, status: 403, error: 'proposer cannot vote on their own proposal' };
  }
  if (term.status !== 'open') {
    return { ok: false, status: 409, error: `term is already ${term.status}` };
  }

  await db
    .prepare(
      `INSERT INTO smear_term_votes (term_id, voter_email, agree, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(term_id, voter_email) DO UPDATE SET agree = excluded.agree`,
    )
    .bind(termId, voterEmail, agree ? 1 : 0, now)
    .run();

  return await recomputeTerm(db, termId, now);
}

export async function retractProposalVote(
  db: D1Database,
  voterEmail: string,
  termId: string,
  now: number = Date.now(),
): Promise<VoteResult> {
  const term = await loadTerm(db, termId);
  if (!term) return { ok: false, status: 404, error: 'term not found' };

  await db
    .prepare('DELETE FROM smear_term_votes WHERE term_id = ? AND voter_email = ?')
    .bind(termId, voterEmail)
    .run();

  // ⚠️ 通過(或否決)之後不追溯改分/改狀態 —— 一旦 status 不是 open,即使
  // 事後有人收回票、票數跌回門檻以下,term 仍然維持原狀態。否則等於讓一個
  // 已經被拿去判分的寫法,因為某個人反悔而悄悄變回不能判分,比留著一個
  // 「稍微過時但無害」的 accepted 更糟。
  if (term.status !== 'open') {
    const votes = await loadVotes(db, termId);
    return { ok: true, term, tally: tally(votes), justResolved: false };
  }

  return await recomputeTerm(db, termId, now);
}

/** 重新載入票數、跑 resolveProposal,狀態真的變了才寫回 D1。 */
async function recomputeTerm(
  db: D1Database,
  termId: string,
  now: number,
): Promise<VoteResult> {
  const term = await loadTerm(db, termId);
  if (!term) return { ok: false, status: 404, error: 'term not found' };

  const votes = await loadVotes(db, termId);
  const nextStatus = resolveProposal(votes, PROPOSAL_QUORUM);

  if (nextStatus !== term.status && term.status === 'open') {
    // CAS on status='open' so a concurrent recompute can't double-resolve.
    await db
      .prepare(
        `UPDATE smear_terms SET status = ?, resolved_at = ? WHERE id = ? AND status = 'open'`,
      )
      .bind(nextStatus, now, termId)
      .run();
    const updated = await loadTerm(db, termId);
    return { ok: true, term: updated!, tally: tally(votes), justResolved: true };
  }

  return { ok: true, term, tally: tally(votes), justResolved: false };
}

// ──────────────────────────────────────────────────────────────
// Public: listRecentProposals
// ──────────────────────────────────────────────────────────────

export type RecentProposal = {
  id: string;
  dx_id: string;
  canonical_long: string;
  text: string;
  tier: Tier;
  form: Form;
  status: ProposalStatus;
  rationale: string | null;
  proposed_by: string | null;
  created_at: number;
  resolved_at: number | null;
  agree_count: number;
  disagree_count: number;
  my_vote: boolean | null;
};

export async function listRecentProposals(
  db: D1Database,
  viewerEmail: string,
  limit = 30,
): Promise<RecentProposal[]> {
  const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit) || 30));
  const { results } = await db
    .prepare(
      `SELECT t.id, t.dx_id, sd.canonical_long, t.text, t.tier, t.form, t.status,
              t.rationale, t.proposed_by, t.created_at, t.resolved_at,
              SUM(CASE WHEN v.agree = 1 THEN 1 ELSE 0 END) AS agree_count,
              SUM(CASE WHEN v.agree = 0 THEN 1 ELSE 0 END) AS disagree_count,
              MAX(CASE WHEN v.voter_email = ? THEN v.agree END) AS my_vote
         FROM smear_terms t
         JOIN smear_dx sd ON sd.id = t.dx_id
         LEFT JOIN smear_term_votes v ON v.term_id = t.id
        GROUP BY t.id
        ORDER BY t.created_at DESC
        LIMIT ?`,
    )
    .bind(viewerEmail, clampedLimit)
    .all<{
      id: string;
      dx_id: string;
      canonical_long: string;
      text: string;
      tier: Tier;
      form: Form;
      status: ProposalStatus;
      rationale: string | null;
      proposed_by: string | null;
      created_at: number;
      resolved_at: number | null;
      agree_count: number | null;
      disagree_count: number | null;
      my_vote: number | null;
    }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    dx_id: r.dx_id,
    canonical_long: r.canonical_long,
    text: r.text,
    tier: r.tier,
    form: r.form,
    status: r.status,
    rationale: r.rationale,
    proposed_by: r.proposed_by,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
    agree_count: r.agree_count ?? 0,
    disagree_count: r.disagree_count ?? 0,
    my_vote: r.my_vote === null || r.my_vote === undefined ? null : !!r.my_vote,
  }));
}
