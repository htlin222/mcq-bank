import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteTitle, noteTitleFromJson } from './noteTitle.ts';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h2 = (text: string) => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
});

test('取第一行文字當名字', () => {
  assert.equal(noteTitle(doc(h2('鐵過載'), para('後面的內文'))), '鐵過載');
});

// 編輯器新開一則筆記時第一個節點常常是空段落 —— 名字要從真正有字的那行來,
// 不然整份筆記會叫「未命名」直到使用者剛好把游標放在第一行。
test('跳過開頭的空段落', () => {
  assert.equal(noteTitle(doc({ type: 'paragraph' }, para('  '), para('β-地中海貧血'))), 'β-地中海貧血');
});

test('空筆記回 fallback', () => {
  assert.equal(noteTitle(doc({ type: 'paragraph' })), '未命名筆記');
  assert.equal(noteTitle(doc(), 'AI 筆記'), 'AI 筆記');
  assert.equal(noteTitle(null), '未命名筆記');
});

test('過長的第一行截斷', () => {
  const long = 'あ'.repeat(80);
  const t = noteTitle(doc(para(long)));
  assert.ok(t.length <= 41, `長度 ${t.length}`);
  assert.ok(t.endsWith('…'));
});

test('多行空白壓成一格', () => {
  assert.equal(noteTitle(doc(para('AML   與\tAPL'))), 'AML 與 APL');
});

test('清單/表格裡的第一格也算數', () => {
  const list = {
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [para('第一點')] },
      { type: 'listItem', content: [para('第二點')] },
    ],
  };
  assert.equal(noteTitle(doc(list)), '第一點');
});

test('只有圖片的筆記給得出名字', () => {
  assert.equal(noteTitle(doc({ type: 'image', attrs: { src: '/img/x' } })), '［圖片］');
});

test('壞掉的 JSON 不丟例外', () => {
  assert.equal(noteTitleFromJson('{{{'), '未命名筆記');
  assert.equal(noteTitleFromJson(undefined), '未命名筆記');
  assert.equal(noteTitleFromJson(JSON.stringify(doc(para('好的 JSON')))), '好的 JSON');
});
