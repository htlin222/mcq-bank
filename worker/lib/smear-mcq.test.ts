import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  pickMcqDistractors,
  pickMcqOptions,
  pickCorrectOptionLabel,
  type McqCandidate,
  type DxTermLike,
} from './smear-mcq.ts';
import { gradeSmear, type AcceptedTerm } from './smear-grade.ts';

const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

const cand = (id: string, topic: string, label = id): McqCandidate => ({ id, topic, label });

test('同 topic 優先抽干擾項', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte');
  const pool = [
    cand('schistocyte', 'rbc'),
    cand('spherocyte', 'rbc'),
    cand('target-cell', 'rbc'),
    cand('burr-cell', 'rbc'),
    cand('aml', 'myeloid'),
    cand('cll', 'lymphoid'),
  ];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert.equal(got.length, 4);
  // 四個同 topic 候選剛好等於名額，一個跨 topic 的都不該出現
  assert.ok(!got.includes('aml'));
  assert.ok(!got.includes('cll'));
});

test('⚠️ 同 topic 不足時，缺額要從其他 topic 回填 —— 不准少於 count', () => {
  const correct = cand('rare-dx', 'infection', 'rare-dx');
  const pool = [
    cand('other-infection', 'infection'),
    cand('aml', 'myeloid'),
    cand('cll', 'lymphoid'),
    cand('platelet-dx', 'platelet'),
    cand('storage-dx', 'other'),
  ];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2, 0.3, 0.4]));
  assert.equal(got.length, 4); // 同 topic 只有 1 個候選，其餘 3 個從別 topic 回填
});

test('正解永遠不會出現在自己的干擾項清單裡', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte');
  const pool = [correct, cand('schistocyte', 'rbc'), cand('spherocyte', 'rbc')];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2]));
  assert.ok(!got.includes('dacrocyte'));
});

test('pickMcqOptions：正解一定在洗牌後的清單裡，且不重複', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte-label');
  const pool = [
    cand('schistocyte', 'rbc', 'schistocyte-label'),
    cand('spherocyte', 'rbc', 'spherocyte-label'),
    cand('target-cell', 'rbc', 'target-cell-label'),
    cand('burr-cell', 'rbc', 'burr-cell-label'),
  ];
  const got = pickMcqOptions(correct, pool, seq([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert.equal(got.length, 5);
  assert.equal(new Set(got).size, 5);
  assert.ok(got.includes('dacrocyte-label'));
});

test('題庫小到湊不出 4 個干擾項時，回傳能湊到的數量，不丟例外', () => {
  const correct = cand('only-dx', 'rbc', 'only-dx');
  const got = pickMcqDistractors(correct, [correct], 4, seq([0.1]));
  assert.equal(got.length, 0);
});

// ---------------------------------------------------------------------------
// pickCorrectOptionLabel：跑真實種子資料 scripts/smear/data/dx.json，逐一
// 檢查「mc-options 端點會選出的正解文字」能不能通過 gradeSmear() 判成 full。
//
// 這不是給 pickCorrectOptionLabel 本身的單元測試而已 —— 它是真正在守
// worker/routes/smear.ts 的 mc-options 端點：canonical_long 常帶括號補充
// (例如 all_l3 的 "(Burkitt-type)"),跟 smear_terms 裡登記的 full 級用詞
// 字數不一致時,gradeSmear() 判定看的是 smear_terms,不是 canonical_long,
// 直接把 canonical_long 塞進選項會讓使用者選到「顯示的正解」卻被判成 miss。
// ---------------------------------------------------------------------------
type DxSeed = {
  dx_id: string;
  canonical_long: string;
  terms: DxTermLike[];
};

function loadDxSeed(): DxSeed[] {
  const p = path.resolve(process.cwd(), 'scripts/smear/data/dx.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('pickCorrectOptionLabel：新邏輯對每個 dx 都能通過 gradeSmear（真實種子資料）', () => {
  const dxList = loadDxSeed();
  assert.ok(dxList.length >= 50, '種子資料筆數太少，可能讀錯檔案');

  const failures: string[] = [];
  for (const dx of dxList) {
    const label = pickCorrectOptionLabel(dx.terms, dx.canonical_long);
    const grade = gradeSmear([label], dx.terms as AcceptedTerm[]);
    if (grade.tier !== 'full') {
      failures.push(`${dx.dx_id}: label="${label}" tier=${grade.tier}`);
    }
  }
  assert.deepEqual(failures, [], `以下 dx 選到的正解文字沒能通過 gradeSmear:\n${failures.join('\n')}`);
});

test('⚠️ 對照組：舊邏輯（直接用 canonical_long）在真實種子資料上會出現 miss', () => {
  // 這條測試存在的理由是證明上一條測試真的抓得到這類 bug —— 如果把
  // pickCorrectOptionLabel 換回「永遠回傳 canonical_long」，一部分 dx 就會
  // 被 gradeSmear 判成 miss。少了這條對照組，前一條測試也可能是恆真的空掃。
  const dxList = loadDxSeed();
  const oldLogicLabel = (dx: DxSeed) => dx.canonical_long;

  const misses = dxList.filter((dx) => {
    const grade = gradeSmear([oldLogicLabel(dx)], dx.terms as AcceptedTerm[]);
    return grade.tier !== 'full';
  });

  assert.ok(
    misses.length > 0,
    '對照組沒有量到任何 miss —— 這條測試本身可能失效，回頭檢查 dx.json 是否還原成能重現 bug 的樣子',
  );
  // 已知至少含 all_l3（canonical_long 帶 "(Burkitt-type)"，比 full 級詞多字）
  assert.ok(misses.some((dx) => dx.dx_id === 'all_l3'));
});
