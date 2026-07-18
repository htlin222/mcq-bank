#!/usr/bin/env bash
# End-to-end deployment script
# Idempotent: re-running is safe; will skip already-created resources.
# All resource names come from config.toml [project] — edit there to rebrand.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/cfg.sh
. "$(dirname "$0")/lib/cfg.sh"

if [ ! -f config.toml ] || [ ! -f wrangler.toml ]; then
  echo "❌ config.toml and/or wrangler.toml missing. Run ./scripts/setup.sh first."
  exit 1
fi

SLUG="$(cfg project.slug)"
D1_DB="$(cfg project.d1_db)"
R2_BUCKET="$(cfg project.r2_bucket)"
PAGES_PROJECT="$(cfg project.pages_project)"
VEC_INDEX="$(cfg project.vectorize_index)"

echo "▶ $SLUG deployment"
echo "================================"

# 0. Sanity check
if ! command -v wrangler >/dev/null; then
  echo "❌ wrangler not found. Run: npm i -g wrangler"
  exit 1
fi

if [ -z "${CF_ACCOUNT_ID:-}" ]; then
  echo "⚠️  CF_ACCOUNT_ID not set; wrangler will prompt for account selection."
fi

# 1. D1 database
echo ""
echo "▶ Step 1: D1 database ($D1_DB)"
if grep -q '<REPLACE_ME_DB_ID>' wrangler.toml; then
  echo "  Creating $D1_DB..."
  DB_OUTPUT=$(wrangler d1 create "$D1_DB" 2>&1 || echo "EXISTS")
  if echo "$DB_OUTPUT" | grep -q "already exists"; then
    echo "  $D1_DB already exists; fetching ID..."
    DB_ID=$(wrangler d1 list --json 2>/dev/null | grep -A1 "\"name\": \"$D1_DB\"" | grep uuid | sed 's/.*"\([a-f0-9-]\{36\}\)".*/\1/' | head -1)
  else
    DB_ID=$(echo "$DB_OUTPUT" | grep -oE '"database_id"\s*=\s*"[^"]+"' | sed 's/.*"\([^"]\+\)"$/\1/')
  fi

  if [ -z "$DB_ID" ]; then
    echo "❌ Could not extract D1 database id. Run \`wrangler d1 list\` manually and paste it into wrangler.toml."
    exit 1
  fi

  echo "  $D1_DB ID: $DB_ID"
  # macOS/BSD-compatible in-place sed
  sed -i.bak "s/<REPLACE_ME_DB_ID>/$DB_ID/" wrangler.toml && rm wrangler.toml.bak
  echo "  ✅ wrangler.toml updated"
else
  echo "  ✓ Already configured"
fi

# 2. Migrations
echo ""
echo "▶ Step 2: D1 migrations"
wrangler d1 migrations apply "$D1_DB" --remote
echo "  ✅ Schema applied"

# 3. R2 bucket
echo ""
echo "▶ Step 3: R2 bucket ($R2_BUCKET)"
if wrangler r2 bucket create "$R2_BUCKET" 2>&1 | grep -q "already exists\|Created bucket"; then
  echo "  ✅ $R2_BUCKET ready"
else
  echo "  ⚠️  R2 step may have failed; check manually."
fi

# 3.5 Vectorize index (semantic 相似題 / weakness clustering)
echo ""
echo "▶ Step 3.5: Vectorize index ($VEC_INDEX)"
if wrangler vectorize create "$VEC_INDEX" --dimensions=768 --metric=cosine 2>&1 | grep -q "already exists\|Successfully created\|created"; then
  echo "  ✅ $VEC_INDEX ready (backfill vectors with: pnpm vectors:backfill)"
else
  echo "  ⚠️  Vectorize step may have failed (token needs Vectorize Edit); check manually."
fi

# 4. Sync roster (CF Access whitelist + D1 users seed)
echo ""
echo "▶ Step 4: Sync roster from Google Sheet"
node --experimental-strip-types scripts/sync-access.ts
echo "  ✅ Roster synced"

# 5. Worker
echo ""
echo "▶ Step 5: Deploy Worker"
# Snapshot the /mcq skill files into worker/generated/ so the per-user
# .skill download stays in sync with .claude/skills/mcq/.
node scripts/gen-mcq-bundle.mjs
wrangler deploy
echo "  ✅ Worker deployed"

# 6. Frontend
echo ""
echo "▶ Step 6: Build & deploy frontend (Pages → $PAGES_PROJECT)"
cd frontend
if [ ! -d node_modules ]; then
  echo "  Installing frontend deps (this can take a minute)..."
  npm install
fi
npm run build
wrangler pages deploy dist --project-name="$PAGES_PROJECT"
cd ..
echo "  ✅ Frontend deployed"

echo ""
echo "================================"
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "  1. Note your Pages URL above (e.g. https://hema-2026.pages.dev)"
echo "  2. Go to https://one.dash.cloudflare.com/ → Zero Trust"
echo "     If first time: choose a team domain + Free plan"
echo "  3. Run:  ./scripts/setup-access.sh"
echo "     to create the Access Application + 20-user whitelist"
echo "  4. Import questions:"
echo "       node scripts/import-questions.ts ./your-questions.csv"
echo "  5. Set Worker vars in dashboard or via:"
echo "     wrangler secret put CF_ACCESS_TEAM_DOMAIN"
echo "     wrangler secret put CF_ACCESS_AUD"
