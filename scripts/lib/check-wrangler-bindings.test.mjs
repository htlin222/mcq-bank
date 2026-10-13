import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractBindings, missingBindings } from './check-wrangler-bindings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const SCRIPT = path.join(HERE, 'check-wrangler-bindings.mjs');
const SECRET = 'super-secret-value-xyz';

const EXAMPLE = `
[[d1_databases]]
binding = "DB"
database_id = "<REPLACE_ME_DB_ID>"

[[r2_buckets]]
binding = "R2"

[[vectorize]]
binding = "VEC"

[[durable_objects.bindings]]
name = "CHAT"

[[migrations]]
tag = "v1"

[[migrations]]
tag = "v2"

# [[kv_namespaces]]
# binding = "CACHE"
`;

test('範本有的 binding 與 tag 都要在 secret 裡', () => {
	const got = extractBindings(EXAMPLE);
	assert.deepEqual(got.d1, ['DB']);
	assert.deepEqual(got.r2, ['R2']);
	assert.deepEqual(got.vectorize, ['VEC']);
	assert.deepEqual(got.do, ['CHAT']);
	assert.deepEqual(got.migration, ['v1', 'v2']);
	assert.deepEqual(missingBindings(EXAMPLE, EXAMPLE), []);
});

test('註解裡的 binding 不算,secret 多出來的也不擋', () => {
	const secret = `
[[d1_databases]]
binding = "DB"
database_id = "real-id-not-printed"
[[r2_buckets]]
binding = "R2"
[[r2_buckets]]
binding = "EXTRA"
[[vectorize]]
binding = "VEC"
[[durable_objects.bindings]]
name = "CHAT"
[[migrations]]
tag = "v1"
[[migrations]]
tag = "v2"
[[migrations]]
tag = "v9"
TOKEN = "${SECRET}"
`;
	assert.deepEqual(missingBindings(EXAMPLE, secret), []);
	assert.deepEqual(extractBindings('# [[vectorize]]\n# binding = "VEC"\n').vectorize, []);
});

test('少一個 migration tag 時點名它,而且不印 secret', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrangler-bind-'));
	const example = path.join(dir, 'example.toml');
	const secret = path.join(dir, 'secret.toml');
	fs.writeFileSync(example, EXAMPLE);
	fs.writeFileSync(
		secret,
		EXAMPLE.replace('tag = "v2"', 'tag = "v1"') + `\nTOKEN = "${SECRET}"\n`,
	);
	const summary = path.join(dir, 'summary.md');
	const r = spawnSync(process.execPath, [SCRIPT, example, secret], {
		encoding: 'utf8',
		env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
	});
	assert.equal(r.status, 1);
	const out = `${r.stdout}${r.stderr}${fs.readFileSync(summary, 'utf8')}`;
	assert.match(out, /migration tag: v2/);
	assert.match(out, /migration tag `v2`/);
	assert.doesNotMatch(out, /super-secret-value-xyz/);
	assert.doesNotMatch(out, /REPLACE_ME_DB_ID/);
	fs.rmSync(dir, { recursive: true });
});

test('範本對上自己是通過', () => {
	const example = path.join(ROOT, 'wrangler.example.toml');
	const r = spawnSync(process.execPath, [SCRIPT, example, example], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const got = extractBindings(fs.readFileSync(example, 'utf8'));
	assert.deepEqual(got.migration, ['v1', 'v2', 'v3']);
	assert.deepEqual(got.do, ['CHAT', 'USER_STATE', 'PLAY']);
	assert.deepEqual(got.d1, ['DB']);
	assert.deepEqual(got.r2, ['R2']);
});

test('worker 部署會先跑這支,而且在 deploy 之前', () => {
	const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
	const start = yml.indexOf('\n  worker:\n');
	const worker = yml.slice(start);
	const checkAt = worker.indexOf('check-wrangler-bindings.mjs');
	const deployAt = worker.indexOf('command: deploy');
	assert.ok(checkAt > 0);
	assert.ok(deployAt > checkAt);
	assert.doesNotMatch(worker, /echo "\$WRANGLER_TOML"|cat wrangler\.toml/);
});
