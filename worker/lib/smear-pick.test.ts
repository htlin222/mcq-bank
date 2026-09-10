import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largestRemainder, pickSmearSet, pickUnseenFirst, type PoolItem } from './smear-pick.ts';

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

// ---------------------------------------------------------------------------
// pickUnseenFirst —— 「同一診斷多種版本」的整個實作,四個邊界
// ---------------------------------------------------------------------------

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const items = (...xs: string[]) => xs.map((id) => ({ id }));

test('pickUnseenFirst:沒看過的排在看過的前面', () => {
  const got = pickUnseenFirst(items('a', 'b', 'c', 'd'), new Set(['a', 'c']), () => 0);
  // 前兩個必定來自 unseen(b, d),後兩個必定來自 seen(a, c)
  assert.deepEqual(new Set(ids(got).slice(0, 2)), new Set(['b', 'd']));
  assert.deepEqual(new Set(ids(got).slice(2)), new Set(['a', 'c']));
});

test('pickUnseenFirst:一張都沒看過 = 純洗牌,不會少人也不會多人', () => {
  const got = pickUnseenFirst(items('a', 'b', 'c'), new Set(), seq([0.1, 0.9]));
  assert.deepEqual(new Set(ids(got)), new Set(['a', 'b', 'c']));
});

test('pickUnseenFirst:全部看過就回頭全給,不是回空陣列', () => {
  // 這條是承重的:回空的話,那個病從此不會再出現,而使用者只會覺得題庫壞了。
  const got = pickUnseenFirst(items('a', 'b', 'c'), new Set(['a', 'b', 'c']), () => 0);
  assert.deepEqual(new Set(ids(got)), new Set(['a', 'b', 'c']));
});

test('pickUnseenFirst:剛好剩一張沒看過,那張一定排第一', () => {
  const got = pickUnseenFirst(items('a', 'b', 'c', 'd'), new Set(['a', 'b', 'd']), seq([0.7, 0.2]));
  assert.equal(ids(got)[0], 'c');
});

test('pickSmearSet:seen 只排序,不改變總數與配額', () => {
  // 對照組 —— 同一組輸入,只差有沒有 seen。長度與主題分布都不准變。
  const p = [...pool(20, 'myeloid'), ...pool(20, 'lymphoid')];
  const w = { myeloid: 0.5, lymphoid: 0.5 };
  const a = pickSmearSet(p, 10, w, new Set(), seq([0.1, 0.6, 0.3]));
  const b = pickSmearSet(p, 10, w, new Set(), seq([0.1, 0.6, 0.3]), new Set(p.slice(0, 30).map((x) => x.id)));
  assert.equal(a.length, 10);
  assert.equal(b.length, 10);
  assert.equal(new Set(b).size, 10);
  const topicOf = new Map(p.map((x) => [x.id, x.topic]));
  const count = (got: string[], t: string) => got.filter((id) => topicOf.get(id) === t).length;
  assert.equal(count(a, 'myeloid'), count(b, 'myeloid'));
});

test('pickSmearSet:同一個 dx 的四張圖,看過兩張後優先給另外兩張', () => {
  // 這就是學長那句話在程式裡的樣子。
  const four: PoolItem[] = ['apl-1', 'apl-2', 'apl-3', 'apl-4'].map((id) => ({ id, topic: 'myeloid' }));
  const got = pickSmearSet(four, 2, { myeloid: 1 }, new Set(), () => 0, new Set(['apl-1', 'apl-2']));
  assert.deepEqual(new Set(got), new Set(['apl-3', 'apl-4']));
});
