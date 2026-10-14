// deploy.yml 的 check job。單元測試以前不在 CI 上,紅了仍會部署。
// 這支守的是接線:三項命令在 check 裡、pages/worker 等它、webkit 不混進來。
// 拿掉 needs 的話,測試紅了 Pages 還是會更新 —— 而那正是要擋的事。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');

function jobBlock(name) {
	const start = yml.indexOf(`\n  ${name}:\n`);
	assert.ok(start >= 0, `找不到 job ${name}`);
	const rest = yml.slice(start + 1);
	const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
	return next < 0 ? rest : rest.slice(0, next + 1);
}

test('會部署時先跑 typecheck 與單元測試,紅了才不會上線', () => {
	const check = jobBlock('check');
	assert.match(check, /needs: classify/);
	assert.match(check, /needs\.classify\.outputs\.pages == 'true'/);
	assert.match(check, /needs\.classify\.outputs\.worker == 'true'/);
	assert.match(check, /node-version: 22/);
	assert.match(check, /^ {8}run: pnpm typecheck$/m);
	assert.match(check, /^ {8}run: pnpm --dir frontend typecheck$/m);
	assert.match(check, /^ {8}run: pnpm test$/m);
	assert.doesNotMatch(check, /test:webkit/);

	for (const name of ['pages', 'worker']) {
		const job = jobBlock(name);
		assert.match(job, /needs: \[classify, check\]/);
		assert.doesNotMatch(job, /always\(\)/);
	}
});

test('Pages 部署前跑整包 WebKit,併發維持 2', () => {
	const pages = jobBlock('pages');
	// node 20 把引號裡的 glob 當字面路徑,整包在跑到任何 spec 之前就退出。
	assert.match(pages, /node-version: 22/);
	assert.doesNotMatch(pages, /node-version: 20/);
	assert.match(pages, /E2E_REQUIRE: '1'/);
	assert.match(pages, /node --test --test-concurrency=2 'frontend\/e2e\/\*\.test\.mjs'/);
	assert.match(pages, /playwright install --with-deps webkit chromium/);
	assert.doesNotMatch(pages, /smoke\.test\.mjs frontend\/e2e\/nav-prefetch/);
	// 題目頁與抹片作答的 spec 在這個 glob 裡。點名清單漏掉它們時,這條會紅。
	for (const file of ['smoke.test.mjs', 'smear-practice.test.mjs', 'tab-cache.test.mjs']) {
		assert.ok(
			fs.existsSync(path.join(ROOT, 'frontend/e2e', file)),
			`${file} 不在 e2e glob 裡`,
		);
	}
});
