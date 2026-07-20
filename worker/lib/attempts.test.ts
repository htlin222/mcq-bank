import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampElapsedMs, MAX_ELAPSED_MS } from './attempts.ts';

test('正常值原樣通過(取整)', () => {
  assert.equal(clampElapsedMs(74_321), 74_321);
  assert.equal(clampElapsedMs(74_321.9), 74_321);
});

test('未回報 / 非數字 → null', () => {
  for (const v of [undefined, null, Number.NaN, '74000', Number.POSITIVE_INFINITY])
    assert.equal(clampElapsedMs(v), null);
});

test('負數夾到 0,超大值夾到上限', () => {
  assert.equal(clampElapsedMs(-5), 0);
  assert.equal(clampElapsedMs(9_999_999_999), MAX_ELAPSED_MS);
});
