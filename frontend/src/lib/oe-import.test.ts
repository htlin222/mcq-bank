import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withQuestionHeading } from './oe-import.ts';
import { noteTitle } from './noteTitle.ts';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

test('把提問插在最前面當 h3', () => {
  const out = withQuestionHeading(
    { type: 'doc', content: [para('答案內文')] },
    'CML 一線治療如何選擇?',
  );
  assert.deepEqual(out.content?.[0], {
    type: 'heading',
    attrs: { level: 3 },
    content: [{ type: 'text', text: 'CML 一線治療如何選擇?' }],
  });
  assert.equal(out.content?.length, 2);
});

// 標題進了切換器只有一行的位置,OE 的提問卻常常是貼進去的多行文字。
test('換行與多餘空白收成一行', () => {
  const out = withQuestionHeading({ type: 'doc', content: [] }, '  前\n\n 後  ');
  assert.equal((out.content?.[0] as any).content[0].text, '前 後');
});

// TipTap 的 text node 不接受空字串,硬塞會讓整份文件判為無效而被丟掉。
test('提問是空的就原樣回傳', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
  assert.equal(withQuestionHeading(doc, '   '), doc);
});

test('沒有 content 欄位也不會炸', () => {
  const bare: { type?: string; content?: unknown[] } = { type: 'doc' };
  assert.equal(withQuestionHeading(bare, '問題').content?.length, 1);
});

// 這整個函式存在的理由:切換器上的名字取自內文第一行。
test('插進去的標題就是筆記在切換器上的名字', () => {
  const out = withQuestionHeading(
    { type: 'doc', content: [para('Chronic myeloid leukemia is a myeloproliferative…')] },
    'TKI 抗藥性怎麼處理?',
  );
  assert.equal(noteTitle(out), 'TKI 抗藥性怎麼處理?');
});

test('不改動原本的文件', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
  withQuestionHeading(doc, '問題');
  assert.equal(doc.content.length, 1);
});
