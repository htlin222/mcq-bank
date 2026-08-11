import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_TITLE_MAX, NOTE_TITLE_NARROW, noteTitle, noteTitleFromJson } from './noteTitle.ts';

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

// ── 窄螢幕的上限(#137)────────────────────────────────────────
//
// 回報是「選擇筆記的下拉在 mobile 會 overflow」。CSS `truncate` 其實不會讓它
// 真的溢出容器,但 40 個中文字會把整列吃光,底下那行日期就分不出層次 ——
// 縮到 10 字之後兩者各自看得出來。

test('maxLen 可以覆寫,超過就截斷加省略號', () => {
  const long = '一二三四五六七八九十';
  assert.equal(noteTitle(doc(para(long)), undefined, 5), '一二三四五…');
});

test('剛好等於上限時不加省略號 —— 邊界是「大於」才截', () => {
  assert.equal(noteTitle(doc(para('一二三四五')), undefined, 5), '一二三四五');
});

test('窄螢幕的上限是 10,而且明顯小於一般上限', () => {
  // 不寫成「剛好一半」之類的比例關係 —— 兩者回答的是不同問題:NOTE_TITLE_MAX 是
  // 「標題最長多少」,NOTE_TITLE_NARROW 是「一眼認得出是哪一則要幾個字」。
  // 綁成比例的話,調其中一個會莫名其妙牽動另一個。
  assert.equal(NOTE_TITLE_NARROW, 10);
  assert.ok(NOTE_TITLE_NARROW < NOTE_TITLE_MAX);
});

test('noteTitleFromJson 也吃得到 maxLen —— 元件用的是這一支', () => {
  const json = JSON.stringify(doc(para('一二三四五六七八九十')));
  assert.equal(noteTitleFromJson(json, undefined, 4), '一二三四…');
});

test('沒給 maxLen 時維持原本的 40', () => {
  const long = 'あ'.repeat(50);
  assert.equal(noteTitleFromJson(JSON.stringify(doc(para(long)))).length, 41); // 40 + 省略號
});
