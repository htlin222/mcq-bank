import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt, BUILTIN_PROMPTS } from './aiPrompts.ts';

test('renderPrompt 替換 {{selection}}', () => {
  assert.equal(renderPrompt('解釋:{{selection}}', { selection: '貧血' }), '解釋:貧血');
});

test('renderPrompt 替換 {{context}}', () => {
  assert.equal(
    renderPrompt('段落:{{context}}|重點:{{selection}}', {
      selection: '貧血',
      context: '病人有貧血與黃疸。',
    }),
    '段落:病人有貧血與黃疸。|重點:貧血',
  );
});

test('renderPrompt 容許變數內有空白', () => {
  assert.equal(renderPrompt('{{ selection }}', { selection: 'AML' }), 'AML');
});

test('renderPrompt 多次出現的變數全部替換', () => {
  assert.equal(
    renderPrompt('{{selection}} 與 {{selection}}', { selection: 'CML' }),
    'CML 與 CML',
  );
});

// 這條是整個設計的重點:使用者很容易寫了一段指示卻忘記插變數,那樣模型會
// 收到一句沒有受詞的空話。
test('renderPrompt 完全沒寫變數時,把選取文字附在結尾', () => {
  assert.equal(renderPrompt('請用一句話解釋', { selection: '溶血' }), '請用一句話解釋\n\n溶血');
});

test('renderPrompt 只寫了 {{context}} 也算有變數,不再重複附加', () => {
  assert.equal(
    renderPrompt('摘要:{{context}}', { selection: '溶血', context: '這一段在講溶血性貧血。' }),
    '摘要:這一段在講溶血性貧血。',
  );
});

test('renderPrompt context 缺席時降級成 selection,不留下空洞', () => {
  assert.equal(renderPrompt('脈絡:{{context}}', { selection: 'ITP' }), '脈絡:ITP');
});

test('renderPrompt context 只有空白時同樣降級', () => {
  assert.equal(
    renderPrompt('脈絡:{{context}}', { selection: 'ITP', context: '   ' }),
    '脈絡:ITP',
  );
});

// 正規表示式帶 g flag,test() 會推進 lastIndex —— 沒歸零的話第二次呼叫就會
// 誤判成「沒有變數」而多附一份選取文字。
test('renderPrompt 連續呼叫結果一致(g flag 的 lastIndex 不殘留)', () => {
  const body = '解釋 {{selection}}';
  assert.equal(renderPrompt(body, { selection: 'a' }), '解釋 a');
  assert.equal(renderPrompt(body, { selection: 'b' }), '解釋 b');
  assert.equal(renderPrompt(body, { selection: 'c' }), '解釋 c');
});

test('四則內建預設都帶 selection 變數,id 唯一', () => {
  assert.equal(BUILTIN_PROMPTS.length, 4);
  assert.equal(new Set(BUILTIN_PROMPTS.map((p) => p.id)).size, 4);
  for (const p of BUILTIN_PROMPTS) {
    assert.equal(p.builtin, true);
    assert.ok(p.id.startsWith('builtin:'));
    assert.ok(p.body.includes('{{selection}}'));
  }
});
