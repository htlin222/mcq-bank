// 模擬考送不出去的答案要留在畫面上,重整之後補送,而且沿用同一把 idem。
// 還沒送達的題,題號與題號格都寫「未同步」;補送成功後字消失,伺服器的
// chosen 與畫面一致。教學模式在那筆離開佇列之前不能揭曉。
//
//   node --test --test-concurrency=1 frontend/e2e/exam-answer-outbox.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const REQUIRE = process.env.E2E_REQUIRE === '1';
const SID = 'e2e-1';
const STATE = JSON.parse(
	fs.readFileSync(path.join(HERE, 'fixtures', `exam_${SID}_state.json`), 'utf8'),
);
const OUTBOX = 'mcq:exam-answer-outbox:v1';

let browser;
let server;
let skipReason = null;

before(async () => {
	if (!fs.existsSync(path.join(DIST, 'index.html'))) {
		skipReason = `找不到 ${DIST}/index.html —— 先跑 pnpm --dir frontend build`;
		return;
	}
	let webkit;
	try {
		({ webkit } = await import('playwright'));
	} catch {
		skipReason = '沒有 playwright';
		return;
	}
	try {
		browser = await webkit.launch();
	} catch (e) {
		skipReason = `WebKit 起不來:${e.message.split('\n')[0]}`;
		return;
	}
	server = await startServer({ dist: DIST });
});

after(async () => {
	if (server) await server.close();
	if (browser) await browser.close();
});

function skipped(t) {
	if (!skipReason) return false;
	if (REQUIRE) assert.fail(`E2E_REQUIRE=1 但無法執行:${skipReason}`);
	t.skip(skipReason);
	return true;
}

/** @param {import('playwright').BrowserContext} ctx */
async function installExamRoutes(ctx, { tutor, blockRef, keys, saved }) {
	await ctx.route('**/api/exam/**', async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) =>
			route.fulfill({
				status,
				contentType: 'application/json; charset=utf-8',
				body: JSON.stringify(body),
			});
		if (p.endsWith('/state') && req.method() === 'GET') {
			return json({
				...STATE,
				tutor,
				running_since: Date.now(),
				questions: STATE.questions.map((q) => ({
					...q,
					chosen: saved.get(q.id) ?? q.chosen,
				})),
			});
		}
		if (p.endsWith('/answer') && req.method() === 'POST') {
			const key = req.headers()['idempotency-key'] ?? '';
			keys.push(key);
			const body = JSON.parse(req.postData() || '{}');
			if (blockRef.block) return json({ error: 'offline' }, 500);
			if (body.question_id && body.chosen) saved.set(body.question_id, body.chosen);
			return json({ ok: true });
		}
		return route.continue();
	});
}

async function queued(page) {
	return page.evaluate((key) => {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : [];
	}, OUTBOX);
}

test('POST 失敗後重整,選項還在,補送沿用同一把鍵', async (t) => {
	if (skipped(t)) return;
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		serviceWorkers: 'block',
	});
	const page = await ctx.newPage();
	const keys = [];
	const saved = new Map();
	const blockRef = { block: true };
	await installExamRoutes(ctx, { tutor: 0, blockRef, keys, saved });
	try {
		await page.goto(server.origin + `/exam/${SID}`, {
			waitUntil: 'domcontentloaded',
			timeout: 30_000,
		});
		await page.getByText('第 1 題').first().waitFor({ timeout: 20_000 });
		await page.locator('li', { hasText: '選項乙' }).click();
		await page.waitForFunction(
			(key) => {
				const raw = localStorage.getItem(key);
				return raw ? JSON.parse(raw).length === 1 : false;
			},
			OUTBOX,
			{ timeout: 5_000 },
		);
		// debounce 400ms 之後的 POST 要真的失敗過,否則下面只是在驗「還沒送」。
		await page.waitForTimeout(800);
		assert.ok(keys.length >= 1, '沒有送出 /answer');
		const idem = keys[0];
		assert.ok(idem, 'POST 沒有帶 Idempotency-Key');
		const before = await queued(page);
		assert.equal(before.length, 1);
		assert.equal(before[0].idem, idem);
		assert.equal(before[0].chosen, 'B');
		assert.match(await page.locator('li.border-accent').innerText(), /選項乙/);
		await page.getByText('未同步').first().waitFor({ timeout: 5_000 });
		const details = page.locator('details').first();
		await details.locator('summary').click();
		const cell = details.locator('button', { hasText: '未同步' });
		await cell.waitFor({ timeout: 5_000 });
		assert.match(await cell.innerText(), /未同步/);
		assert.match(await cell.innerText(), /^1/);

		await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
		// 佇列裡的第 1 題算答過,續考會落到下一題未作答。
		await page.getByText('第 2 題').first().waitFor({ timeout: 20_000 });
		await page.getByRole('button', { name: '上一題' }).click();
		await page.getByText('第 1 題').first().waitFor({ timeout: 10_000 });
		await page.getByText('未同步').first().waitFor({ timeout: 5_000 });
		assert.match(await page.locator('li.border-accent').innerText(), /選項乙/);
		const mid = await queued(page);
		assert.equal(mid.length, 1);
		assert.equal(mid[0].idem, idem);

		blockRef.block = false;
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await page.waitForFunction(
			(key) => {
				const raw = localStorage.getItem(key);
				return !raw || JSON.parse(raw).length === 0;
			},
			OUTBOX,
			{ timeout: 10_000 },
		);
		assert.ok(keys.every((k) => k === idem), `補送換了鍵:${keys.join(',')}`);
		assert.equal(saved.get('113-001'), 'B');
		assert.match(await page.locator('li.border-accent').innerText(), /選項乙/);
		assert.equal(await page.getByText('未同步').count(), 0);
	} finally {
		await ctx.close();
	}
});

test('教學模式在伺服器確認前不揭曉', async (t) => {
	if (skipped(t)) return;
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		serviceWorkers: 'block',
	});
	const page = await ctx.newPage();
	const keys = [];
	const saved = new Map();
	const blockRef = { block: true };
	let questionHits = 0;
	await ctx.route('**/api/questions/113-001**', async (route) => {
		questionHits++;
		return route.continue();
	});
	await installExamRoutes(ctx, { tutor: 1, blockRef, keys, saved });
	try {
		await page.goto(server.origin + `/exam/${SID}`, {
			waitUntil: 'domcontentloaded',
			timeout: 30_000,
		});
		await page.getByText('第 1 題').first().waitFor({ timeout: 20_000 });
		await page.locator('li', { hasText: '選項乙' }).click();
		await page.waitForFunction(
			(key) => {
				const raw = localStorage.getItem(key);
				return raw ? JSON.parse(raw).length === 1 : false;
			},
			OUTBOX,
			{ timeout: 5_000 },
		);
		await page.waitForTimeout(600);
		assert.ok((await page.getByText('未同步').count()) > 0);
		assert.equal(await page.getByText('答錯了').count(), 0);
		assert.equal(await page.getByText('答對了').count(), 0);
		assert.equal(await page.getByText('載入答案與詳解').count(), 0);
		assert.equal(questionHits, 0, '確認前就去抓了含正解的題目');
		assert.match(await page.locator('li.border-accent').innerText(), /選項乙/);
		const idem = (await queued(page))[0].idem;

		blockRef.block = false;
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await page.getByText('答錯了').waitFor({ timeout: 10_000 });
		assert.equal(await page.getByText('未同步').count(), 0);
		assert.equal(saved.get('113-001'), 'B');
		assert.ok(questionHits > 0);
		assert.equal((await queued(page)).length, 0);
		assert.ok(keys.length >= 2);
		assert.ok(keys.every((k) => k === idem));
	} finally {
		await ctx.close();
	}
});
