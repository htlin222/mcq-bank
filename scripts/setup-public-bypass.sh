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

# shellcheck source=lib/cfg.sh
. "$(dirname "$0")/lib/cfg.sh"

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

HOST="$(cfg public.host)"
SLUG="$(cfg project.slug)"
API="https://api.cloudflare.com/client/v4"

# Path, exact name (must be unique). Order matters for "first to verify".
PATHS=(
  "/og-image.png|${SLUG} public · og-image"
  "/favicon.svg|${SLUG} public · favicon"
  "/assets/*|${SLUG} public · spa-assets"
  "/api/me|${SLUG} public · auth-probe"
  # Read-only question API for the /mcq skill. Access-bypassed so external
  # Claude Code / claude.ai (no Access session) can reach it; the Worker's
  # apiKeyMiddleware (timing-safe key + email allowlist) is the sole gate.
  "/api/mcq/*|${SLUG} public · mcq-api"
  # Telegram webhook. Telegram 伺服器沒有 Access session,回呼一律被 302 到
  # 登入頁就永遠收不到 update。故整段 /tg/* Access-bypass;Worker 內以
  # X-Telegram-Bot-Api-Secret-Token 常數時間比對驗證,才是真正的閘。
  "/tg/*|${SLUG} public · telegram-webhook"
  # PWA. Install and service-worker update checks are initiated by the browser
  # itself and can happen with no Access session — the SW update fetch is not
  # even guaranteed to carry cookies. Behind Access those requests get a 302
  # to the login page, so the browser sees HTML: the install prompt disappears
  # and the SW update fails on a MIME mismatch, pinning users to the old
  # worker forever. Keeping /sw.js reachable is also what makes the
  # public/sw-kill.js kill switch work (see docs/plans/2026-07-20-pwa-offline.md).
  # Exposure: brand strings, icons, and precache filenames whose files already
  # live under the bypassed /assets/*. No new data surface.
  "/manifest.webmanifest|${SLUG} public · pwa-manifest"
  "/sw.js|${SLUG} public · pwa-sw"
  "/icons/*|${SLUG} public · pwa-icons"
  "/|${SLUG} public · landing"
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
  echo "  curl -sI https://$HOST/manifest.webmanifest | head -3   # 200 + manifest+json"
  echo "  curl -sI https://$HOST/sw.js | head -3                  # 200 + javascript"
  echo "  curl -sI https://$HOST/icons/icon-192.png | head -3     # 200 + image/png"
  echo "  curl -sI https://$HOST/api/health | head -3   # should still 302 (gated)"
fi
