import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termRanges, mergeTouchingRuns, clozeSig, parseRevealState } from './autoCloze.ts';

test('在單一 text run 內找到所有出現位置', () => {
  const runs = [{ pos: 1, text: 'TKI 之後再用 TKI' }];
  assert.deepEqual(termRanges(runs, ['TKI']), [
    { from: 1, to: 4 },
    { from: 10, to: 13 },
  ]);
});

test('跨多個 text run,位置各自以 run 的 pos 為基準', () => {
  const runs = [
    { pos: 1, text: 'CML 帶有 ' },
    { pos: 10, text: 'BCR-ABL1' },
  ];
  assert.deepEqual(termRanges(runs, ['CML', 'BCR-ABL1']), [
    { from: 1, to: 4 },
    { from: 10, to: 18 },
  ]);
});

test('詞跨越粗體邊界仍找得到(相鄰 run 會合併)', () => {
  // "**BCR-ABL1** 融合基因" — 粗體讓它變成兩個相鄰的 text node
  const runs = [
    { pos: 1, text: 'BCR-ABL1' }, // 1..9
    { pos: 9, text: ' 融合基因是關鍵' }, // 緊接在後
  ];
  assert.deepEqual(termRanges(runs, ['BCR-ABL1 融合基因']), [{ from: 1, to: 14 }]);
});

test('不相鄰的 run(跨段落)不可跨界比對', () => {
  // 段落之間有 close/open token,位置不連續
  const runs = [
    { pos: 1, text: '急性' }, // 1..3
    { pos: 6, text: '骨髓性白血病' }, // 中間隔了段落邊界
  ];
  assert.deepEqual(termRanges(runs, ['急性骨髓性白血病']), []);
});

test('mergeTouchingRuns 只黏相鄰的,保留各段起點', () => {
  assert.deepEqual(
    mergeTouchingRuns([
      { pos: 1, text: 'ab' },
      { pos: 3, text: 'cd' },
      { pos: 9, text: 'ef' },
    ]),
    [
      { pos: 1, text: 'abcd' },
      { pos: 9, text: 'ef' },
    ],
  );
});

test('重疊時保留較長的詞,不產生巢狀挖空', () => {
  const runs = [{ pos: 0, text: 'BCR-ABL1 融合基因很重要' }];
  const out = termRanges(runs, ['BCR-ABL1', 'BCR-ABL1 融合基因']);
  assert.deepEqual(out, [{ from: 0, to: 13 }]);
});

test('剔除過短的詞;空詞表回空', () => {
  const runs = [{ pos: 0, text: 'a TKI b' }];
  assert.deepEqual(termRanges(runs, ['a', 'b']), []);
  assert.deepEqual(termRanges(runs, []), []);
});

test('clozeSig 對詞表敏感,空表為 none', () => {
  assert.equal(clozeSig(null), 'none');
  assert.equal(clozeSig([]), 'none');
  assert.equal(clozeSig(['TKI']), clozeSig(['TKI']));
  assert.notEqual(clozeSig(['TKI']), clozeSig(['TKI', 'CML']));
});

test('詞表換了就丟掉自動層的揭曉狀態,手動層保留', () => {
  const raw = JSON.stringify({ m: [1, 2], a: [0, 3], sig: 'old' });
  assert.deepEqual(parseRevealState(raw, 'old'), { m: [1, 2], a: [0, 3], sig: 'old' });
  assert.deepEqual(parseRevealState(raw, 'new'), { m: [1, 2], a: [], sig: 'new' });
});

test('舊格式(裸陣列)視為手動層揭曉紀錄', () => {
  assert.deepEqual(parseRevealState('[0,2]', 'x'), { m: [0, 2], a: [], sig: 'x' });
});

test('壞掉 / 空的 sessionStorage 回乾淨狀態', () => {
  assert.deepEqual(parseRevealState(null, 'x'), { m: [], a: [], sig: 'x' });
  assert.deepEqual(parseRevealState('{oops', 'x'), { m: [], a: [], sig: 'x' });
  assert.deepEqual(parseRevealState('[1,"a",-3]', 'x'), { m: [1], a: [], sig: 'x' });
});
