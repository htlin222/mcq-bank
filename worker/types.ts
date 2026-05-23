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
  number: number;     // 1..70 = 內科, 71..100 = 共同
  stem: string;
  options_json: string;
  answer: string;
  group: '內科' | '共同' | null;
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
