import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWranglerJson, d1Rows } from './wrangler-json.mjs';

// 這支測試存在的理由是一次真實的失敗:wrangler 4.90 開始會在 --json 的輸出
// 前面印一行 "Cloudflare agent skills are available for: …",而 pnpm db:pull
// 直接 JSON.parse 整段 stdout,於是掛在
//
//   SyntaxError: Unexpected token 'C', "Cloudflare"... is not valid JSON
//
// —— 一個跟真正問題毫無關係的錯誤訊息。雜訊的種類還會再變,所以這裡釘住的
// 是「無論前面夾了什麼,只要 JSON 還在就要讀得到」。

const NOISE =
  'Cloudflare agent skills are available for: Claude Code, Cursor, OpenCode.\n' +
  'Run wrangler in an interactive terminal to install them.\n';

const D1_OUT = `[
  {
    "results": [{ "name": "questions" }, { "name": "users" }],
    "success": true
  }
]`;

test('乾淨的 JSON 照常解析', () => {
  assert.deepEqual(parseWranglerJson('[1, 2, 3]'), [1, 2, 3]);
  assert.deepEqual(parseWranglerJson('{"a": 1}'), { a: 1 });
});

test('剝掉 JSON 前面的推銷文案', () => {
  assert.deepEqual(d1Rows(NOISE + D1_OUT), [
    { name: 'questions' },
    { name: 'users' },
  ]);
});

test('剝掉版本更新提示這類多行雜訊', () => {
  const noise =
    '\n ⛅️ wrangler 4.90.0 (update available 4.119.0)\n' +
    '──────────────────────────────────────────────\n';
  assert.deepEqual(d1Rows(noise + D1_OUT).length, 2);
});

test('雜訊裡出現方括號時,仍從行首的 JSON 切起', () => {
  // 字元級的 indexOf('[') 會被這行騙走,切在錯的地方。
  const noise = 'See docs [here] for details about --json output.\n';
  assert.deepEqual(d1Rows(noise + D1_OUT).length, 2);
});

test('前導空白不影響判斷', () => {
  assert.deepEqual(parseWranglerJson('   [1]'), [1]);
});

test('查無資料回空陣列', () => {
  assert.deepEqual(d1Rows(NOISE + '[{"results": [], "success": true}]'), []);
});

test('完全沒有 JSON 時要拋,而且訊息帶上原始輸出', () => {
  assert.throws(
    () => parseWranglerJson('Error: not logged in\n', 'db-pull'),
    (err) => {
      assert.match(err.message, /db-pull/);
      assert.match(err.message, /not logged in/);
      return true;
    },
  );
});

test('壞掉的 JSON 要拋,而不是回 undefined', () => {
  assert.throws(() => parseWranglerJson('[{"a": '), /JSON 解析失敗/);
});

test('「wrangler 壞了」不能被偽裝成「資料庫是空的」', () => {
  // 這是 curate-videos.py 原本的行為:找不到 JSON 就 return []。
  // 呼叫端看到空清單,會以為遠端沒有資料,而不是知道查詢根本沒跑成功。
  assert.throws(() => d1Rows('wrangler: command not found\n'));
});

test('JSON 形狀不是 d1 的樣子時,d1Rows 回空陣列而不是爆掉', () => {
  // parseWranglerJson 成功、但形狀不合(例如換了個子命令)——這種情況
  // 拋不拋都說得通,這裡選擇容忍,因為 JSON 本身是好的。
  assert.deepEqual(d1Rows('{"ok": true}'), []);
});
