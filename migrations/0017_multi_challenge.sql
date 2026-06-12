-- ============================================================
-- Migration 0017: allow multiple concurrent answer challenges
--
-- Previously a question could have at most ONE open/contested
-- challenge (partial UNIQUE on question_id). Now multiple actives
-- may coexist as long as each proposes a DIFFERENT answer:
--   John may file A→B while Ken files A→C.
-- Two people proposing the same letter still collide — the second
-- one should vote on the existing challenge instead.
--
-- When any challenge is promoted, all sibling actives on the same
-- question are archived with resolution_reason='auto:superseded'
-- (handled in worker/lib/challenges.ts — their original-answer
-- baseline is invalidated by the flip; proposers may re-file).
--
-- Data safety: existing rows are not modified. Today's data has at
-- most one active row per question, which trivially satisfies the
-- new (question_id, proposed_answer) uniqueness, so the index
-- rebuild cannot fail.
-- ============================================================

DROP INDEX idx_one_active_challenge_per_question;

CREATE UNIQUE INDEX idx_one_active_challenge_per_letter
  ON answer_challenges(question_id, proposed_answer)
  WHERE status IN ('open', 'contested');
