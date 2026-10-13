// 比對 wrangler.example.toml 與 CI 的 WRANGLER_TOML。
//
// 2026-08-10 的部署失敗指著 ChatRoom,真正少的是 secret 裡後面的 migration tag。
// 本機那份 toml 是對的,所以本機重現不出來。這裡只比「範本有、secret 沒有」的
// 名稱:vectorize / d1 / r2 / Durable Object binding,以及 migration tag。
// database_id、bucket 名、密鑰都不比,也不印 secret 的內容。

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SECTIONS = {
	'[[vectorize]]': 'vectorize',
	'[[d1_databases]]': 'd1',
	'[[r2_buckets]]': 'r2',
	'[[durable_objects.bindings]]': 'do',
	'[[migrations]]': 'migration',
};

const LABELS = [
	['vectorize', 'vectorize binding'],
	['d1', 'd1 binding'],
	['r2', 'r2 binding'],
	['do', 'durable object binding'],
	['migration', 'migration tag'],
];

export function extractBindings(toml) {
	const out = { vectorize: [], d1: [], r2: [], do: [], migration: [] };
	let section = null;
	for (const raw of String(toml).split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		if (line.startsWith('[')) {
			section = SECTIONS[line] ?? null;
			continue;
		}
		if (!section) continue;
		const m = line.match(/^(binding|name|tag)\s*=\s*["']([^"']*)["']/);
		if (!m) continue;
		const [, key, value] = m;
		if (section === 'migration' && key === 'tag') out.migration.push(value);
		else if (section === 'do' && key === 'name') out.do.push(value);
		else if (key === 'binding' && section !== 'migration' && section !== 'do') {
			out[section].push(value);
		}
	}
	return out;
}

/** @returns {{ kind: string, name: string }[]} 範本有、secret 沒有的項目 */
export function missingBindings(exampleToml, secretToml) {
	const want = extractBindings(exampleToml);
	const have = extractBindings(secretToml);
	const missing = [];
	for (const [key, kind] of LABELS) {
		const got = new Set(have[key]);
		for (const name of want[key]) {
			if (!got.has(name)) missing.push({ kind, name });
		}
	}
	return missing;
}

function report(missing) {
	const lines = missing.map((m) => `${m.kind}: ${m.name}`);
	console.error('WRANGLER_TOML 少了 wrangler.example.toml 有的項目:');
	for (const line of lines) console.error(`  ${line}`);
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) {
		const body = [
			'',
			'> ⛔️ **WRANGLER_TOML 少了 wrangler.example.toml 有的項目,部署沒有開始。**',
			'>',
			...missing.map((m) => `> - ${m.kind} \`${m.name}\``),
			'>',
			'> 把主 checkout 的 `wrangler.toml` 重設 secret:',
			'> `gh secret set WRANGLER_TOML < wrangler.toml`',
			'',
		].join('\n');
		fs.appendFileSync(summary, body);
	}
}

function main() {
	const [examplePath, secretPath] = process.argv.slice(2);
	if (!examplePath || !secretPath) {
		console.error('usage: check-wrangler-bindings.mjs <example> <secret>');
		process.exit(2);
	}
	const missing = missingBindings(
		fs.readFileSync(examplePath, 'utf8'),
		fs.readFileSync(secretPath, 'utf8'),
	);
	if (missing.length === 0) {
		console.log('WRANGLER_TOML 的 binding 與 migration tag 跟範本一致');
		return;
	}
	report(missing);
	process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
