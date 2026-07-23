import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  timingSafeEqual,
  parseOptions,
  parseCallback,
  buildAnswerKeyboard,
  formatQuestion,
  formatReveal,
  localParts,
  tiptapToText,
  appendExplanation,
  TG_TEXT_LIMIT,
} from './telegram.ts';

const OPTS = '[{"key":"A","text":"甲"},{"key":"B","text":"乙 < 丙"},{"key":"C","text":"丁"},{"key":"D","text":"戊"}]';
const Q = { id: '2024-001', year: 2024, number: 1, stem: '下列何者 & 為真?', options_json: OPTS };

test('escapeHtml 只跳脫 & < >', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(escapeHtml('no special'), 'no special');
});

test('timingSafeEqual 相等/不等/長度不同', () => {
  assert.equal(timingSafeEqual('secret', 'secret'), true);
  assert.equal(timingSafeEqual('secret', 'secreT'), false);
  assert.equal(timingSafeEqual('secret', 'sec'), false);
});

test('parseOptions 正常與壞資料', () => {
  assert.equal(parseOptions(OPTS).length, 4);
  assert.deepEqual(parseOptions('not json'), []);
  assert.deepEqual(parseOptions('{"key":"A"}'), []); // 非陣列
  assert.deepEqual(parseOptions('[{"key":"A"}]'), []); // 缺 text
});

test('parseCallback 解析各前綴', () => {
  assert.deepEqual(parseCallback('ans:2024-001:B'), { kind: 'answer', qid: '2024-001', key: 'B' });
  assert.deepEqual(parseCallback('quiz:year:2024'), { kind: 'quiz-year', year: 2024 });
  assert.deepEqual(parseCallback('quiz:year:114'), { kind: 'quiz-year', year: 114 }); // 民國年 3 位數
  assert.deepEqual(parseCallback('set:year:114'), { kind: 'set-year', year: 114 });
  assert.deepEqual(parseCallback('quiz:count:20'), { kind: 'quiz-count', count: 20 });
  assert.deepEqual(parseCallback('set:sub:0'), { kind: 'set-sub', on: false });
  assert.deepEqual(parseCallback('set:sub:1'), { kind: 'set-sub', on: true });
  assert.deepEqual(parseCallback('set:hour:8'), { kind: 'set-hour', hour: 8 });
  assert.deepEqual(parseCallback('set:year:all'), { kind: 'set-year', year: null });
  assert.deepEqual(parseCallback('set:year:2019'), { kind: 'set-year', year: 2019 });
  assert.deepEqual(parseCallback('nav:quiz'), { kind: 'nav', to: 'quiz' });
  assert.deepEqual(parseCallback('noop'), { kind: 'noop' });
});

test('parseCallback 非法回 null', () => {
  assert.equal(parseCallback(undefined), null);
  assert.equal(parseCallback(''), null);
  assert.equal(parseCallback('ans:'), null);
  assert.equal(parseCallback('quiz:count:0'), null);
  assert.equal(parseCallback('set:hour:99'), null);
  assert.equal(parseCallback('bogus'), null);
});

test('callback_data 皆 ≤ 64 bytes', () => {
  for (const b of buildAnswerKeyboard('2024-001', parseOptions(OPTS)).inline_keyboard.flat()) {
    assert.ok((b.callback_data ?? '').length <= 64);
  }
});

test('buildAnswerKeyboard 單欄、按鈕含完整選項文字', () => {
  const kb = buildAnswerKeyboard('2024-001', parseOptions(OPTS));
  assert.equal(kb.inline_keyboard.length, 4); // 4 選項 → 4 列
  assert.equal(kb.inline_keyboard[0].length, 1); // 每列一顆
  assert.equal(kb.inline_keyboard[0][0].text, '(A) 甲');
  assert.equal(kb.inline_keyboard[1][0].text, '(B) 乙 < 丙'); // 純文字不跳脫
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'ans:2024-001:A');
});

test('formatQuestion 只含題幹、不含選項與正解字樣', () => {
  const txt = formatQuestion(Q, '每日一題');
  assert.match(txt, /2024-001/);
  assert.match(txt, /下列何者 &amp; 為真/);
  assert.doesNotMatch(txt, /乙/); // 選項移到按鈕,文字不再列
  assert.doesNotMatch(txt, /正解/);
});

test('formatReveal 標出對錯與正解', () => {
  const right = formatReveal(Q, 'A', 'A');
  assert.match(right, /答對了/);
  assert.match(right, /✅ <b>A\.<\/b>/);
  const wrong = formatReveal(Q, 'B', 'A');
  assert.match(wrong, /答錯/);
  assert.match(wrong, /正解是 <b>A<\/b>/);
  assert.match(wrong, /❌ <b>B\.<\/b>/);
  assert.match(wrong, /✅ <b>A\.<\/b>/);
});

test('tiptapToText 抽出純文字、清單加項目符號、圖片佔位', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'AML 是 ' }, { type: 'text', text: '急性' }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第二' }] }] },
      ] },
      { type: 'image', attrs: { src: 'x' } },
    ],
  };
  const txt = tiptapToText(doc);
  assert.match(txt, /AML 是 急性/);
  assert.match(txt, /• 第一/);
  assert.match(txt, /• 第二/);
  assert.match(txt, /［圖片］/);
});

test('tiptapToText 壞資料回空字串', () => {
  assert.equal(tiptapToText(null), '');
  assert.equal(tiptapToText('nope'), '');
  assert.equal(tiptapToText({ type: 'doc', content: [] }), '');
});

test('appendExplanation:空詳解回原文、正常接上、跳脫', () => {
  assert.equal(appendExplanation('揭曉', ''), '揭曉');
  assert.equal(appendExplanation('揭曉', '   '), '揭曉');
  const out = appendExplanation('揭曉', 'a < b & c');
  assert.match(out, /📖 詳解/);
  assert.match(out, /a &lt; b &amp; c/);
});

test('appendExplanation:超長詳解截斷且不超過 Telegram 上限', () => {
  const long = 'x'.repeat(5000);
  const out = appendExplanation('揭曉', long);
  assert.ok(out.length <= TG_TEXT_LIMIT);
  assert.match(out, /…/);
  assert.match(out, /點下方看全文/);
});

test('localParts 以偏移平移計算本地時與日期', () => {
  // 2024-01-01 23:30 UTC + 台北(+480) = 2024-01-02 07:30 本地
  const utc = Date.UTC(2024, 0, 1, 23, 30, 0);
  assert.deepEqual(localParts(utc, 480), { hour: 7, dateStr: '2024-01-02' });
  // UTC 本身
  assert.deepEqual(localParts(Date.UTC(2024, 0, 1, 5, 0, 0), 0), { hour: 5, dateStr: '2024-01-01' });
});
