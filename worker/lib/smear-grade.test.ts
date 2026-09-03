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

test('⚠️ 危險反義詞不吃拼字容錯 —— macrocytic 不准判成 microcytic', () => {
  const terms: AcceptedTerm[] = [{ text: 'microcytic anemia', tier: 'full' }];
  assert.equal(gradeSmear(['macrocytic anemia'], terms).tier, 'miss');
});

test('危險反義詞清單不影響其他合法拼字容錯', () => {
  // 確認這個修法沒有連坐傷到其他正常的拼字容錯案例
  const g = gradeSmear(['dacrocyt'], DACRO);
  assert.equal(g.score, 1);
});

test('危險反義詞清單涵蓋 -cyte 同源詞(microcyte/macrocyte)', () => {
  const terms: AcceptedTerm[] = [{ text: 'microcyte', tier: 'full' }];
  assert.equal(gradeSmear(['macrocyte'], terms).tier, 'miss');
});

test('⚠️ osteoblast/osteoclast 是題庫裡實際存在的相反細胞,不准互相容錯', () => {
  // 造骨 vs 蝕骨,兩者在 dx.json 各自獨立成題(Test-4-ANS.pdf n=35 / n=51)
  assert.equal(gradeSmear(['osteoclast'], [{ text: 'Osteoblast', tier: 'full' }]).tier, 'miss');
  assert.equal(gradeSmear(['osteoblast'], [{ text: 'Osteoclast', tier: 'full' }]).tier, 'miss');
});

test('⚠️ AMMoL/CMMoL 剛好卡在 FUZZY_MIN_LEN=5 邊界,長度閘門救不了它', () => {
  // AMMoL(急性)與 CMMoL(慢性)骨髓單核球性白血病,縮寫恰好都是 5 字元
  assert.equal(gradeSmear(['CMMoL'], [{ text: 'AMMoL', tier: 'full' }]).tier, 'miss');
  assert.equal(gradeSmear(['AMMoL'], [{ text: 'CMMoL', tier: 'full' }]).tier, 'miss');
});
