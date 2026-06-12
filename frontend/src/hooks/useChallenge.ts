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

/**
 * Subscribe to the active challenges (if any) for a question. Multiple may
 * coexist — one per proposed letter.
 * - `active`: undefined while loading, [] when none, rows when present
 * - `recent`: latest resolved challenges (for the "recently corrected" pill)
 *
 * No polling; refresh is manual via `refresh()`. Vote/withdraw helpers
 * automatically refresh on success.
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
    setRecent(all.filter((c) => c.status !== 'open' && c.status !== 'contested'));
  }, [questionId]);

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
      await api.post(`/api/questions/${questionId}/challenges`, {
        proposed_answer: proposedAnswer,
        rationale_json: rationaleJson,
      });
      await refresh();
    },
    [questionId, refresh],
  );

  const vote = useCallback(
    async (challengeId: string, vote: 'agree' | 'disagree', commentJson?: unknown) => {
      await api.post(`/api/challenges/${challengeId}/votes`, {
        vote,
        comment_json: commentJson,
      });
      await refresh();
    },
    [refresh],
  );

  const retract = useCallback(
    async (challengeId: string) => {
      await api.del(`/api/challenges/${challengeId}/votes`);
      await refresh();
    },
    [refresh],
  );

  const withdraw = useCallback(
    async (challengeId: string) => {
      await api.post(`/api/challenges/${challengeId}/withdraw`);
      await refresh();
    },
    [refresh],
  );

  const editRationale = useCallback(
    async (challengeId: string, rationaleJson: unknown) => {
      await api.patch(`/api/challenges/${challengeId}/rationale`, {
        rationale_json: rationaleJson,
      });
      await refresh();
    },
    [refresh],
  );

  return { active, recent, refresh, file, vote, retract, withdraw, editRationale };
}
