#!/usr/bin/env bash
# End-to-end deployment script
# Idempotent: re-running is safe; will skip already-created resources.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "▶ hema-2026 deployment"
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
echo "▶ Step 1: D1 database"
if grep -q '<REPLACE_ME_DB_ID>' wrangler.toml; then
  echo "  Creating hema-2026-db..."
  DB_OUTPUT=$(wrangler d1 create hema-2026-db 2>&1 || echo "EXISTS")
  if echo "$DB_OUTPUT" | grep -q "already exists"; then
    echo "  hema-2026-db already exists; fetching ID..."
    DB_ID=$(wrangler d1 list --json 2>/dev/null | grep -A1 '"name": "hema-2026-db"' | grep uuid | sed 's/.*"\([a-f0-9-]\{36\}\)".*/\1/' | head -1)
  else
    DB_ID=$(echo "$DB_OUTPUT" | grep -oE '"database_id"\s*=\s*"[^"]+"' | sed 's/.*"\([^"]\+\)"$/\1/')
  fi

  if [ -z "$DB_ID" ]; then
    echo "❌ Could not extract D1 database id. Run \`wrangler d1 list\` manually and paste it into wrangler.toml."
    exit 1
  fi

  echo "  hema-2026-db ID: $DB_ID"
  # macOS/BSD-compatible in-place sed
  sed -i.bak "s/<REPLACE_ME_DB_ID>/$DB_ID/" wrangler.toml && rm wrangler.toml.bak
  echo "  ✅ wrangler.toml updated"
else
  echo "  ✓ Already configured"
fi

# 2. Migrations
echo ""
echo "▶ Step 2: D1 migrations"
wrangler d1 migrations apply hema-2026-db --remote
echo "  ✅ Schema applied"

# 3. R2 bucket
echo ""
echo "▶ Step 3: R2 bucket"
if wrangler r2 bucket create hema-2026-uploads 2>&1 | grep -q "already exists\|Created bucket"; then
  echo "  ✅ hema-2026-uploads ready"
else
  echo "  ⚠️  R2 step may have failed; check manually."
fi

# 4. Sync roster (CF Access whitelist + D1 users seed)
echo ""
echo "▶ Step 4: Sync roster from Google Sheet"
node --experimental-strip-types scripts/sync-access.ts
echo "  ✅ Roster synced"

# 5. Worker
echo ""
echo "▶ Step 5: Deploy Worker"
wrangler deploy
echo "  ✅ Worker deployed"

# 6. Frontend
echo ""
echo "▶ Step 6: Build & deploy frontend (Pages)"
cd frontend
if [ ! -d node_modules ]; then
  echo "  Installing frontend deps (this can take a minute)..."
  npm install
fi
npm run build
wrangler pages deploy dist --project-name=hema-2026
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
