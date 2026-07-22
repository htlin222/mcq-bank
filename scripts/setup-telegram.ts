#!/usr/bin/env node
/**
 * Telegram 出題機器人一鍵註冊 —— idempotent。
 *
 * 做的事:
 *   1. setWebhook 到  https://<PUBLIC_HOST>/tg/webhook,帶 secret_token
 *      (Telegram 回呼時放進 X-Telegram-Bot-Api-Secret-Token header)。
 *   2. setMyCommands(/start /today /quiz /stats /settings /stop /help)。
 *   3. setChatMenuButton → commands(選單鈕直接展開指令)。
 *   4. getMe 印出 bot username,提醒填進 config.toml / wrangler.toml。
 *
 * 讀 repo 根目錄 .env。必需:
 *   TG_BOT_TOKEN        BotFather /newbot 給的 token
 *   TG_WEBHOOK_SECRET   自訂亂數(需與 wrangler secret 設的同值)
 * 由 config.toml 取 public.host。
 *
 * 前置:先把 secret 推上 Worker 並部署:
 *   wrangler secret put TG_BOT_TOKEN
 *   wrangler secret put TG_WEBHOOK_SECRET
 *   ./scripts/deploy.sh   # 或 wrangler deploy
 * 並讓 /tg/* 走 Access bypass(scripts/setup-public-bypass.sh)。
 *
 * 執行:
 *   node --experimental-strip-types scripts/setup-telegram.ts
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cfg } from './lib/cfg.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');
const API = 'https://api.telegram.org';

type Env = Record<string, string>;

const COMMANDS = [
  { command: 'today', description: '立刻來一題' },
  { command: 'quiz', description: '挑年份開始測驗' },
  { command: 'stats', description: '我的統計' },
  { command: 'settings', description: '推播時段 / 年份 / 開關' },
  { command: 'stop', description: '暫停每日推播' },
  { command: 'help', description: '說明' },
];

async function main() {
  const env = await loadEnv();
  must(env, ['TG_BOT_TOKEN', 'TG_WEBHOOK_SECRET']);
  const token = env.TG_BOT_TOKEN;
  const host = cfg('public.host');
  if (!host || host === 'qa.example.com') {
    throw new Error('config.toml [public].host 尚未設定成正式網域');
  }
  const webhookUrl = `https://${host}/tg/webhook`;

  const me = await call(token, 'getMe', {});
  console.log(`▶ bot: @${(me as { username?: string }).username ?? '?'}`);

  console.log(`▶ setWebhook → ${webhookUrl}`);
  await call(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: env.TG_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });

  console.log('▶ setMyCommands');
  await call(token, 'setMyCommands', { commands: COMMANDS });

  console.log('▶ setChatMenuButton → commands');
  await call(token, 'setChatMenuButton', { menu_button: { type: 'commands' } });

  const info = (await call(token, 'getWebhookInfo', {})) as { url?: string; pending_update_count?: number };
  console.log(`✔ 完成。webhook=${info.url} pending=${info.pending_update_count ?? 0}`);
  console.log(
    `\n記得:config.toml [telegram].bot_username 與 wrangler.toml [vars].TG_BOT_USERNAME ` +
      `都要設成 "@${(me as { username?: string }).username ?? '<bot>'}" 去掉 @ 的字串。`,
  );
}

async function call(token: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result;
}

async function loadEnv(): Promise<Env> {
  const txt = await readFile(ENV_PATH, 'utf-8');
  const env: Env = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function must(env: Env, keys: string[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`.env 缺少: ${missing.join(', ')}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
