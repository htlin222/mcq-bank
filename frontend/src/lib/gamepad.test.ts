import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AXIS_DEADZONE,
  axisScrollDelta,
  BUTTON_ACTIONS,
  IDLE_BUTTON,
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
  stepButton,
} from './gamepad.ts';

test('face cluster is mapped by position, not by vendor letter', () => {
  assert.equal(BUTTON_ACTIONS[0], 'faceDown');
  assert.equal(BUTTON_ACTIONS[1], 'faceRight');
  assert.equal(BUTTON_ACTIONS[2], 'faceLeft');
  assert.equal(BUTTON_ACTIONS[3], 'faceUp');
});

test('d-pad lives on buttons 12–15, not on the analog axes', () => {
  assert.equal(BUTTON_ACTIONS[12], 'up');
  assert.equal(BUTTON_ACTIONS[13], 'down');
  assert.equal(BUTTON_ACTIONS[14], 'left');
  assert.equal(BUTTON_ACTIONS[15], 'right');
});

test('stick clicks (10/11) stay unbound', () => {
  assert.equal(BUTTON_ACTIONS[10], undefined);
  assert.equal(BUTTON_ACTIONS[11], undefined);
});

test('stepButton fires on the frame the button goes down', () => {
  const r = stepButton(IDLE_BUTTON, true, 1000, false);
  assert.equal(r.fire, true);
  assert.equal(r.next.down, true);
});

test('a held non-repeatable button never fires twice', () => {
  const first = stepButton(IDLE_BUTTON, true, 1000, false);
  assert.equal(stepButton(first.next, true, 11_000, false).fire, false);
});

test('releasing resets, so the next press fires again', () => {
  const down = stepButton(IDLE_BUTTON, true, 1000, false);
  const up = stepButton(down.next, false, 1050, false);
  assert.equal(up.fire, false);
  assert.equal(up.next.down, false);
  assert.equal(stepButton(up.next, true, 1100, false).fire, true);
});

test('a repeatable button stays silent until the initial delay elapses', () => {
  const down = stepButton(IDLE_BUTTON, true, 1000, true);
  assert.equal(
    stepButton(down.next, true, 1000 + REPEAT_DELAY_MS - 1, true).fire,
    false,
  );
  assert.equal(
    stepButton(down.next, true, 1000 + REPEAT_DELAY_MS, true).fire,
    true,
  );
});

test('after the delay it repeats on the shorter interval', () => {
  let s = stepButton(IDLE_BUTTON, true, 0, true).next;
  s = stepButton(s, true, REPEAT_DELAY_MS, true).next;
  assert.equal(
    stepButton(s, true, REPEAT_DELAY_MS + REPEAT_INTERVAL_MS - 1, true).fire,
    false,
  );
  assert.equal(
    stepButton(s, true, REPEAT_DELAY_MS + REPEAT_INTERVAL_MS, true).fire,
    true,
  );
});

test('holding ↓ for a second at 60fps yields 1 press + 5 repeats', () => {
  let state = IDLE_BUTTON;
  let fires = 0;
  for (let f = 0; f <= 60; f++) {
    const r = stepButton(state, true, f * (1000 / 60), true);
    state = r.next;
    if (r.fire) fires++;
  }
  assert.equal(fires, 6);
});

test('axisScrollDelta ignores drift inside the deadzone', () => {
  assert.equal(axisScrollDelta(0, 16), 0);
  assert.equal(axisScrollDelta(AXIS_DEADZONE - 0.01, 16), 0);
  assert.equal(axisScrollDelta(-(AXIS_DEADZONE - 0.01), 16), 0);
  // Continuous at the edge: no jump from nothing to something.
  assert.equal(axisScrollDelta(AXIS_DEADZONE, 16), 0);
});

test('axisScrollDelta keeps the sign of the stick', () => {
  assert.ok(axisScrollDelta(1, 16) > 0);
  assert.ok(axisScrollDelta(-1, 16) < 0);
});

test('axisScrollDelta ramps faster than linearly, so a nudge stays gentle', () => {
  const mid = axisScrollDelta(0.5 + AXIS_DEADZONE / 2, 16);
  const full = axisScrollDelta(1, 16);
  assert.ok(mid < full / 2);
});

test('axisScrollDelta scales with frame time, not frame count', () => {
  const one = axisScrollDelta(1, 16);
  const two = axisScrollDelta(1, 32);
  assert.ok(Math.abs(two - one * 2) < 1e-9);
});
