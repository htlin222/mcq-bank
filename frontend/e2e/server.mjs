// 給冒煙測試用的靜態伺服器 + API 樁。
//
// 刻意不接真的 Worker:要抓的是「頁面在 WebKit 上渲染會不會炸」,那跟資料
// 是不是最新的無關。接 wrangler dev 會把測試綁上 D1 狀態、Cloudflare 憑證
// 與遷移進度 —— CI 跑不動,而且失敗原因會變得模稜兩可。
//
// fixtures/ 底下是從真實 API 抓下來的回應(檔名把 / 換成 _),形狀不會失真。
// 沒有 fixture 的端點回一個空物件並記錄下來,測試結束時列出 —— 想擴充涵蓋
// 範圍時就知道還缺哪幾份。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// 1×1 透明 PNG —— /img/* 的縮圖代理在測試裡只要「不是 404」就夠了
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export function startServer({ dist, port = 0 }) {
  const missing = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p.startsWith('/img/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PIXEL);
    }

    if (p.startsWith('/api/')) {
      const name = p.slice('/api/'.length).replace(/\/$/, '').replace(/\//g, '_');
      const file = path.join(FIXTURES, `${name}.json`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (fs.existsSync(file)) return res.end(fs.readFileSync(file));
      missing.add(p);
      return res.end('{}');
    }

    // SPA:任何非資產路徑都回 index.html
    let file = path.join(dist, p === '/' ? 'index.html' : p);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(dist, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        missingFixtures: () => [...missing].sort(),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
