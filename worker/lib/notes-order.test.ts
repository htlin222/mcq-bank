// 重排請求的收斂(#140)。判準是「必須是現有 slot 的排列」——放行部分正確的請求
// 會寫出一份「有些排過、有些沒有」的順序,而那在畫面上只是「排錯了」,使用者不會
// 知道是請求壞掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNoteOrder } from './notes.ts';

const EXISTING = [0, 1, 3]; // slot 不連續是正常的:刪掉的號碼不重用

test('現有 slot 的排列 → 放行', () => {
  assert.deepEqual(resolveNoteOrder(EXISTING, [3, 0, 1]), { ok: true, slots: [3, 0, 1] });
});

test('原順序也放行 —— 判「有沒有變」是呼叫端的事', () => {
  assert.deepEqual(resolveNoteOrder(EXISTING, [0, 1, 3]), { ok: true, slots: [0, 1, 3] });
});

test('少一項 → 400', () => {
  const r = resolveNoteOrder(EXISTING, [0, 1]);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 400);
});

test('多一項 → 400', () => {
  assert.equal(resolveNoteOrder(EXISTING, [0, 1, 3, 4]).ok, false);
});

test('重複 → 400(長度剛好也不行)', () => {
  assert.equal(resolveNoteOrder(EXISTING, [0, 0, 1]).ok, false);
});

test('夾帶不屬於這一題的號碼 → 400', () => {
  assert.equal(resolveNoteOrder(EXISTING, [0, 1, 2]).ok, false);
});

test('不是陣列 → 400,不丟例外', () => {
  assert.equal(resolveNoteOrder(EXISTING, undefined).ok, false);
  assert.equal(resolveNoteOrder(EXISTING, '0,1,3').ok, false);
  assert.equal(resolveNoteOrder(EXISTING, { 0: 1 }).ok, false);
});

test('非整數 → 400', () => {
  assert.equal(resolveNoteOrder(EXISTING, [0, 1.5, 3]).ok, false);
  assert.equal(resolveNoteOrder(EXISTING, [0, 'x', 3]).ok, false);
});

test('字串數字視為數字 —— JSON 來源可能是字串', () => {
  assert.deepEqual(resolveNoteOrder(EXISTING, ['3', '0', '1']), { ok: true, slots: [3, 0, 1] });
});

test('空清單只接受空陣列', () => {
  assert.deepEqual(resolveNoteOrder([], []), { ok: true, slots: [] });
  assert.equal(resolveNoteOrder([], [0]).ok, false);
});
