import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFilters, sessionTitle } from './customTestLabel.ts';

test('sessionTitle:年度考顯示年份,自訂測驗不顯示 year=0 哨兵', () => {
  assert.equal(sessionTitle({ year: 114 }), '114');
  assert.equal(sessionTitle({ year: 114, kind: 'year' }), '114');
  assert.equal(sessionTitle({ year: 0, kind: 'custom' }), '自訂測驗');
});

test('describeFilters:狀態翻成中文,年份/科別/tag/題數依序串接', () => {
  assert.equal(
    describeFilters(
      JSON.stringify({ status: ['unseen', 'wrong'], years: [114, 113], groups: ['內科'], tags: ['AML'], count: 20 }),
    ),
    '未做過/做錯過 · 114,113 · 內科 · #AML · 20 題',
  );
});

test('describeFilters:壞掉 / 缺失的 filter_json 回 null,不拋例外', () => {
  assert.equal(describeFilters(null), null);
  assert.equal(describeFilters(undefined), null);
  assert.equal(describeFilters('not json'), null);
  assert.equal(describeFilters('null'), null);
});

test('describeFilters:全空條件(不限)回 null', () => {
  assert.equal(describeFilters(JSON.stringify({ status: [], years: [], groups: [], tags: [] })), null);
});

test('describeFilters:未知狀態值原樣顯示', () => {
  assert.equal(describeFilters(JSON.stringify({ status: ['bogus'] })), 'bogus');
});
