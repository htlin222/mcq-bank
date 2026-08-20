// SKILL.md 的 frontmatter 必須是合法 YAML(#166)。
//
// 壞掉的症狀是無聲的:skill 就是不出現在可用清單裡,沒有錯誤訊息、沒有 log,
// 而 SKILL.md 本身讀起來完全正常。實際踩到的是 mcq 的 description 裡有
// `/mcq search: CML` —— YAML 看到「冒號加空白」就把整行當成 mapping。
//
// 這裡不引入 YAML 依賴,只檢查那一個會咬人的規則:未加引號的純量值不得包含
// ": " 或以 ":" 結尾。逐字檢查比裝一個 parser 更貼近失敗的成因。

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILLS = path.join(REPO, '.claude/skills');

function skillFiles() {
  if (!existsSync(SKILLS)) return [];
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(SKILLS, d.name, 'SKILL.md'))
    .filter((p) => existsSync(p));
}

/** frontmatter 的原始行(不含 --- 界線)。沒有 frontmatter 回 null。 */
export function frontmatterLines(text) {
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  return lines.slice(1, end);
}

/** 回傳有問題的 `key` 名稱。未加引號又含 ": " 的值 YAML 會解析失敗。 */
export function unquotedColonKeys(lines) {
  const bad = [];
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    if (!value) continue;
    const quoted =
      (value.startsWith("'") && value.endsWith("'") && value.length > 1) ||
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      value.startsWith('|') ||
      value.startsWith('>');
    if (quoted) continue;
    if (value.includes(': ') || value.endsWith(':')) bad.push(key);
  }
  return bad;
}

test('每個 SKILL.md 都有 frontmatter 且含 name/description', () => {
  const files = skillFiles();
  assert.ok(files.length > 0, '一個 SKILL.md 都沒找到 —— 路徑可能改了,這支測試會變成空掃');
  for (const f of files) {
    const lines = frontmatterLines(readFileSync(f, 'utf8'));
    assert.ok(lines, `${f} 沒有 --- frontmatter`);
    const keys = lines.map((l) => /^([A-Za-z_][\w-]*):/.exec(l)?.[1]).filter(Boolean);
    for (const need of ['name', 'description']) {
      assert.ok(keys.includes(need), `${f} 缺 ${need}`);
    }
  }
});

test('frontmatter 未加引號的值不得含「冒號加空白」', () => {
  for (const f of skillFiles()) {
    const bad = unquotedColonKeys(frontmatterLines(readFileSync(f, 'utf8')) ?? []);
    assert.deepEqual(bad, [], `${f} 的 ${bad.join(', ')} 含 ": " 但沒加引號,YAML 會解析失敗`);
  }
});

// 檢查器自己也要有測試 —— 它是純字串比對,寫反了會變成永遠全綠。
test('unquotedColonKeys 認得出該抓與不該抓的形狀', () => {
  assert.deepEqual(unquotedColonKeys(['description: /mcq search: CML']), ['description']);
  assert.deepEqual(unquotedColonKeys(['description: 結尾冒號:']), ['description']);
  assert.deepEqual(unquotedColonKeys(["description: '/mcq search: CML'"]), []);
  assert.deepEqual(unquotedColonKeys(['description: "a: b"']), []);
  // 冒號後面沒有空白不會觸發 YAML 的 mapping 解析
  assert.deepEqual(unquotedColonKeys(['description: ratio 1:2 的說明']), []);
  // 值本身是空的(區塊寫法在下一行)不該誤判
  assert.deepEqual(unquotedColonKeys(['tools:', '  - Read']), []);
});
