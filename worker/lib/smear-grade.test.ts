import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTerm, gradeSmear, type AcceptedTerm } from './smear-grade.ts';

const DACRO: AcceptedTerm[] = [
  { text: 'dacrocyte', tier: 'full' },
  { text: 'dacryocyte', tier: 'full' },
  { text: 'poikilocytosis', tier: 'half' },
  { text: 'tear drop', tier: 'lay' },
  { text: 'teardrop RBC', tier: 'lay' },
];

test('normalize 去變音符', () => {
  assert.equal(normalizeTerm('Döhle body'), 'dohle body');
  assert.equal(normalizeTerm('Pelger-Huët'), 'pelger huet');
});

test('normalize 去撇號與連字號', () => {
  assert.equal(normalizeTerm("Gaucher's disease"), 'gauchers disease');
  assert.equal(normalizeTerm('May-Hegglin'), 'may hegglin');
});

test('全對', () => {
  const g = gradeSmear(['Dacrocyte'], DACRO);
  assert.equal(g.tier, 'full');
  assert.equal(g.score, 1);
  assert.deepEqual(g.spellingErrors, []);
});

test('半對', () => {
  assert.equal(gradeSmear(['poikilocytosis'], DACRO).score, 0.5);
});

test('俗名 0 分,但 tier 是 lay 不是 miss', () => {
  const g = gradeSmear(['tear', 'drop'], DACRO);
  assert.equal(g.tier, 'lay');
  assert.equal(g.score, 0);
  assert.equal(g.canonical, 'dacrocyte');   // 要能明講正解
});

test('完全不會是 miss,不是 lay', () => {
  assert.equal(gradeSmear(['schistocyte'], DACRO).tier, 'miss');
});

test('tier 順序:full 先於 lay', () => {
  // 一個詞同時像兩層時,寬鬆的那層不准先吃掉
  const terms: AcceptedTerm[] = [
    { text: 'target cell', tier: 'lay' },
    { text: 'codocyte', tier: 'full' },
  ];
  assert.equal(gradeSmear(['codocyte'], terms).tier, 'full');
});

test('拼字差一個字元:算對但標記', () => {
  const g = gradeSmear(['dacrocyt'], DACRO);
  assert.equal(g.score, 1);
  assert.deepEqual(g.spellingErrors, [{ typed: 'dacrocyt', expected: 'dacrocyte' }]);
});

test('⚠️ 短字不吃容錯 —— ALL 不准判成 AML', () => {
  const aml: AcceptedTerm[] = [{ text: 'AML', tier: 'full' }];
  assert.equal(gradeSmear(['ALL'], aml).tier, 'miss');
  assert.equal(gradeSmear(['CLL'], [{ text: 'CML', tier: 'full' }]).tier, 'miss');
});

test('大小寫與多餘空白不影響', () => {
  assert.equal(gradeSmear(['  TEAR ', ' DROP '], DACRO).tier, 'lay');
});

test('格子數不硬閘 —— 3 格只填第一格但填對整個答案', () => {
  const maha: AcceptedTerm[] = [
    { text: 'microangiopathic hemolytic anemia', tier: 'full' },
    { text: 'MAHA', tier: 'full' },
  ];
  assert.equal(gradeSmear(['MAHA', '', ''], maha).score, 1);
});

test('空白作答是 miss,不是任何一層', () => {
  assert.equal(gradeSmear(['', '  '], DACRO).tier, 'miss');
});
