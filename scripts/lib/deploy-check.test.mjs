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
