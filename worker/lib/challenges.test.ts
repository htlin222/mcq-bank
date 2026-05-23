import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  type DecisionInput,
  CONTESTED_GATE_MS,
  ARCHIVE_GATE_MS,
} from './challenges-state.ts';

// Shared base — overlay each case with the fields it cares about.
const T0 = 1_700_000_000_000;
const base = (overrides: Partial<DecisionInput>): DecisionInput => ({
  status: 'open',
  agrees: 0,
  disagrees: 0,
  contestedAt: null,
  lastActivityAt: T0,
  now: T0,
  ...overrides,
});

test('open with 0 votes stays put', () => {
  const r = decide(base({}));
  assert.deepEqual(r, { next: 'no-change' });
});

test('open + 1 agree stays put (needs 2)', () => {
  const r = decide(base({ agrees: 1 }));
  assert.deepEqual(r, { next: 'no-change' });
});

test('open + 2 agrees + 0 disagrees → promote (fast)', () => {
  const r = decide(base({ agrees: 2 }));
  assert.deepEqual(r, { next: 'promote', reason: 'auto:fast' });
});

test('open + 5 agrees + 0 disagrees → still fast promote (higher count just confirms)', () => {
  const r = decide(base({ agrees: 5 }));
  assert.deepEqual(r, { next: 'promote', reason: 'auto:fast' });
});

test('open + 1 agree + 1 disagree → transition to contested (no fast promote)', () => {
  const r = decide(base({ agrees: 1, disagrees: 1 }));
  assert.deepEqual(r, { next: 'open->contested' });
});

test('open + 5 agrees + 1 disagree → transition to contested (the disagree freezes the fast path)', () => {
  const r = decide(base({ agrees: 5, disagrees: 1 }));
  assert.deepEqual(r, { next: 'open->contested' });
});

test('contested before 48h elapsed: no resolution even with strict-count satisfied', () => {
  const r = decide(
    base({
      status: 'contested',
      agrees: 6,
      disagrees: 1,
      contestedAt: T0 - (CONTESTED_GATE_MS - 1),
    })
  );
  assert.deepEqual(r, { next: 'no-change' });
});

test('contested after 48h with 4 agrees + net +3 → promote (strict)', () => {
  // 4 agrees, 1 disagree = net 3 ✓
  const r = decide(
    base({
      status: 'contested',
      agrees: 4,
      disagrees: 1,
      contestedAt: T0 - CONTESTED_GATE_MS,
    })
  );
  assert.deepEqual(r, { next: 'promote', reason: 'auto:strict' });
});

test('contested after 48h with 4 agrees + net +2 → no promote (net below threshold)', () => {
  // 4 agrees, 2 disagrees = net 2 < 3
  const r = decide(
    base({
      status: 'contested',
      agrees: 4,
      disagrees: 2,
      contestedAt: T0 - CONTESTED_GATE_MS,
    })
  );
  assert.deepEqual(r, { next: 'no-change' });
});

test('contested after 48h with 3 agrees + net +3 → no promote (agree count below 4)', () => {
  // 3 agrees, 0 disagrees = net 3, but agrees<4
  const r = decide(
    base({
      status: 'contested',
      agrees: 3,
      disagrees: 0,
      contestedAt: T0 - CONTESTED_GATE_MS,
    })
  );
  assert.deepEqual(r, { next: 'no-change' });
});

test('contested after 48h with net −2 → reject', () => {
  const r = decide(
    base({
      status: 'contested',
      agrees: 1,
      disagrees: 3,
      contestedAt: T0 - CONTESTED_GATE_MS,
    })
  );
  assert.deepEqual(r, { next: 'reject', reason: 'auto:rejected' });
});

test('contested after 48h with net −1 → no rejection (needs −2 or worse)', () => {
  const r = decide(
    base({
      status: 'contested',
      agrees: 2,
      disagrees: 3,
      contestedAt: T0 - CONTESTED_GATE_MS,
    })
  );
  assert.deepEqual(r, { next: 'no-change' });
});

test('contested with no activity in 14d → archive', () => {
  const r = decide(
    base({
      status: 'contested',
      agrees: 1,
      disagrees: 1,
      contestedAt: T0 - ARCHIVE_GATE_MS,
      lastActivityAt: T0 - ARCHIVE_GATE_MS,
    })
  );
  assert.deepEqual(r, { next: 'archive', reason: 'auto:archived' });
});

test('contested with recent activity → not archived even past 14d in contested_at', () => {
  // contested 20d ago but someone voted yesterday
  const r = decide(
    base({
      status: 'contested',
      agrees: 1,
      disagrees: 1,
      contestedAt: T0 - 20 * 24 * 3600 * 1000,
      lastActivityAt: T0 - 24 * 3600 * 1000, // yesterday
    })
  );
  assert.deepEqual(r, { next: 'no-change' });
});

test('terminal states never transition', () => {
  for (const status of ['promoted', 'rejected', 'archived', 'withdrawn'] as const) {
    const r = decide(
      base({
        status,
        agrees: 100,
        disagrees: 0,
        contestedAt: T0 - 10 * ARCHIVE_GATE_MS,
        lastActivityAt: T0 - 10 * ARCHIVE_GATE_MS,
      })
    );
    assert.deepEqual(r, { next: 'no-change' }, `status=${status}`);
  }
});

test('promote (strict) is preferred over reject when both conditions met (impossible by math, but defensive)', () => {
  // agrees=4, disagrees=0 → net +4, promote wins.
  const r = decide(
    base({
      status: 'contested',
      agrees: 4,
      disagrees: 0,
      contestedAt: T0 - CONTESTED_GATE_MS,
    })
  );
  assert.deepEqual(r, { next: 'promote', reason: 'auto:strict' });
});

test('open + multiple disagrees → contested (not reject yet)', () => {
  // Reject only fires from contested status with 48h elapsed.
  const r = decide(base({ agrees: 0, disagrees: 5 }));
  assert.deepEqual(r, { next: 'open->contested' });
});
