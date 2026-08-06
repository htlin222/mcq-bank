#!/usr/bin/env bash
# Mirror the REMOTE D1 database down into the LOCAL wrangler dev store.
#
# Why this exists: local dev runs against a tiny sample DB (migrations'
# seed data), so production-only state — community answer challenges,
# answer_history, real questions — is invisible locally. That blind spot
# let an import silently clobber a promoted answer (114-002/114-003) with
# nobody noticing in dev. `pnpm db:pull` makes local a faithful copy of
# prod so those code paths can be reproduced and tested offline.
#
# One-way pull (remote -> local). It NEVER writes to remote.
#
# Note: `wrangler d1 export` refuses to dump a DB that has FTS5 virtual
# tables, so we can't take a whole-DB snapshot. Instead we (1) rebuild the
# schema locally from migrations (this recreates the FTS tables + triggers),
# then (2) export DATA ONLY for the real base tables and load it, wiping the
# seed rows first. The FTS indexes repopulate via their triggers on insert.
#
# Usage: pnpm db:pull [out.sql]   # optional: keep the combined dump at out.sql
set -euo pipefail

cd "$(dirname "$0")/.."

DB="$(node scripts/lib/cfg.mjs project.d1_db)"
KEEP="${1:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DATA="$WORK/data.sql"
DUMP="${KEEP:-$WORK/pull.sql}"

echo "▶ Rebuilding LOCAL schema from migrations ..."
pnpm -s db:migrate:local >/dev/null

echo "▶ Discovering base tables on REMOTE '$DB' ..."
# Real base tables only: skip FTS virtual tables + their shadow tables,
# sqlite internals, the migrations ledger, and CF metadata. Letting the
# query drive the list means new tables are picked up automatically.
TABLES="$(wrangler d1 execute "$DB" --remote --json --command "
  SELECT name FROM sqlite_master
  WHERE type='table'
    AND sql LIKE 'CREATE TABLE%'
    AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE '%_fts%'
    AND name NOT LIKE '_cf_%'
    AND name != 'd1_migrations'
  ORDER BY name" \
  | node --input-type=module -e '
    // 剝掉 wrangler 夾在 --json 前面的人類可讀行(版本提示、agent skills
    // 推銷文案…)。邏輯在 scripts/lib/wrangler-json.mjs,全 repo 共用一份。
    import { d1Rows } from "./scripts/lib/wrangler-json.mjs";
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      process.stdout.write(d1Rows(s, "db-pull 列舉 remote 資料表").map((r) => r.name).join(" "));
    });
  ')"

if [ -z "$TABLES" ]; then
  echo "✗ Could not enumerate remote tables. Aborting; local left untouched." >&2
  exit 1
fi
echo "  tables: $TABLES"

# shellcheck disable=SC2086  # word-splitting $TABLES into --table flags is intended
TABLE_FLAGS=$(for t in $TABLES; do printf -- '--table %s ' "$t"; done)

echo "▶ Exporting REMOTE data (no schema) ..."
# shellcheck disable=SC2086
wrangler d1 export "$DB" --remote --no-schema $TABLE_FLAGS --output="$DATA"
if [ ! -s "$DATA" ]; then
  echo "✗ Export produced an empty file. Aborting; local left untouched." >&2
  exit 1
fi

echo "▶ Building combined dump (wipe seed -> load remote) ..."
{
  echo 'PRAGMA defer_foreign_keys=TRUE;'
  for t in $TABLES; do printf 'DELETE FROM "%s";\n' "$t"; done
  cat "$DATA"
} >"$DUMP"

echo "▶ Loading into LOCAL '$DB' ..."
wrangler d1 execute "$DB" --local --file="$DUMP"

[ -n "$KEEP" ] && echo "  dump kept at: $KEEP"
echo "✓ Local D1 now mirrors remote. Verify, e.g.:"
echo "    wrangler d1 execute $DB --local --command \"SELECT id, answer FROM questions WHERE id IN ('114-002','114-003')\""
