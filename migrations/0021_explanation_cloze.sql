-- ============================================================
-- Migration 0021: 自動 cloze 關鍵詞快取
--
-- One row per question caching the AI-extracted key terms for the
-- current 共筆詳解. Computed on demand (button press), keyed by the
-- explanation's version so an edited 詳解 recomputes. Shared across all
-- users — the cloze is a property of the shared explanation, not a
-- per-user layer. No FSRS involvement: this only drives the 防劇透
-- self-test overlay on the explanation.
-- ============================================================

CREATE TABLE explanation_cloze (
  question_id TEXT    PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,   -- mirrors explanations.version at compute time
  terms_json  TEXT    NOT NULL,   -- JSON string[] of key terms
  created_at  INTEGER NOT NULL
);
