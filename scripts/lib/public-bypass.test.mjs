// Access bypass 清單與 Worker 在 authMiddleware 之前掛的路徑。
//
// 漏 bypass:邊緣回 302 登入頁,fetch 看起來像 200 的 HTML。
// 多 bypass:尤其是 /api/admin,偷到的筆電就能推進正式題庫。
// 兩邊各寫各的,這支把對稱差看成失敗。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Pages 自己的檔,Worker 沒有對應路由。多一條或少一條都是清單漂了。
const PAGES_PATHS = [
	'/',
	'/assets/*',
	'/favicon.svg',
	'/icons/*',
	'/manifest.webmanifest',
	'/og-image.png',
	'/sw.js',
];

// Worker 不跑 Access middleware,但正式機前面仍有 Access。不是公開路徑。
const WORKER_OPEN_NOT_EDGE = ['/api/health'];

// 邊緣放行、Worker 仍跑 authMiddleware,這樣沒登入時回的是 401 JSON 而不是登入頁。
const AUTH_PROBE = '/api/me';

export function bypassPaths(script) {
	return [...script.matchAll(/^\s*"([^"|]+)\|/gm)].map((m) => m[1]);
}

export function preAuthMounts(indexSrc) {
	const cut = indexSrc.indexOf('app.use("/api/*", authMiddleware)');
	if (cut < 0) return null;
	const head = indexSrc.slice(0, cut);
	return [
		...head.matchAll(/app\.(?:get|post|put|delete|route)\(\s*["']([^"']+)["']/g),
	].map((m) => m[1]);
}

function covers(pattern, mount) {
	if (pattern === mount) return true;
	if (pattern.endsWith('/*')) {
		const prefix = pattern.slice(0, -2);
		return mount === prefix || mount.startsWith(prefix + '/');
	}
	return false;
}

function isWorkerSurface(p) {
	return (
		p.startsWith('/api') ||
		p.startsWith('/tg') ||
		p.startsWith('/img') ||
		p.startsWith('/pdf')
	);
}

/** @returns {string[]} 空陣列代表兩邊一致 */
export function publicSurfaceErrors(script, indexSrc) {
	const errors = [];
	const paths = bypassPaths(script);
	const mounts = preAuthMounts(indexSrc);
	if (!mounts) {
		return ['worker/index.ts 找不到 app.use("/api/*", authMiddleware)'];
	}
	const tail = indexSrc.slice(indexSrc.indexOf('app.use("/api/*", authMiddleware)'));

	if (paths.some((p) => p === '/api/admin' || p.startsWith('/api/admin/'))) {
		errors.push('/api/admin 不可以進 bypass');
	}
	if (!tail.includes(`app.route("${AUTH_PROBE}"`) && !tail.includes(`app.route('${AUTH_PROBE}'`)) {
		errors.push(`${AUTH_PROBE} 應該在 authMiddleware 之後`);
	}

	const pages = paths.filter((p) => !isWorkerSurface(p)).sort();
	const wantPages = [...PAGES_PATHS].sort();
	for (const p of wantPages) {
		if (!pages.includes(p)) errors.push(`bypass 少了 Pages 路徑 ${p}`);
	}
	for (const p of pages) {
		if (!wantPages.includes(p)) errors.push(`bypass 多了 Pages 路徑 ${p}`);
	}

	for (const mount of mounts) {
		if (WORKER_OPEN_NOT_EDGE.includes(mount)) {
			if (paths.some((p) => covers(p, mount))) {
				errors.push(`${mount} 不該在 bypass 清單裡`);
			}
			continue;
		}
		if (!paths.some((p) => covers(p, mount))) {
			errors.push(`${mount} 掛在 auth 之前,bypass 清單沒有`);
		}
	}

	for (const p of paths.filter(isWorkerSurface)) {
		if (p === AUTH_PROBE) continue;
		if (p === '/api/admin' || p.startsWith('/api/admin/')) continue;
		const prefix = p.endsWith('/*') ? p.slice(0, -2) : p;
		if (!mounts.includes(prefix)) {
			errors.push(`${p} 在 bypass 清單,但沒有掛在 auth 之前`);
		}
	}

	for (const mount of WORKER_OPEN_NOT_EDGE) {
		if (!mounts.includes(mount)) errors.push(`${mount} 應該留在 auth 之前`);
	}
	return errors;
}

const script = fs.readFileSync(path.join(ROOT, 'scripts/setup-public-bypass.sh'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'worker/index.ts'), 'utf8');

test('bypass 清單與 auth 之前的路由一致', () => {
	assert.deepEqual(publicSurfaceErrors(script, indexSrc), []);
});

test('拿掉 /api/mcq 時紅', () => {
	const broken = script.replace('"/api/mcq/*|', '"/not-mcq/*|');
	const errors = publicSurfaceErrors(broken, indexSrc);
	assert.ok(errors.some((e) => e.includes('/api/mcq')), errors.join('\n'));
});

test('把 /api/admin 加進清單時紅', () => {
	const broken = script.replace(
		'"/|${SLUG} public · landing"',
		'"/api/admin/*|${SLUG} public · admin"\n  "/|${SLUG} public · landing"',
	);
	const errors = publicSurfaceErrors(broken, indexSrc);
	assert.ok(errors.some((e) => e.includes('/api/admin')), errors.join('\n'));
});

test('auth 之前多掛一條沒有 bypass 的路由時紅', () => {
	const broken = indexSrc.replace(
		'app.route("/api/mcq", mcqRoutes);',
		'app.route("/api/mcq", mcqRoutes);\napp.route("/api/extra", extraRoutes);',
	);
	const errors = publicSurfaceErrors(script, broken);
	assert.ok(errors.some((e) => e.includes('/api/extra')), errors.join('\n'));
});
