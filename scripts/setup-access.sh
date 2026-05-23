#!/usr/bin/env bash
# Configure Cloudflare Access (Zero Trust) for the deployed site.
# Reads from .env if present, otherwise prompts.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
fi

prompt() {
  local var=$1 msg=$2
  if [ -z "${!var:-}" ]; then
    read -rp "$msg: " val
    eval "$var=\"$val\""
  fi
}

prompt CF_API_TOKEN "Cloudflare API token (with Access:Edit scope)"
prompt CF_ACCOUNT_ID "Cloudflare account ID"
prompt PAGES_DOMAIN "Pages domain to protect (e.g. hema-2026.pages.dev)"
prompt ALLOWED_EMAILS "Comma-separated user emails (e.g. a@x.com,b@x.com)"

echo ""
echo "▶ Creating Access Application for $PAGES_DOMAIN..."

APP_RESPONSE=$(curl -sf -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"QA Study System\",
    \"domain\": \"$PAGES_DOMAIN\",
    \"type\": \"self_hosted\",
    \"session_duration\": \"24h\",
    \"app_launcher_visible\": true
  }")

APP_ID=$(echo "$APP_RESPONSE" | grep -oE '"id":"[a-f0-9-]+"' | head -1 | sed 's/.*"\([^"]\+\)".*/\1/')
AUD=$(echo "$APP_RESPONSE" | grep -oE '"aud":"[^"]+"' | head -1 | sed 's/.*"\([^"]\+\)".*/\1/')

if [ -z "$APP_ID" ]; then
  echo "❌ Failed to create Access Application. Response:"
  echo "$APP_RESPONSE"
  exit 1
fi

echo "  ✅ Application created: $APP_ID"
echo "  ✅ AUD tag: $AUD"

# Build the include array for the policy
INCLUDE_JSON="["
FIRST=1
IFS=',' read -ra EMAILS <<< "$ALLOWED_EMAILS"
for e in "${EMAILS[@]}"; do
  e=$(echo "$e" | xargs)  # trim
  if [ $FIRST -eq 0 ]; then INCLUDE_JSON+=","; fi
  INCLUDE_JSON+="{\"email\":{\"email\":\"$e\"}}"
  FIRST=0
done
INCLUDE_JSON+="]"

echo ""
echo "▶ Creating Access Policy with ${#EMAILS[@]} users..."

POLICY_RESPONSE=$(curl -sf -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/$APP_ID/policies" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Allowed users\",
    \"decision\": \"allow\",
    \"include\": $INCLUDE_JSON
  }")

POLICY_ID=$(echo "$POLICY_RESPONSE" | grep -oE '"id":"[a-f0-9-]+"' | head -1 | sed 's/.*"\([^"]\+\)".*/\1/')

if [ -z "$POLICY_ID" ]; then
  echo "❌ Failed to create policy:"
  echo "$POLICY_RESPONSE"
  exit 1
fi

echo "  ✅ Policy created: $POLICY_ID"

echo ""
echo "▶ Setting Worker vars (CF_ACCESS_AUD)..."
# Look up team domain
TEAM_RESPONSE=$(curl -sf \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/organizations" \
  -H "Authorization: Bearer $CF_API_TOKEN")
TEAM_DOMAIN=$(echo "$TEAM_RESPONSE" | grep -oE '"auth_domain":"[^"]+"' | sed 's/.*"\([^"]\+\)".*/\1/')

echo "$AUD" | wrangler secret put CF_ACCESS_AUD
echo "$TEAM_DOMAIN" | wrangler secret put CF_ACCESS_TEAM_DOMAIN

echo ""
echo "================================"
echo "✅ Access setup complete!"
echo ""
echo "  Team domain:  $TEAM_DOMAIN"
echo "  Application:  $APP_ID"
echo "  AUD:          $AUD"
echo "  Users:        ${#EMAILS[@]}"
echo ""
echo "Share the URL with users:"
echo "  https://$PAGES_DOMAIN"
echo ""
echo "They'll get an OTP by email on first visit. No signup, no passwords."
