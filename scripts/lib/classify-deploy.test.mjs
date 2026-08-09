// classify-deploy.sh 的判準。這支存在的理由是它守著一個曾經**靜靜失效**的東西:
// 舊 guard 的條件是「有沒有非 frontend 的檔案」,於是 CLAUDE.md / package.json /
// scripts/ 任何一個檔案都會讓部署跳過,而 job 仍然顯示綠色。最近 30 個 commit 裡
// 20 次動到 frontend,只有 10 次真的部署了 —— 沒有任何測試或訊號指出這件事。
//
// 所以下面每一條「應該要部署」的案例,都是實際發生過的 commit 形狀。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'classify-deploy.sh');

function classify(files) {
  const out = execFileSync('bash', [SCRIPT], {
    input: files.join('\n'),
    encoding: 'utf8',
  });
  return Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)];
      })
  );
}

test('純前端變更 → 只部署 Pages', () => {
  const r = classify(['frontend/src/routes/Home.tsx']);
  assert.equal(r.pages, 'true');
  assert.equal(r.worker, 'false');
  assert.equal(r.blocked, 'false');
});

test('純 worker 變更 → 只部署 Worker', () => {
  const r = classify(['worker/routes/questions.ts']);
  assert.equal(r.pages, 'false');
  assert.equal(r.worker, 'true');
});

test('前端 + worker → 兩邊都部署(舊 guard 在這裡兩邊都跳過)', () => {
  const r = classify(['frontend/src/App.tsx', 'worker/lib/challenges.ts']);
  assert.equal(r.pages, 'true');
  assert.equal(r.worker, 'true');
  assert.equal(r.blocked, 'false');
});

// 這四個是實測擋下最多次部署的檔案,一個都不該擋。
for (const neutral of [
  'CLAUDE.md',
  'package.json',
  'tsconfig.json',
  'scripts/audit-truncated-options.py',
]) {
  test(`前端變更帶著 ${neutral} → 仍然部署 Pages`, () => {
    const r = classify(['frontend/src/routes/Home.tsx', neutral]);
    assert.equal(r.pages, 'true', `${neutral} 不該擋下部署`);
    assert.equal(r.blocked, 'false');
  });
}

test('.claude/skills 變更算 worker —— 它會被 gen:bundles 烤進 worker/generated', () => {
  const r = classify(['.claude/skills/bank-ingest/scripts/parse_exam.py']);
  assert.equal(r.worker, 'true');
  assert.equal(r.pages, 'false');
});

test('migrations → 擋下,而且理由要指名是哪個檔案', () => {
  const r = classify(['frontend/src/App.tsx', 'migrations/0041_x.sql']);
  assert.equal(r.blocked, 'true');
  assert.equal(r.pages, 'false');
  assert.equal(r.worker, 'false');
  assert.match(r.reason, /0041_x\.sql/);
});

test('wrangler.example.toml → 擋下(新 binding 要先進 WRANGLER_TOML secret)', () => {
  const r = classify(['worker/index.ts', 'wrangler.example.toml']);
  assert.equal(r.blocked, 'true');
  assert.match(r.reason, /wrangler\.example\.toml/);
});

test('config.example.toml → 擋下', () => {
  const r = classify(['config.example.toml']);
  assert.equal(r.blocked, 'true');
});

test('.github/workflows 刻意不擋 —— 擋這一次不會讓任何事更安全', () => {
  const r = classify(['.github/workflows/deploy.yml', 'frontend/src/App.tsx']);
  assert.equal(r.blocked, 'false');
  assert.equal(r.pages, 'true');
});

test('只動文件 → 兩邊都不部署,但不是 blocked', () => {
  const r = classify(['CLAUDE.md', 'docs/plans/x.md']);
  assert.equal(r.pages, 'false');
  assert.equal(r.worker, 'false');
  assert.equal(r.blocked, 'false');
  assert.match(r.reason, /nothing deployable/);
});

test('空清單不會炸', () => {
  const r = classify([]);
  assert.equal(r.blocked, 'false');
  assert.equal(r.pages, 'false');
});

// 名字裡帶 migrations 但不在 migrations/ 底下的檔案不該被誤擋。
test('worker/lib/migrations-helper.ts 不是 migration', () => {
  const r = classify(['worker/lib/migrations-helper.ts']);
  assert.equal(r.blocked, 'false');
  assert.equal(r.worker, 'true');
});
