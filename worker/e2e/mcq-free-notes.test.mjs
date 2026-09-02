// 「其他筆記」透過 .skill 讀寫的端到端測試。
//
// 這支是這個 repo 第一支 **Worker 層** 的 e2e —— 其餘 worker 測試全是純函式
// (CLAUDE.md 講過這件事)。它存在的理由是這條路徑的價值全在接線上:HMAC 金鑰、
// Hono 的註冊順序、Python CLI 的旗標解析、冪等標頭。任何一段錯掉,純函式測試
// 都是全綠的。
//
// 跑法:pnpm test:mcq-skill
//
// 它真的啟一個 `wrangler dev`(本機 D1)、真的用 HMAC 鑄一把金鑰、真的執行
// mcq_cmd.py / get_mcq.py,然後看終端輸出。不 mock 任何一層。
//
// ⚠️ 用一個專屬的測試帳號(users 一列),結束時刪掉 —— free_notes 有
// ON DELETE CASCADE,所以連帶清乾淨。**絕不動你自己的那些筆記**,也不會碰
// .claude/skills/mcq/.env(改用 MCQ_ENV_FILE 指到暫存檔)。
//
// ⚠️ 埠號不用 8787:那個埠常被 OpenEvidence 的 relay daemon 佔走,症狀是
// 整批 API 回 500/404 而看起來像程式壞了。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SCRIPTS = join(ROOT, ".claude/skills/mcq/scripts");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = "e2e-free-notes@example.test";
const REQUIRE = process.env.E2E_REQUIRE === "1";

let proc = null;
let tmp = null;
let envFile = null;
let skipReason = null;

/** .dev.vars 的 MCQ_KEY_SECRET —— 沒有它就沒辦法鑄出 Worker 認得的金鑰。 */
function devSecret() {
  const f = join(ROOT, ".dev.vars");
  if (!existsSync(f)) return null;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^MCQ_KEY_SECRET\s*=\s*(.*)$/.exec(line.trim());
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

/** 與 worker/lib/apikey.ts 的 deriveMcqKey 同一條式子。兩邊要一致,否則 401。 */
function mintKey(secret, email, version) {
  const mac = createHmac("sha256", secret).update(`${email}:${version}`).digest("base64");
  return "mcqk_" + mac.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function d1(sql) {
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "hema-2026-db", "--local", "--command", sql],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** 跑一次 skill 的前門(mcq_cmd.py),回傳 stdout。失敗時把 stderr 一起丟出來。 */
function mcq(args, { expectFail = false } = {}) {
  const r = spawnSync_(join(SCRIPTS, "mcq_cmd.py"), [args]);
  if (!expectFail && r.status !== 0)
    throw new Error(`mcq_cmd.py '${args}' 失敗 (${r.status})\n${r.stdout}\n${r.stderr}`);
  return (r.stdout || "") + (r.stderr || "");
}
function raw(argv, { expectFail = false } = {}) {
  const r = spawnSync_(join(SCRIPTS, "get_mcq.py"), argv);
  if (!expectFail && r.status !== 0)
    throw new Error(`get_mcq.py ${argv.join(" ")} 失敗 (${r.status})\n${r.stdout}\n${r.stderr}`);
  return (r.stdout || "") + (r.stderr || "");
}
function spawnSync_(script, argv) {
  return spawnSync("python3", [script, ...argv], {
    cwd: SCRIPTS,
    encoding: "utf8",
    // 指到暫存的 .env —— 絕不動使用者自己那份(裡面是正式站的金鑰)。
    env: { ...process.env, MCQ_ENV_FILE: envFile },
  });
}

before(async () => {
  const secret = devSecret();
  if (!secret) {
    skipReason = ".dev.vars 沒有 MCQ_KEY_SECRET";
    if (REQUIRE) throw new Error(skipReason);
    return;
  }

  const now = Date.now();
  d1(
    `INSERT INTO users (email, display_name, created_at, updated_at, mcq_key_version)
     VALUES ('${EMAIL}', 'e2e', ${now}, ${now}, 1)
     ON CONFLICT(email) DO UPDATE SET mcq_key_version = 1;`,
  );
  d1(`DELETE FROM free_notes WHERE user_email = '${EMAIL}';`);
  // ⚠️ 去重紀錄一定要一起清。request_dedup 沒有掛 users 的外鍵,所以刪帳號
  // 不會連帶清掉它 —— 上一輪留下的 key 會讓這一輪的第一次寫入直接被 replay,
  // 症狀是「已建立」變成「本次未重複寫入」而測試全紅,而且只有第二次跑才會發生。
  d1(`DELETE FROM request_dedup WHERE user_email = '${EMAIL}';`);

  tmp = mkdtempSync(join(tmpdir(), "mcq-e2e-"));
  envFile = join(tmp, ".env");
  writeFileSync(
    envFile,
    `MCQ_API_BASE=${BASE}\nMCQ_API_KEY=${mintKey(secret, EMAIL, 1)}\nMCQ_USER_EMAIL=${EMAIL}\n`,
  );

  proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 就緒判斷只問「有沒有人回話」—— 拿狀態碼當訊號會踩到:沒帶金鑰時
  // middleware 回的是 400 不是 401,寫死其中一個就會等到逾時然後全紅,而原因
  // 完全不指向就緒判斷。路由到底有沒有掛上,由最後那條「路由順序」的測試負責。
  // 啟動要 20–40 秒(AI / Vectorize binding 會先連遠端),所以給到 120 秒。
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("wrangler dev 120 秒內沒起來");
    try {
      await fetch(`${BASE}/api/mcq/free-notes`, { headers: { "User-Agent": "e2e/1" } });
      break;
    } catch {
      /* 還沒起來 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
});

after(() => {
  if (proc) proc.kill("SIGTERM");
  try {
    // users 刪掉 → free_notes 靠 ON DELETE CASCADE 一起走。
    d1(`DELETE FROM users WHERE email = '${EMAIL}';`);
    d1(`DELETE FROM request_dedup WHERE user_email = '${EMAIL}';`);
  } catch {
    /* wrangler 不在也無所謂 */
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const skip = () => (skipReason ? { skip: skipReason } : {});

test("一開始是空的 —— 後面每一條斷言的對照基準", skip(), () => {
  const out = mcq("other");
  assert.match(out, /還沒有任何其他筆記/);
});

test("other new [標題]: 內容 → 建立,而且標題與內文都真的存進去", skip(), () => {
  const out = mcq("other new [語氣作答法]: 負向題看到 may 先劃掉。");
  assert.match(out, /已建立其他筆記/);
  assert.match(out, /語氣作答法/);
  // 先確認「有回全文」再確認內容 —— 少了前半段,選擇器壞掉時後半段也會通過。
  assert.match(out, /目前筆記全文/);
  assert.match(out, /負向題看到 may 先劃掉。/);
});

test("清單看得到剛建的那則,而且印出短碼與摘要", skip(), () => {
  const out = mcq("other");
  assert.match(out, /其他筆記 1 則/);
  assert.match(out, /\[[0-9a-f]{8}\] 語氣作答法/);
  assert.match(out, /負向題看到 may/); // 摘要
});

/** 從清單抓短碼 —— 測試不該寫死 UUID。 */
function short() {
  const m = /\[([0-9a-f]{8})\] 語氣作答法/.exec(mcq("other"));
  assert.ok(m, "清單裡找不到剛建立的筆記,後面的斷言沒有意義");
  return m[1];
}

test("other <短碼> → 讀得回全文", skip(), () => {
  const out = mcq(`other ${short()}`);
  assert.match(out, /# 語氣作答法/);
  assert.match(out, /負向題看到 may 先劃掉。/);
});

test("other <短碼>: 內容 → append,舊內容留著", skip(), () => {
  const out = mcq(`other ${short()}: 只有 only 值得掃。`);
  assert.match(out, /已附加到其他筆記/);
  assert.match(out, /負向題看到 may 先劃掉。/); // 舊的還在
  assert.match(out, /只有 only 值得掃。/); // 新的也在
});

test("同一份內容再送一次不會重複 append(冪等)", skip(), () => {
  const s = short();
  const out = mcq(`other ${s}: 只有 only 值得掃。`);
  assert.match(out, /本次未重複寫入/);
  // 正面對照:內文裡「只有 only」只能出現一次,否則就是又 append 了一份。
  const body = mcq(`other ${s}`);
  assert.equal(body.split("只有 only 值得掃。").length - 1, 1);
});

test("replace 覆寫,並把被蓋掉的舊內容吐回來(可救回)", skip(), () => {
  const out = mcq(`other ${short()} replace: 整份重寫。`);
  assert.match(out, /已覆寫其他筆記/);
  assert.match(out, /被覆寫的舊內容/);
  assert.match(out, /負向題看到 may 先劃掉。/); // 舊內容在「被覆寫」區塊裡
  const body = mcq(`other ${short()}`);
  assert.match(body, /整份重寫。/);
  assert.doesNotMatch(body, /負向題看到 may/); // 新全文裡沒有了
});

test("不給代號一律另開一則,不會動到既有筆記", skip(), () => {
  mcq("other new: 第二則。");
  const out = mcq("other");
  assert.match(out, /其他筆記 2 則/);
  assert.match(out, /整份重寫。/); // 第一則沒被動到
});

test("沒給標題就取內文第一行", skip(), () => {
  const out = mcq("other new: # 自動命名測試\n內文。");
  assert.match(out, /已建立其他筆記 \[[0-9a-f]{8}\]「自動命名測試」/);
});

test("找不到的代號回 404,並指路", skip(), () => {
  const out = mcq("other zzzzzzzz: x", { expectFail: true });
  assert.match(out, /API 404/);
  // 斷言**伺服器**回的字串,不只是狀態碼:把兩條路由搬到 `/:id` 後面時,
  // 這裡同樣會拿到 404 —— 但那是「question not found」。只看 404 的話,
  // 這條在功能整個壞掉時照樣是綠的(停用驗證時實際發生過)。
  assert.match(out, /free note not found/);
  assert.match(out, /先跑 --free-notes/); // CLI 自己的指路(不會因為狀態碼而變)
});

test("代號對到多則時報 409 並列出候選,不猜", skip(), () => {
  // 短碼是隨機 UUID 的前 8 碼,自然撞號等不到 —— 直接把 id 改成同前綴。
  d1(
    `UPDATE free_notes SET id = 'dupeaaaa-' || substr(id, 10)
      WHERE user_email = '${EMAIL}' AND id NOT LIKE 'dupeaaaa%';`,
  );
  const out = mcq("other dupeaaaa: x", { expectFail: true });
  assert.match(out, /API 409/);
  assert.match(out, /ambiguous note ref/);
  assert.match(out, /多打幾碼/);
});

test("其他筆記不吃題號 —— 誤把題目筆記的寫法套過來會被擋下", skip(), () => {
  const out = raw(["--free-notes", "114-001"], { expectFail: true });
  assert.match(out, /其他筆記不掛在題目上/);
});

test("--free new 沒帶內容就報錯,不會建出一則空筆記", skip(), () => {
  const out = raw(["--free", "new"], { expectFail: true });
  assert.match(out, /要搭配 --note/);
});

test("路由順序:free-notes 沒有被 /:id 當成題號吞掉", skip(), async () => {
  // 這條是這支測試最該守的東西。Hono 依註冊順序比對,把 free-notes 兩條放到
  // `/:id` 後面的話,這裡會拿到「查無此題」而不是筆記清單 —— 而且症狀完全
  // 不指向路由順序。
  const key = readFileSync(envFile, "utf8").match(/MCQ_API_KEY=(.*)/)[1].trim();
  const res = await fetch(`${BASE}/api/mcq/free-notes`, {
    headers: { Authorization: `Bearer ${key}`, "X-User-Email": EMAIL, "User-Agent": "e2e/1" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.items), "回的不是筆記清單,八成被 /:id 接走了");
  assert.equal(typeof body.max, "number");
});
