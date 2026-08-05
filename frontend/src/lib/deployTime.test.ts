import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDeployedAt, relativeTime } from './deployTime.ts';

// 2026-08-05 07:28:50 UTC = 台北 15:28
const ISO = '2026-08-05T07:28:50.000Z';
const AT = Date.parse(ISO);
const MIN = 60_000;
const HOUR = 60 * MIN;

test('換算成台北時間並標上 GMT+8', () => {
  assert.equal(
    formatDeployedAt({ buildTimeIso: ISO }, AT + 3 * HOUR),
    '2026/08/05 15:28 (GMT+8) · 3 小時前',
  );
});

// 部署機器在別的時區時,原本那串沒有偏移量的本地時間會整個對不上;
// 換成 ISO 之後顯示的一律是台北牆上時鐘。
test('跨日:UTC 16:05 是台北隔天 00:05', () => {
  const iso = '2026-08-05T16:05:00.000Z';
  assert.match(formatDeployedAt({ buildTimeIso: iso }, Date.parse(iso)), /^2026\/08\/06 00:05 /);
});

test('相對時間的四段', () => {
  assert.equal(relativeTime(AT, AT + 30_000), '剛剛');
  assert.equal(relativeTime(AT, AT + 5 * MIN), '5 分鐘前');
  assert.equal(relativeTime(AT, AT + 23 * HOUR), '23 小時前');
  assert.equal(relativeTime(AT, AT + 50 * HOUR), '2 天前');
});

// 部署機和讀的人時鐘沒對齊時會拿到未來的時間戳。「-1 小時前」讀起來像壞掉。
test('未來的時間戳當成剛剛', () => {
  assert.equal(relativeTime(AT, AT - 5 * HOUR), '剛剛');
});

// 舊版 version.json 只有那串不帶時區的本地時間 —— 猜錯時區會讓相對時間
// 差上大半天,所以原樣印出、不附相對時間。
test('只有舊欄位就原樣印出,不編造相對時間', () => {
  assert.equal(formatDeployedAt({ buildTime: '2026-08-05 15:28:50' }, AT), '2026-08-05 15:28:50');
});

test('ISO 壞掉時退回舊欄位', () => {
  assert.equal(
    formatDeployedAt({ buildTime: '2026-08-05 15:28:50', buildTimeIso: 'nonsense' }, AT),
    '2026-08-05 15:28:50',
  );
});

// 呼叫端據此整行不畫,而不是留一個孤零零的「部署於」。
test('沒東西可用就回空字串', () => {
  assert.equal(formatDeployedAt(null, AT), '');
  assert.equal(formatDeployedAt({}, AT), '');
  assert.equal(formatDeployedAt({ buildTime: '   ' }, AT), '');
});
