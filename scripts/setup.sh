#!/usr/bin/env bash
# Interactive first-time setup for a fresh fork of this repo.
#
# Walks through:
#   1. Copying config.example.toml → config.toml  (asks for slug, host, etc.)
#   2. Copying wrangler.example.toml → wrangler.toml (keeps it in sync)
#   3. Copying .env.example → .env (asks for CF credentials)
#
# Re-running is safe — existing files are left alone unless --force is given.
# Doesn't touch the Cloudflare API; run ./scripts/deploy.sh afterwards.

set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

echo "▶ Q&A bank — first-time setup"
echo "================================"
echo ""

# ----- helpers -----
# ask <var-name> <prompt> [default]   - any value (including blank) accepted
# ask_required <var-name> <prompt>    - re-prompts until a non-blank value
ask() {
  local var="$1" prompt="$2" default="${3:-}"
  local val
  if [ -n "$default" ]; then
    read -rp "$prompt [$default]: " val
    val="${val:-$default}"
  else
    read -rp "$prompt (blank ok): " val
  fi
  printf -v "$var" '%s' "$val"
}

ask_required() {
  local var="$1" prompt="$2"
  local val=""
  while [ -z "$val" ]; do
    read -rp "$prompt: " val
    if [ -z "$val" ]; then
      echo "  (required — please enter a value)"
    fi
  done
  printf -v "$var" '%s' "$val"
}

write_kv_toml() {
  # write_kv_toml <file> <section> <key> <value>
  # Rewrites the first occurrence of `<key> = "..."` inside [section].
  # Walks line-by-line so it's robust against the order of key writes.
  local file="$1" section="$2" key="$3" value="$4"
  python3 - "$file" "$section" "$key" "$value" <<'PY'
import re, sys
file, section, key, value = sys.argv[1:5]
section_pat = re.compile(r'^\[([A-Za-z_][\w.-]*)\]\s*$')
key_pat = re.compile(rf'^{re.escape(key)}\s*=\s*"[^"]*"\s*$')
lines = open(file, 'r', encoding='utf-8').read().splitlines(keepends=True)
in_section = False
done = False
for i, line in enumerate(lines):
    m = section_pat.match(line.rstrip())
    if m:
        in_section = (m.group(1) == section)
        continue
    if in_section and key_pat.match(line.rstrip()):
        lines[i] = f'{key} = "{value}"\n'
        done = True
        break
if not done:
    sys.stderr.write(f"✖ key {section}.{key} not found in {file}\n")
    sys.exit(1)
open(file, 'w', encoding='utf-8').write(''.join(lines))
PY
}

# ----- 1. config.toml -----
if [ -f config.toml ] && [ $FORCE -eq 0 ]; then
  echo "✓ config.toml already exists (use --force to overwrite)"
else
  echo "▶ Step 1: config.toml — branding + resource names"
  echo ""

  ask          SLUG        "Project slug (lowercase, hyphens; drives resource names)" "my-qa-bank"
  ask          HOST        "Public host (e.g. qa.example.com)" "qa.example.com"
  ask          SHORT_NAME  "Short brand name (top nav)" "My Q&A Bank"
  ask          LONG_TITLE  "Full title (<title> tag)" "$SHORT_NAME"
  ask          SUBTITLE    "Tagline / meta description" "Collaborative question bank"
  ask          GH_REPO     "GitHub repo for feedback button (owner/repo)" "your-handle/$SLUG"
  ask_required ADMIN_EMAIL "Admin email (your CF Access login)"
  ask          EXAM_DATE   "Exam date (ISO-8601 with TZ)" "2026-12-31T09:00:00+08:00"

  cp config.example.toml config.toml
  write_kv_toml config.toml project       slug              "$SLUG"
  write_kv_toml config.toml project       d1_db             "${SLUG}-db"
  write_kv_toml config.toml project       r2_bucket         "${SLUG}-uploads"
  write_kv_toml config.toml project       worker_name       "${SLUG}-api"
  write_kv_toml config.toml project       pages_project     "$SLUG"
  write_kv_toml config.toml project       gh_feedback_repo  "$GH_REPO"
  write_kv_toml config.toml project       admin_emails      "$ADMIN_EMAIL"
  write_kv_toml config.toml brand         short_name        "$SHORT_NAME"
  write_kv_toml config.toml brand         long_title        "$LONG_TITLE"
  write_kv_toml config.toml brand         subtitle          "$SUBTITLE"
  write_kv_toml config.toml exam          date_iso          "$EXAM_DATE"
  write_kv_toml config.toml public        host              "$HOST"
  write_kv_toml config.toml storage       theme_storage_key "${SLUG}:theme"
  write_kv_toml config.toml dev           dev_email         "$ADMIN_EMAIL"
  echo "  ✓ wrote config.toml"
  echo ""
fi

# ----- 2. wrangler.toml -----
if [ -f wrangler.toml ] && [ $FORCE -eq 0 ]; then
  echo "✓ wrangler.toml already exists (use --force to overwrite)"
else
  echo "▶ Step 2: wrangler.toml — Worker bindings + routes"

  # Read back what we just wrote (or what was already there)
  # shellcheck source=lib/cfg.sh
  . "$(dirname "$0")/lib/cfg.sh"
  SLUG=$(cfg project.slug)
  HOST=$(cfg public.host)
  D1_DB=$(cfg project.d1_db)
  R2_BUCKET=$(cfg project.r2_bucket)
  WORKER_NAME=$(cfg project.worker_name)
  GH_REPO=$(cfg project.gh_feedback_repo)
  ADMIN_EMAIL=$(cfg project.admin_emails)
  GROUPS_LIST=$(cfg groups.list)
  EXAM_DATE_ISO=$(cfg exam.date_iso)
  AI_SPECIALTY_ZH=$(cfg ai.specialty_zh)
  AI_SPECIALTY_EN_LONG=$(cfg ai.specialty_en_long)
  AI_TAG_DISEASE_EXAMPLES=$(cfg ai.tag_disease_examples)
  AI_TAG_TOPIC_EXAMPLES=$(cfg ai.tag_topic_examples)
  AI_QA_QUESTION_EXAMPLES=$(cfg ai.qa_question_examples)
  AI_QA_TERMINOLOGY_EXAMPLES=$(cfg ai.qa_terminology_examples)
  AI_QA_MC_BAD_EXAMPLE=$(cfg ai.qa_mc_bad_example)
  AI_QA_MC_GOOD_EXAMPLE=$(cfg ai.qa_mc_good_example)

  # Zone name — second-and-third labels of HOST joined (handles bare domain too)
  ZONE_NAME=$(python3 -c "h='${HOST}'.strip(); parts=h.split('.'); print('.'.join(parts[-2:]))")

  cp wrangler.example.toml wrangler.toml
  python3 - wrangler.toml \
    "$WORKER_NAME" "$HOST" "$ZONE_NAME" "$D1_DB" "$R2_BUCKET" \
    "$GH_REPO" "$ADMIN_EMAIL" "$GROUPS_LIST" "$EXAM_DATE_ISO" \
    "$AI_SPECIALTY_ZH" "$AI_SPECIALTY_EN_LONG" \
    "$AI_TAG_DISEASE_EXAMPLES" "$AI_TAG_TOPIC_EXAMPLES" \
    "$AI_QA_QUESTION_EXAMPLES" "$AI_QA_TERMINOLOGY_EXAMPLES" \
    "$AI_QA_MC_BAD_EXAMPLE" "$AI_QA_MC_GOOD_EXAMPLE" <<'PY'
import sys, re
path = sys.argv[1]
(worker_name, host, zone_name, d1_db, r2_bucket, gh_repo, admin_email,
 groups_list, exam_date_iso, ai_specialty_zh, ai_specialty_en_long,
 ai_tag_disease, ai_tag_topic, ai_qa_questions, ai_qa_terminology,
 ai_qa_mc_bad, ai_qa_mc_good) = sys.argv[2:19]
with open(path, 'r', encoding='utf-8') as f: t = f.read()

def q(v): return v.replace('\\', '\\\\').replace('"', '\\"')
def keysub(key, value):
    global t
    t = re.sub(rf'{key} = "[^"]*"', f'{key} = "{q(value)}"', t, count=1)

t = re.sub(r'^name = "[^"]+"', f'name = "{q(worker_name)}"', t, count=1, flags=re.M)
t = re.sub(r'qa\.example\.com', host, t)
t = re.sub(r'zone_name = "[^"]+"', f'zone_name = "{q(zone_name)}"', t)
t = re.sub(r'database_name = "[^"]+"', f'database_name = "{q(d1_db)}"', t)
t = re.sub(r'bucket_name = "[^"]+"', f'bucket_name = "{q(r2_bucket)}"', t)
keysub('GH_FEEDBACK_REPO', gh_repo)
keysub('ADMIN_EMAILS', admin_email)
keysub('GROUPS', groups_list)
keysub('EXAM_DATE_ISO', exam_date_iso)
keysub('AI_SPECIALTY_ZH', ai_specialty_zh)
keysub('AI_SPECIALTY_EN_LONG', ai_specialty_en_long)
keysub('AI_TAG_DISEASE_EXAMPLES', ai_tag_disease)
keysub('AI_TAG_TOPIC_EXAMPLES', ai_tag_topic)
keysub('AI_QA_QUESTION_EXAMPLES', ai_qa_questions)
keysub('AI_QA_TERMINOLOGY_EXAMPLES', ai_qa_terminology)
keysub('AI_QA_MC_BAD_EXAMPLE', ai_qa_mc_bad)
keysub('AI_QA_MC_GOOD_EXAMPLE', ai_qa_mc_good)

with open(path, 'w', encoding='utf-8') as f: f.write(t)
PY
  echo "  ✓ wrote wrangler.toml (database_id still <REPLACE_ME_DB_ID>; deploy.sh fills it in)"
  echo ""
fi

# ----- 3. .env -----
if [ -f .env ] && [ $FORCE -eq 0 ]; then
  echo "✓ .env already exists (use --force to overwrite)"
else
  echo "▶ Step 3: .env — Cloudflare credentials"
  echo ""
  echo "  Create a CF API token at https://dash.cloudflare.com/profile/api-tokens"
  echo "  Required scopes:"
  echo "    Account: Workers Scripts (Edit), D1 (Edit), R2 (Edit),"
  echo "             Access: Apps and Policies (Edit), Pages (Edit),"
  echo "             Access: Organizations / IdP / Groups (Read)"
  echo "    Zone:    DNS (Edit), Workers Routes (Edit)"
  echo ""

  ask_required CF_API_TOKEN   "CF_API_TOKEN"
  ask_required CF_ACCOUNT_ID  "CF_ACCOUNT_ID (dashboard right sidebar)"
  ask          ROSTER_CSV_URL "ROSTER_CSV_URL (Google Sheet CSV export; blank ok = admin-only)"

  ADMIN_EMAIL_DEFAULT=$(grep -E '^admin_emails' config.toml | sed 's/.*"\(.*\)"/\1/')
  HOST_DEFAULT=$(grep -E '^host\s*=' config.toml | sed 's/.*"\(.*\)"/\1/')

  cp .env.example .env
  python3 - .env "$CF_API_TOKEN" "$CF_ACCOUNT_ID" "$ROSTER_CSV_URL" "$ADMIN_EMAIL_DEFAULT" "$HOST_DEFAULT" <<'PY'
import sys, re
path, tok, acc, csv, admin, host = sys.argv[1:7]
with open(path, 'r', encoding='utf-8') as f: t = f.read()
def sub(k, v):
    global t
    t = re.sub(rf'^{re.escape(k)}=.*$', f'{k}={v}', t, count=1, flags=re.M)
sub('CF_API_TOKEN', tok)
sub('CF_ACCOUNT_ID', acc)
sub('ROSTER_CSV_URL', csv)
sub('ADMIN_EMAILS', admin)
sub('PAGES_DOMAIN', host)
with open(path, 'w', encoding='utf-8') as f: f.write(t)
PY
  echo "  ✓ wrote .env"
  echo ""
fi

echo "================================"
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Review config.toml, wrangler.toml, and .env"
echo "  2. Install deps:     pnpm install && (cd frontend && pnpm install)"
echo "  3. Local dev:        pnpm db:migrate:local && pnpm dev"
echo "                       (in another terminal)  cd frontend && pnpm dev"
echo "  4. Deploy:           ./scripts/deploy.sh"
echo "  5. Wire up Access:   node --experimental-strip-types scripts/sync-access.ts"
echo ""
echo "Full guide: CLAUDE.md §4 部署(引導流程), or README → Forking."
