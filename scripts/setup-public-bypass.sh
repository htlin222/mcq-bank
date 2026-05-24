#!/usr/bin/env bash
# Create path-scoped CF Access "Bypass Everyone" applications so the public
# landing page (and the assets/endpoints it needs to boot) can be reached
# without an Access challenge. Each path becomes its own Self-Hosted App
# with one policy (decision=bypass, include=Everyone).
#
# Requires .env at repo root with CF_API_TOKEN + CF_ACCOUNT_ID.
#
# Idempotent: skips paths that already have an app.
#
# Usage:
#   ./scripts/setup-public-bypass.sh --dry-run     # show what would be created
#   ./scripts/setup-public-bypass.sh               # apply

set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# Load .env line-by-line, tolerating // comment lines and bare lines that
# `source` would choke on under set -e.
while IFS='=' read -r key val; do
  case "$key" in
    [A-Z_][A-Z0-9_]*)
      export "$key=$val"
      ;;
  esac
done < .env
: "${CF_API_TOKEN:?missing in .env}"
: "${CF_ACCOUNT_ID:?missing in .env}"

HOST="hema-2026.hsiehting.com"
API="https://api.cloudflare.com/client/v4"

# Path, exact name (must be unique). Order matters for "first to verify".
PATHS=(
  "/og-image.png|hema-2026 public · og-image"
  "/favicon.svg|hema-2026 public · favicon"
  "/assets/*|hema-2026 public · spa-assets"
  "/api/me|hema-2026 public · auth-probe"
  "/|hema-2026 public · landing"
)

list_apps() {
  curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
    "$API/accounts/$CF_ACCOUNT_ID/access/apps?per_page=100"
}

create_app_with_bypass() {
  local domain="$1" name="$2"
  local payload
  payload=$(python3 -c "
import json, sys
d = {
  'name': '$name',
  'domain': '$domain',
  'type': 'self_hosted',
  'session_duration': '24h',
  'app_launcher_visible': False,
  'allowed_idps': [],
  'auto_redirect_to_identity': False,
  'policies': [{
    'name': 'Bypass — everyone',
    'decision': 'bypass',
    'precedence': 1,
    'include': [{'everyone': {}}],
  }],
}
print(json.dumps(d))
")
  curl -s -X POST -H "Authorization: Bearer $CF_API_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    "$API/accounts/$CF_ACCOUNT_ID/access/apps"
}

# Snapshot existing apps so we can detect duplicates.
EXISTING_JSON=$(list_apps)
EXISTING_DOMAINS=$(echo "$EXISTING_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for a in d.get('result', []):
    print(a.get('domain',''))
")

echo "▶ Existing apps on $HOST:"
echo "$EXISTING_DOMAINS" | grep -F "$HOST" | sed 's/^/    /' || true
echo ""

for entry in "${PATHS[@]}"; do
  IFS='|' read -r path name <<< "$entry"
  domain="${HOST}${path}"
  if echo "$EXISTING_DOMAINS" | grep -Fxq "$domain"; then
    echo "  ✓ skip (already exists): $domain"
    continue
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  (dry-run) would create: $domain  →  '$name'"
    continue
  fi
  echo "  ▶ creating: $domain"
  resp=$(create_app_with_bypass "$domain" "$name")
  ok=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success'))")
  if [[ "$ok" != "True" ]]; then
    echo "    ❌ failed:"
    echo "$resp" | python3 -m json.tool | sed 's/^/      /'
    exit 1
  fi
  id=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['id'])")
  echo "    ✓ created  id=$id"
done

echo ""
if [[ $DRY_RUN -eq 1 ]]; then
  echo "(dry run — nothing changed. Re-run without --dry-run to apply.)"
else
  echo "✅ Done. Verify with:"
  echo "  curl -sI https://$HOST/og-image.png | head -3"
  echo "  curl -sI https://$HOST/ | head -3"
  echo "  curl -sI https://$HOST/api/me | head -3"
  echo "  curl -sI https://$HOST/api/health | head -3   # should still 302 (gated)"
fi
