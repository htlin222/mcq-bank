import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTimer,
  hide,
  show,
  pause,
  resume,
  read,
  MAX_QUESTION_MS,
} from './questionTimer.ts';

test('連續可見的區間全部計入', () => {
  const t = startTimer(1_000);
  assert.deepEqual(read(t, 6_000), { elapsedMs: 5_000, outlier: false });
});

test('分頁隱藏期間不累加,回來後續計', () => {
  let t = startTimer(0);
  t = hide(t, 3_000); // 看了 3 秒
  t = show(t, 60_000); // 去查資料 57 秒 —— 不計
  assert.deepEqual(read(t, 62_000), { elapsedMs: 5_000, outlier: false });
});

test('隱藏中直接提交:讀數停在隱藏當下', () => {
  let t = startTimer(0);
  t = hide(t, 4_000);
  assert.deepEqual(read(t, 999_000), { elapsedMs: 4_000, outlier: false });
});

test('暫停中提交(模擬考按暫停)不繼續累加', () => {
  let t = pause(startTimer(0), 2_000);
  assert.equal(read(t, 500_000).elapsedMs, 2_000);
  t = resume(t, 500_000);
  assert.equal(read(t, 503_000).elapsedMs, 5_000);
});

test('超過單題上限 → 截斷並標 outlier', () => {
  assert.deepEqual(read(startTimer(0), MAX_QUESTION_MS + 60_000), {
    elapsedMs: MAX_QUESTION_MS,
    outlier: true,
  });
});

test('快速連答:換題重啟後歸零', () => {
  const a = startTimer(0);
  assert.equal(read(a, 800).elapsedMs, 800);
  assert.equal(read(startTimer(800), 1_100).elapsedMs, 300);
});

test('重複 hide / 重複 show 具冪等性(瀏覽器會重放事件)', () => {
  let t = hide(hide(startTimer(0), 1_000), 5_000); // 第二次 hide 不倒扣
  t = show(show(t, 9_000), 9_500); // 第二次 show 不重設起點
  assert.equal(read(t, 10_000).elapsedMs, 2_000);
});
