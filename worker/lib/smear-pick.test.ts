import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largestRemainder, pickSmearSet, type PoolItem } from './smear-pick.ts';

const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

test('largestRemainder 加總必定等於 n', () => {
  const q = largestRemainder(50, { a: 0.3, b: 0.22, c: 0.18, d: 0.15, e: 0.06, f: 0.04, g: 0.05 });
  assert.equal(Object.values(q).reduce((s, v) => s + v, 0), 50);
});

test('largestRemainder 在 n 很小時也不掉題', () => {
  const q = largestRemainder(3, { a: 0.5, b: 0.3, c: 0.2 });
  assert.equal(Object.values(q).reduce((s, v) => s + v, 0), 3);
});

const pool = (n: number, topic: string, pre = ''): PoolItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${pre}${topic}-${i}`, topic }));

test('⚠️ 某類題數不足時,缺額要回填給其他類 —— 不准靜默少題', () => {
  const p = [...pool(50, 'myeloid'), ...pool(2, 'infection')];
  const got = pickSmearSet(p, 20, { myeloid: 0.5, infection: 0.5 }, new Set(), seq([0.5]));
  assert.equal(got.length, 20);                       // 不是 12
  assert.equal(got.filter((id) => id.startsWith('infection')).length, 2);
});

test('題庫比 n 小的時候,回傳全部而不是重複', () => {
  const p = pool(7, 'rbc');
  const got = pickSmearSet(p, 20, { rbc: 1 }, new Set(), seq([0.5]));
  assert.equal(got.length, 7);
  assert.equal(new Set(got).size, 7);
});

test('⚠️ 避開上一場考過的題', () => {
  const p = pool(20, 'rbc');
  const exclude = new Set(p.slice(0, 10).map((x) => x.id));
  const got = pickSmearSet(p, 10, { rbc: 1 }, exclude, seq([0.5]));
  assert.equal(got.filter((id) => exclude.has(id)).length, 0);
});

test('排除項不夠時仍然湊滿,不是少給', () => {
  const p = pool(12, 'rbc');
  const exclude = new Set(p.slice(0, 10).map((x) => x.id));
  const got = pickSmearSet(p, 10, { rbc: 1 }, exclude, seq([0.5]));
  assert.equal(got.length, 10);
  assert.equal(new Set(got).size, 10);
});

test('不重複', () => {
  const p = [...pool(40, 'myeloid'), ...pool(40, 'lymphoid')];
  const got = pickSmearSet(p, 50, { myeloid: 0.5, lymphoid: 0.5 }, new Set(), seq([0.1, 0.9, 0.4]));
  assert.equal(new Set(got).size, 50);
});
