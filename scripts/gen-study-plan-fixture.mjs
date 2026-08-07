// 產 frontend/e2e/fixtures/study-plan*.json。
//
// 預覽的 fixture 直接跑 worker 的 buildPlan 產出,而不是手寫一份 JSON ——
// 手寫的形狀會在 PlanResult 改欄位時悄悄過期,而 e2e 測不出「形狀對不對」,
// 只測得出「有沒有炸」。
//
//   node scripts/gen-study-plan-fixture.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../worker/lib/study-plan.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'frontend', 'e2e', 'fixtures');

const years = [
  { year: 114, total: 100, completed: 40, accuracy: 0.62 },
  { year: 113, total: 100, completed: 30, accuracy: 0.55 },
  { year: 112, total: 100, completed: 12, accuracy: 0.58 },
  { year: 111, total: 100, completed: 0, accuracy: null },
  { year: 110, total: 100, completed: 0, accuracy: null },
];

const bootstrap = {
  today: '2026-08-07',
  exam_date: '2026-09-05',
  years,
  total: years.reduce((s, y) => s + y.total, 0),
  completed: years.reduce((s, y) => s + y.completed, 0),
  suggested_seconds: 85,
  saved: null,
  saved_at: null,
};

// 刻意選一組排不完的參數:差額區塊與三條建議才會出現在畫面上,
// e2e 才有東西可以斷言。
const input = {
  years: [114, 113, 112, 111, 110],
  completedOverride: null,
  minutesPerDay: 30,
  secondsPerQuestion: 85,
  rounds: 3,
  mockExams: 4,
  restSunday: true,
  studyStart: '21:00',
  studyEnd: '22:30',
};

const plan = buildPlan(input, {
  today: bootstrap.today,
  examDate: bootstrap.exam_date,
  years,
});

fs.writeFileSync(
  path.join(OUT, 'study-plan.json'),
  `${JSON.stringify(bootstrap, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(OUT, 'study-plan_preview.json'),
  `${JSON.stringify({ plan, coaching: '凝血與輸血醫學是目前正確率最低的兩塊,建議先攻凝血。' }, null, 2)}\n`,
);

console.log(
  `study-plan fixtures written — demand ${plan.demand}, scheduled ${plan.scheduled}, shortfall ${plan.shortfall}`,
);
