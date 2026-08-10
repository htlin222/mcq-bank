#!/usr/bin/env bash
#
# 決定一次 push 該部署什麼。讀 stdin 的變更檔案清單(一行一個),印出
# GITHUB_OUTPUT 形式的 KEY=value。
#
# 這支獨立於 workflow 的理由:它是純函式(檔案清單 → 決策),抽出來才驗得到。
# 內嵌在 YAML 裡的 shell 只能靠「推上去看看會不會動」來驗,而部署腳本正是最
# 不該用那種方式驗的東西。測試在 classify-deploy.test.mjs。
#
# 判準是 **denylist,不是 allowlist**。舊版問的是「有沒有非 frontend 的檔案」,
# 於是 CLAUDE.md、package.json、scripts/ 底下任何一個檔案都會讓整次部署靜靜
# 跳過 —— 實測最近 30 個 commit 裡,20 次動到 frontend 只有 10 次真的部署了。
# 該問的是「有沒有**真的需要人**的檔案」,而那只有三種:
#
#   migrations/**        —— 要跑 d1 migrations apply --remote
#   wrangler.example.toml —— 新 binding。wrangler.toml 是 gitignored 的產出物,
#                            CI 的那份來自 WRANGLER_TOML secret,不會自己長出
#                            新 binding;漏補的話 Worker 會因為找不到 class 而
#                            部署失敗(2048 的 PLAY binding 踩過)。
#   config.example.toml   —— 新的 per-fork 設定值,同理要先進 CONFIG_TOML secret。
#
# `.github/workflows/**` 刻意**不**在清單裡:改了 pipeline 之後跑的本來就是新版
# 的 pipeline,擋下這一次不會讓任何事更安全,只會多一次手動部署。

set -euo pipefail

BLOCK_RE='^(migrations/|wrangler\.example\.toml$|config\.example\.toml$)'
PAGES_RE='^frontend/'
# .claude/skills/** 也算 worker 變更:它們被 gen:bundles 快照進
# worker/generated/*.ts,由 /api/me/bank-skill 等端點提供下載。
WORKER_RE='^(worker/|\.claude/skills/)'

changed="$(cat)"

emit() { printf '%s\n' "$1"; }

if [ -z "${changed//[[:space:]]/}" ]; then
  emit 'pages=false'
  emit 'worker=false'
  emit 'blocked=false'
  emit 'reason=no file changes'
  exit 0
fi

blockers="$(printf '%s\n' "$changed" | grep -E "$BLOCK_RE" || true)"
if [ -n "$blockers" ]; then
  emit 'pages=false'
  emit 'worker=false'
  emit 'blocked=true'
  emit "reason=$(printf '%s' "$blockers" | tr '\n' ' ')"
  exit 0
fi

pages=false
worker=false
printf '%s\n' "$changed" | grep -qE "$PAGES_RE" && pages=true
printf '%s\n' "$changed" | grep -qE "$WORKER_RE" && worker=true

emit "pages=$pages"
emit "worker=$worker"
emit 'blocked=false'
if [ "$pages" = false ] && [ "$worker" = false ]; then
  emit 'reason=nothing deployable changed'
else
  emit 'reason=ok'
fi
