#!/usr/bin/env bash
# Run a command (usually `wrangler dev`) with .dev.vars materialised from 1Password.
#
#   .dev.vars.tpl  local, gitignored; same format as .dev.vars, but secret values are
#                  1Password secret references (op://vault/item/field).
#   .dev.vars      written by `op inject` (mode 600) just before the command starts and
#                  deleted when it exits (normal exit, Ctrl-C or kill), so plaintext
#                  secrets exist on disk only while local dev is running.
#
# Wrangler 3.x has no process-env passthrough for local dev vars, and Wrangler 4's
# CLOUDFLARE_INCLUDE_PROCESS_ENV would also load .env and the whole shell env, so a
# transient .dev.vars is the one mechanism that behaves the same on every version.
# No .dev.vars.tpl (e.g. a fork with a hand-written .dev.vars) -> run the command as-is.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .dev.vars.tpl ] || exec "$@"
command -v op >/dev/null || { echo "with-dev-vars: 1Password CLI 'op' not found" >&2; exit 1; }

# Plain rm on purpose: a trash/graveyard tool would keep the plaintext copy around.
trap 'rm -f .dev.vars' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
(umask 077 && op inject --force -i .dev.vars.tpl -o .dev.vars >/dev/null)
"$@"
