-- ============================================================
-- Migration 0013: per-user MCQ key version (salt, NOT a secret)
-- ------------------------------------------------------------
-- The /mcq skill key is HMAC-derived per user:
--   key = "mcqk_" + base64url(HMAC-SHA256(MCQ_KEY_SECRET, `${email}:${version}`))
-- so no key material is stored in D1. This column is the rotation
-- salt: bump it (POST /api/me/mcq-key/rotate) to invalidate a user's
-- previously downloaded .skill without touching anyone else.
-- ============================================================
ALTER TABLE users ADD COLUMN mcq_key_version INTEGER NOT NULL DEFAULT 1;
