import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export type ChallengeStatus =
  | 'open'
  | 'contested'
  | 'promoted'
  | 'rejected'
  | 'archived'
  | 'withdrawn';

export type ActiveChallenge = {
  id: string;
  question_id: string;
  proposer_email: string;
  proposer_name: string | null;
  proposed_answer: string;
  original_answer_at_challenge: string;
  rationale_json: string;
  status: 'open' | 'contested';
  contested_at: number | null;
  created_at: number;
  agrees: number;
  disagrees: number;
  my_vote: 'agree' | 'disagree' | null;
};

export type ResolvedChallenge = {
  id: string;
  question_id: string;
  proposer_email: string;
  proposed_answer: string;
  original_answer_at_challenge: string;
  rationale_json: string;
  status: ChallengeStatus;
  created_at: number;
  resolved_at: number | null;
  resolution_reason: string | null;
};

/** The "recently corrected" pill only shows challenges that have resolved. */
const resolvedOnly = (all: ResolvedChallenge[]) =>
  all.filter((c) => c.status !== 'open' && c.status !== 'contested');

/**
 * Every mutating endpoint echoes the question's post-mutation state, so a
 * vote costs one round trip rather than POST + two GETs.
 */
type MutationEcho = {
  active?: ActiveChallenge[];
  recent?: ResolvedChallenge[];
};

/**
 * Subscribe to the active challenges (if any) for a question. Multiple may
 * coexist — one per proposed letter.
 * - `active`: undefined while loading, [] when none, rows when present
 * - `recent`: latest resolved challenges (for the "recently corrected" pill)
 *
 * No polling; refresh is manual via `refresh()`. The vote/withdraw helpers
 * apply the state the server echoed back, falling back to a full `refresh()`
 * if a response predates that (older Worker still deployed).
 */
export function useChallenge(questionId: string | null | undefined) {
  const [active, setActive] = useState<ActiveChallenge[] | undefined>(undefined);
  const [recent, setRecent] = useState<ResolvedChallenge[]>([]);

  const refresh = useCallback(async () => {
    if (!questionId) return;
    const [a, all] = await Promise.all([
      api.get<ActiveChallenge[] | null>(
        `/api/questions/${questionId}/challenges/active`,
      ),
      api.get<ResolvedChallenge[]>(`/api/questions/${questionId}/challenges?limit=5`),
    ]);
    setActive(Array.isArray(a) ? a : []);
    setRecent(resolvedOnly(all));
  }, [questionId]);

  // Returns false when the response carried no usable state, so the caller
  // can fall back to refresh() rather than leave a stale banner on screen.
  const applyEcho = useCallback((res: MutationEcho | null | undefined) => {
    if (!res || !Array.isArray(res.active)) return false;
    setActive(res.active);
    if (Array.isArray(res.recent)) setRecent(resolvedOnly(res.recent));
    return true;
  }, []);

  useEffect(() => {
    if (questionId) {
      refresh().catch(() => {
        setActive([]);
        setRecent([]);
      });
    } else {
      setActive([]);
      setRecent([]);
    }
  }, [questionId, refresh]);

  const file = useCallback(
    async (proposedAnswer: string, rationaleJson: unknown) => {
      if (!questionId) return;
      const res = await api.post<MutationEcho>(
        `/api/questions/${questionId}/challenges`,
        { proposed_answer: proposedAnswer, rationale_json: rationaleJson },
      );
      if (!applyEcho(res)) await refresh();
    },
    [questionId, refresh, applyEcho],
  );

  const vote = useCallback(
    async (challengeId: string, vote: 'agree' | 'disagree', commentJson?: unknown) => {
      const res = await api.post<MutationEcho>(`/api/challenges/${challengeId}/votes`, {
        vote,
        comment_json: commentJson,
      });
      if (!applyEcho(res)) await refresh();
    },
    [refresh, applyEcho],
  );

  const retract = useCallback(
    async (challengeId: string) => {
      const res = await api.del<MutationEcho>(`/api/challenges/${challengeId}/votes`);
      if (!applyEcho(res)) await refresh();
    },
    [refresh, applyEcho],
  );

  const withdraw = useCallback(
    async (challengeId: string) => {
      const res = await api.post<MutationEcho>(`/api/challenges/${challengeId}/withdraw`);
      if (!applyEcho(res)) await refresh();
    },
    [refresh, applyEcho],
  );

  const editRationale = useCallback(
    async (challengeId: string, rationaleJson: unknown) => {
      const res = await api.patch<MutationEcho>(`/api/challenges/${challengeId}/rationale`, {
        rationale_json: rationaleJson,
      });
      if (!applyEcho(res)) await refresh();
    },
    [refresh, applyEcho],
  );

  return { active, recent, refresh, file, vote, retract, withdraw, editRationale };
}
