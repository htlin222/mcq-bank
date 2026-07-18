// Canonical Workers AI model ids — single source of truth so a model
// deprecation is a one-line change, not a repo-wide grep.
//
// NOTE: the previous default `@cf/meta/llama-3.1-8b-instruct` was deprecated
// on 2026-05-30 (AiError 5028) — it silently broke every AI endpoint. Keep
// these pointing at current models.

export const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
