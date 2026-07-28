import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, maskKey } from './groq.ts';

// 網路 chunk 的切點是任意的:`data: {…}` 很可能被攔腰切成兩半。解析器必須自己
// 保留 buffer,不能假設一個 chunk 就是一則完整事件 —— 這組測試就是在釘住這件事。

function delta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

test('SSE 解出單一 chunk 裡的增量', () => {
  const parse = createSseParser();
  assert.deepEqual(parse(delta('嗨')), ['嗨']);
});

test('SSE 一個 chunk 內多則事件', () => {
  const parse = createSseParser();
  assert.deepEqual(parse(delta('a') + delta('b') + delta('c')), ['a', 'b', 'c']);
});

test('SSE 事件被切成兩半時,跨 chunk 接回來', () => {
  const parse = createSseParser();
  const full = delta('溶血');
  const cut = Math.floor(full.length / 2);
  assert.deepEqual(parse(full.slice(0, cut)), []);
  assert.deepEqual(parse(full.slice(cut)), ['溶血']);
});

test('SSE 逐字元餵入也能還原完整內容', () => {
  const parse = createSseParser();
  const stream = delta('AML') + delta(' 是') + delta('急性');
  const out: string[] = [];
  for (const ch of stream) out.push(...parse(ch));
  assert.equal(out.join(''), 'AML 是急性');
});

test('SSE 跳過 keep-alive 空行與註解行', () => {
  const parse = createSseParser();
  assert.deepEqual(parse(`\n\n: ping\n\n${delta('x')}`), ['x']);
});

test('SSE [DONE] 之後不再產出', () => {
  const parse = createSseParser();
  assert.deepEqual(parse(`${delta('尾')}data: [DONE]\n\n`), ['尾']);
  assert.deepEqual(parse(delta('不該出現')), []);
});

test('SSE 畸形 JSON 只丟掉那一則,不弄死整段串流', () => {
  const parse = createSseParser();
  assert.deepEqual(parse(`data: {壞掉的\n\n${delta('好的')}`), ['好的']);
});

test('SSE 沒有 content 的 delta 不產出空字串', () => {
  const parse = createSseParser();
  const roleOnly = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`;
  assert.deepEqual(parse(roleOnly + delta('內文')), ['內文']);
});

test('SSE 非 data: 開頭的行(event:/id:)忽略', () => {
  const parse = createSseParser();
  assert.deepEqual(parse(`event: message\nid: 1\n${delta('y')}`), ['y']);
});

test('maskKey 保留頭尾,中間遮掉', () => {
  const masked = maskKey('gsk_abcdefghijklmnop1234');
  assert.ok(masked.startsWith('gsk_abc'));
  assert.ok(masked.endsWith('1234'));
  assert.ok(masked.includes('•'));
  assert.ok(!masked.includes('defghijklmnop'));
});

test('maskKey 過短的金鑰整串遮掉', () => {
  assert.equal(maskKey('gsk_123'), '•••••••');
});
