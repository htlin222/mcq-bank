import type {
  D1Database,
  R2Bucket,
  Ai,
  KVNamespace,
  DurableObjectNamespace,
} from '@cloudflare/workers-types';

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  AI: Ai;
  CACHE?: KVNamespace;
  // 聊天大廳 Durable Object (worker/chat-room.ts, single "lobby" room)
  CHAT: DurableObjectNamespace;
  // Per-user cross-device state (worker/user-state.ts, single "main"
  // instance) — RPC-typed so route code gets checked method calls.
  USER_STATE: DurableObjectNamespace<import('./user-state').UserState>;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  ADMIN_EMAILS?: string;
  // Daily roster-sync Cron Trigger (worker/lib/roster-sync.ts). CF_API_TOKEN
  // is a secret (needs Access Apps+Policies Edit); the rest are [vars].
  // All optional — if unset the scheduled() handler throws and that cron run
  // is marked failed, but the fetch handler is unaffected.
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  ACCESS_APP_ID?: string;
  ROSTER_CSV_URL?: string;
  // Optional — feedback button is disabled if either is missing.
  GH_FEEDBACK_REPO?: string;  // "owner/repo"
  GH_FEEDBACK_TOKEN?: string; // PAT with issues:write
  // HMAC secret for per-user keys on the read-only /api/mcq endpoint
  // (the `/mcq` skill). Each member's key is derived, not stored:
  //   key = "mcqk_" + b64url(HMAC-SHA256(MCQ_KEY_SECRET, `${email}:${ver}`))
  // Set via `wrangler secret put MCQ_KEY_SECRET`; .dev.vars locally.
  MCQ_KEY_SECRET?: string;
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
  mcq_key_version: number;  // rotation salt for the /mcq skill key (default 1)
  chat_notify: 'all' | 'mention' | 'off';  // 聊天大廳 toast preference
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
