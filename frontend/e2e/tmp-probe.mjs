// 完整流程診斷:作答 → 等 61 秒 → 上一題 → 下一題,每個階段印出 apiHits 差異。
// 要回答的是「TTL 過期後那條重抓路徑到底會不會被走到」。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');

const server = await startServer({ dist: DIST, apiDelayMs: 0 });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await ctx.route('**/*', (r) => (r.request().url().startsWith(server.origin) ? r.continue() : r.abort()));

const payloadHits = () => server.apiHits().filter((p) => p === '/api/questions/113-050').length;
const stage = (label, prev) => {
  const n = payloadHits();
  console.log(`  ${label}: /api/questions/113-050 累計 ${n} 次 (本階段 +${n - prev})`);
  return n;
};

await page.goto(server.origin + '/q/113-050', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
let n = stage('載入完成', 0);

await page.getByText('先生為亞孟買血型').first().click();
await page.getByRole('button', { name: '提交答案' }).click();
await page.getByText('答對了').first().waitFor({ timeout: 20000 });
n = stage('作答完成', n);

console.log('  等 61 秒讓 TTL 過期…');
await page.waitForTimeout(61000);
n = stage('等待結束', n);

await page.getByRole('button', { name: /上一題/ }).click();
await page.getByText('immunophenotyping').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(3000); // 給閒置預抓時間
n = stage('到 113-049 並閒置 3 秒', n);

await page.getByRole('button', { name: /下一題/ }).click();
await page.getByText('孟買血型').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(5000);
n = stage('回到 113-050', n);

const text = await page.evaluate(() => document.body.innerText);
console.log('\n  畫面上還有作答紀錄嗎?');
console.log('    「答對了」  ' + (text.includes('答對了') ? '在' : '不見了'));
console.log('    「你的選擇」' + (text.includes('你的選擇') ? '在' : '不見了'));

await browser.close();
await server.close();
