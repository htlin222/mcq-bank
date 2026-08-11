// 拖曳重排的落點計算(#140)。
//
// 這一段做成純函式,是因為難的不是「拖了就換位置」而是**邊界**:往下拖時的門檻
// 在哪、拖出清單外算第幾項、放回原位算不算改動。在瀏覽器裡要模擬指標事件才試得
// 出來,而那種測試會隨時序飄(CLAUDE.md 裡「作答紀錄被閒置預抓蓋掉」那節的教訓)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropIndex, moveItem, sameOrder } from './reorder.ts';

test('往後搬', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
});

test('往前搬', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
});

test('搬到原位等於什麼都沒做', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
});

test('越界的索引夾回範圍 —— 拖出清單外不該少一項', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -5), ['c', 'a', 'b']);
});

test('空陣列不炸', () => {
  assert.deepEqual(moveItem([], 0, 1), []);
});

// ── 落點 ────────────────────────────────────────────────────
// 三項,中線分別在 10 / 30 / 50。
//
// 門檻是**鄰居**的中線,不是自己的 —— 握把在自己那一列的正中央,把自己算進去的話
// 往下移 3px 就換位了(e2e 抓到的:「原地放開不送請求」那條先紅)。

const MIDS = [10, 30, 50];

test('拖第一項:還沒蓋過第二項的一半 → 留在原位', () => {
  assert.equal(dropIndex(MIDS, 11, 0), 0);
  assert.equal(dropIndex(MIDS, 29, 0), 0);
});

test('拖第一項:越過第二項中線 → 換到第二個位置', () => {
  assert.equal(dropIndex(MIDS, 31, 0), 1);
});

test('拖第一項:越過第三項中線 → 換到最後', () => {
  assert.equal(dropIndex(MIDS, 51, 0), 2);
});

test('拖最後一項往上:越過第二項中線才換位', () => {
  assert.equal(dropIndex(MIDS, 31, 2), 2);
  assert.equal(dropIndex(MIDS, 29, 2), 1);
});

test('剛好落在鄰居中線上時,那一點屬於「上方」', () => {
  // 單一個比較不可能對兩個方向都對稱 —— 邊界必然歸給其中一邊。這裡歸給上方:
  //   往下拖,壓在線上 → 還沒越過(留在原位)
  //   往上拖,壓在線上 → 已經到了(換位)
  // 差別只有 1px,實際拖曳感覺不出來。寫下來是為了下次有人看到這個不對稱時,
  // 知道它是選擇而不是漏掉。
  assert.equal(dropIndex(MIDS, 30, 0), 0);
  assert.equal(dropIndex(MIDS, 30, 2), 1);
});

test('拖到清單下方很遠 → 夾到最後一項,不是 length', () => {
  // 回傳 length 的話,呼叫端 splice 進去會落在陣列尾巴之外。
  assert.equal(dropIndex(MIDS, 9999, 0), 2);
});

test('拖到清單上方很遠 → 夾到第一項', () => {
  assert.equal(dropIndex(MIDS, -9999, 2), 0);
});

test('只有兩項時,從自己中線往下微動不算換位', () => {
  // 這就是 e2e 抓到的那個情況:握把在第一列中央(10),往下 3px。
  assert.equal(dropIndex([10, 40], 13, 0), 0);
  assert.equal(dropIndex([10, 40], 41, 0), 1);
});

test('空清單回 0,不回 -1', () => {
  assert.equal(dropIndex([], 42, 0), 0);
});

// ── 要不要送出 ──────────────────────────────────────────────

test('順序沒變就不算改動', () => {
  assert.equal(sameOrder([0, 1, 2], [0, 1, 2]), true);
  assert.equal(sameOrder([0, 1, 2], [0, 2, 1]), false);
});

test('長度不同一律算改動', () => {
  assert.equal(sameOrder([0, 1], [0, 1, 2]), false);
});
