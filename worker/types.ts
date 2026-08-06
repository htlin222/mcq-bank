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
  // 語意相似題 (#2) 與弱點聚類 (#6) 共用的向量索引;query/upsert/getByIds。
  VEC: VectorizeIndex;
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
  // Public host (e.g. "qa.example.com"). Optional: /api/export falls back to
  // the request origin for the absolute image URLs it puts in CSV/HTML, so
  // this only needs setting if the worker is reached on a different host than
  // the one users should link to.
  PUBLIC_HOST?: string;
  // Optional — feedback button is disabled if either is missing.
  GH_FEEDBACK_REPO?: string;  // "owner/repo"
  GH_FEEDBACK_TOKEN?: string; // PAT with issues:write
  // HMAC secret for per-user keys on the read-only /api/mcq endpoint
  // (the `/mcq` skill). Each member's key is derived, not stored:
  //   key = "mcqk_" + b64url(HMAC-SHA256(MCQ_KEY_SECRET, `${email}:${ver}`))
  // Set via `wrangler secret put MCQ_KEY_SECRET`; .dev.vars locally.
  MCQ_KEY_SECRET?: string;
  // HMAC secret for the per-admin write key used by the `bank-ingest` skill
  // (新年份題庫匯入). Separate secret from MCQ_KEY_SECRET on purpose — that
  // one is a read key held by ~20 people, this one can write the staging
  // area and is held only by ADMIN_EMAILS. See worker/lib/bank-key.ts.
  //   key = "bnkk_" + b64url(HMAC-SHA256(BANK_KEY_SECRET, `${email}:bank:${ver}`))
  // Set via `wrangler secret put BANK_KEY_SECRET`; .dev.vars locally.
  // Unset ⇒ /api/bank-ingest/* returns 503 and the download button hides.
  BANK_KEY_SECRET?: string;
  // Question categories. Format: "<label>:<count>,...". Empty / missing
  // falls back to a single "全部:0" group so the app still boots.
  GROUPS?: string;
  // 考試開始時間 (ISO-8601 with offset) — 鏡射自 config.toml [exam].date_iso。
  // 未設時 /api/review/readiness 回 days_left: null,前端退化為只顯示速度。
  EXAM_DATE_ISO?: string;
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
  // Telegram 出題機器人 (worker/routes/telegram.ts, worker/lib/tg-*.ts)。
  // TG_BOT_TOKEN / TG_WEBHOOK_SECRET 是 secret;bot username 是 [vars]。
  // 全未設時 webhook 回 200 忽略、cron 推播 no-op、link-code 回 501。
  TG_BOT_TOKEN?: string;
  TG_WEBHOOK_SECRET?: string;
  TG_BOT_USERNAME?: string;   // 不含 @,用於組 deep link
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
  // migration 0026 — 自訂測驗。舊列走 DEFAULT('year'/0/1/NULL)。
  // year = 0 是 custom 的哨兵值,判斷種類一律看 kind。
  kind: 'year' | 'custom';
  tutor: 0 | 1;
  timed: 0 | 1;
  filter_json: string | null;
};
