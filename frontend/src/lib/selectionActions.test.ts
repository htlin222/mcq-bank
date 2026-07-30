import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionActions, hasMeaningfulContent } from './selectionActions.ts';

const TG = { onQuestionPage: false, telegramLinked: false };
const IN = { inAnnotatable: true, cloze: false, ...TG };
const OUT = { inAnnotatable: false, cloze: false, ...TG };

// 統一工具列之前,「螢光標記」的門檻是 1 字,「查參考資料」是 3 字。合併時若
// 沿用 3,就等於偷偷砍掉中文兩字詞的畫記能力 —— 這組測試釘住的就是那件事。
test('兩字中文詞可以畫記,但不查參考資料', () => {
  const a = selectionActions({ text: '貧血', ...IN });
  assert.equal(a.highlight, true);
  assert.equal(a.lookup, false);
});

test('一個字也能畫記', () => {
  assert.equal(selectionActions({ text: '癌', ...IN }).highlight, true);
});

test('三字以上的實詞才亮查參考資料', () => {
  assert.equal(selectionActions({ text: '溶血性貧血', ...IN }).lookup, true);
  assert.equal(selectionActions({ text: 'CD20', ...IN }).lookup, true);
});

test('不在 AnnotatableContent 內就沒有螢光標記', () => {
  const a = selectionActions({ text: '溶血性貧血', ...OUT });
  assert.equal(a.highlight, false);
  assert.equal(a.lookup, true);
});

test('防劇透模式中不開放畫記', () => {
  const a = selectionActions({ text: '溶血性貧血', inAnnotatable: true, cloze: true, ...TG });
  assert.equal(a.highlight, false);
  assert.equal(a.lookup, true);
});

// AI 永遠可按 —— 沒設金鑰時由工具列引導去設定,而不是把按鈕藏起來讓使用者
// 永遠不知道有這個功能。
test('AI 在任何有內容的選取上都可按', () => {
  assert.equal(selectionActions({ text: '癌', ...OUT }).ai, true);
  assert.equal(selectionActions({ text: '溶血性貧血', ...IN }).ai, true);
});

// 「存到 Telegram」的訊息帶「$year 第 $q 題 + 連結」,兩個條件缺一不可:沒綁
// 定按了必定失敗(綁定流程在個人頁,浮動工具列引導不了),不在題目頁則湊不出
// 出處。
test('存到 Telegram 要同時已綁定且在題目頁', () => {
  const base = { text: '溶血性貧血', inAnnotatable: true, cloze: false };
  assert.equal(
    selectionActions({ ...base, telegramLinked: true, onQuestionPage: true }).telegram,
    true,
  );
  assert.equal(
    selectionActions({ ...base, telegramLinked: false, onQuestionPage: true }).telegram,
    false,
  );
  assert.equal(
    selectionActions({ ...base, telegramLinked: true, onQuestionPage: false }).telegram,
    false,
  );
});

test('空白選取所有動作全滅', () => {
  const a = selectionActions({ text: '   ', ...IN, telegramLinked: true, onQuestionPage: true });
  assert.deepEqual(a, { highlight: false, lookup: false, ai: false, telegram: false });
});

test('純標點/純數字不算實詞,查不了參考資料', () => {
  assert.equal(hasMeaningfulContent('……'), false);
  assert.equal(hasMeaningfulContent('2023'), false);
  assert.equal(hasMeaningfulContent('a'), false); // 單一拉丁字母不夠
  assert.equal(hasMeaningfulContent('AML'), true);
  assert.equal(hasMeaningfulContent('血'), true);
});
