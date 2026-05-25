import type { D1Database, R2Bucket, Ai, KVNamespace } from '@cloudflare/workers-types';

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  AI: Ai;
  CACHE?: KVNamespace;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  ADMIN_EMAILS?: string;
  // Optional — feedback button is disabled if either is missing.
  GH_FEEDBACK_REPO?: string;  // "owner/repo"
  GH_FEEDBACK_TOKEN?: string; // PAT with issues:write
  // Question categories. Format: "<label>:<count>,...". Empty / missing
  // falls back to a single "全部:0" group so the app still boots.
  GROUPS?: string;
  // AI prompt wording — see config.toml [ai]. Each is optional and has a
  // generic fallback inside worker/routes/ai.ts so the app boots unset.
  AI_SPECIALTY_ZH?: string;
  AI_SPECIALTY_EN_LONG?: string;
  AI_TAG_DISEASE_EXAMPLES?: string;
  AI_TAG_TOPIC_EXAMPLES?: string;
  AI_QA_QUESTION_EXAMPLES?: string;
  AI_QA_TERMINOLOGY_EXAMPLES?: string;
  AI_QA_MC_BAD_EXAMPLE?: string;
  AI_QA_MC_GOOD_EXAMPLE?: string;
};

// Hono variables injected by auth middleware
export type Variables = {
  email: string;
  displayName: string;
};

export type AppContext = {
  Bindings: Env;
  Variables: Variables;
};

// ============ DB row types (mirror schema) ============

export type User = {
  email: string;
  display_name: string;
  avatar_key: string | null;
  bio: string | null;
  created_at: number;
  updated_at: number;
};

export type Question = {
  id: string;
  year: number;       // 民國 (e.g. 114 for 2025)
  number: number;     // composition follows config.toml [groups].list order
  stem: string;
  options_json: string;
  answer: string;
  // Group label comes from config.toml [groups].list (default for this
  // fork: "內科"/"共同"). Widened to plain string so a fork can use any
  // label set without touching code.
  group: string | null;
  difficulty: number | null;
  source: string | null;
  created_at: number;
};

export type QuestionTag = {
  question_id: string;
  tag: string;
  created_by: string;
  created_at: number;
};

export type QuestionOption = { key: string; text: string };

export type Explanation = {
  question_id: string;
  content_json: string;
  version: number;
  editing_by: string | null;
  editing_until: number | null;
  updated_by: string | null;
  updated_at: number;
};

export type Comment = {
  id: string;
  question_id: string;
  parent_id: string | null;
  author_email: string;
  content_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export type ExamSession = {
  id: string;
  user_email: string;
  year: number;
  started_at: number;
  finished_at: number | null;
  score: number | null;
  duration_sec: number | null;
  mode: string;
};
