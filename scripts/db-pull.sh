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
  | node -e '
    // wrangler 會在 --json 的輸出前面夾雜非 JSON 的行(版本更新提示、
    // "Cloudflare agent skills are available for: …" 之類的推銷文案),
    // 整段丟給 JSON.parse 會炸在 "Unexpected token C"。從第一行以 [ 開頭
    // 的地方開始切,才不會每次 wrangler 想說話就壞一次。
    let s="";
    process.stdin.on("data",d=>s+=d).on("end",()=>{
      const lines=s.split("\n");
      const at=lines.findIndex(l=>l.trimStart().startsWith("["));
      if(at<0){process.stderr.write("wrangler 沒有輸出 JSON:\n"+s);process.exit(1)}
      const j=JSON.parse(lines.slice(at).join("\n"));
      process.stdout.write(j[0].results.map(r=>r.name).join(" "))
    })')"

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
