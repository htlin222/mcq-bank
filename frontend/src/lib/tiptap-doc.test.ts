import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTiptapDoc } from './tiptap-doc.ts';

// 這份文件的形狀取自 114-057 的實際詳解 —— 就是它讓整篇渲染成空白。
const SNAKE_DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '重點' }] },
    {
      type: 'bullet_list',
      content: [
        {
          type: 'list_item',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
        },
      ],
    },
  ],
};

test('renames legacy snake_case nodes at every depth', () => {
  const out = normalizeTiptapDoc(SNAKE_DOC) as any;
  assert.equal(out.content[1].type, 'bulletList');
  assert.equal(out.content[1].content[0].type, 'listItem');
  // 巢狀的段落/文字不受影響
  assert.equal(out.content[1].content[0].content[0].content[0].text, 'A');
});

test('leaves attrs and marks untouched', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'bullet_list',
        attrs: { tight: true },
        content: [
          {
            type: 'list_item',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const out = normalizeTiptapDoc(doc) as any;
  assert.deepEqual(out.content[0].attrs, { tight: true });
  assert.deepEqual(out.content[0].content[0].content[0].content[0].marks, [{ type: 'bold' }]);
});

// 身分不變是硬性要求,不是最佳化:呼叫端用這個值當 effect 依賴與內容 hash,
// 每次 render 換新物件會讓編輯器不斷重設自己的文件 (見 f9da4f1)。
test('returns the very same object when nothing needs renaming', () => {
  const clean = {
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
        ],
      },
    ],
  };
  assert.equal(normalizeTiptapDoc(clean), clean);
});

test('survives null / empty / malformed input', () => {
  assert.equal(normalizeTiptapDoc(null), null);
  assert.equal(normalizeTiptapDoc(undefined), undefined);
  const empty = { type: 'doc', content: [] };
  assert.equal(normalizeTiptapDoc(empty), empty);
  const odd = { type: 'doc', content: [null, 'x', 42] } as any;
  assert.equal(normalizeTiptapDoc(odd), odd);
});

test('rewrites the other aliases the exporter already accepts', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'ordered_list', content: [{ type: 'list_item', content: [] }] },
      { type: 'horizontal_rule' },
      { type: 'code_block', content: [{ type: 'text', text: 'x' }] },
      { type: 'hard_break' },
    ],
  };
  const out = normalizeTiptapDoc(doc) as any;
  assert.deepEqual(
    out.content.map((n: any) => n.type),
    ['orderedList', 'horizontalRule', 'codeBlock', 'hardBreak'],
  );
  assert.equal(out.content[0].content[0].type, 'listItem');
});
