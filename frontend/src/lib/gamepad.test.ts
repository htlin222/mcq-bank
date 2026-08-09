import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AXIS_DEADZONE,
  stepAnnounce,
  axisScrollDelta,
  axisScrollFrame,
  DPAD_BUTTONS,
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

// ---- D-pad 與軸搶同一幀 ----------------------------------------------------
// 回報:Xbox 360 上按 DPAD ↑↓「怪怪的,也會 scroll」。成因不在語意層而在硬體 ——
// hat switch 型的 D-pad 會同時被回報成 buttons 12–15 與一組軸值,兩條路徑一起
// 跑。軸的上限 1400px/s 遠大於按鈕那條的 120px/次,所以蓋過去的是軸。

const NONE = [false, false, false, false];

test('D-pad 沒按時,軸照常捲動', () => {
  const { y } = axisScrollFrame([0, 1], NONE, 16);
  assert.ok(y > 0);
});

test('D-pad 按著時,同一幀的軸值一律不捲(hat switch 會兩邊都報)', () => {
  for (let i = 0; i < DPAD_BUTTONS.length; i++) {
    const pressed = NONE.map((_, j) => j === i);
    assert.deepEqual(
      axisScrollFrame([1, 1], pressed, 16),
      { x: 0, y: 0 },
      `第 ${i} 顆方向鍵按著時不該有軸捲動`,
    );
  }
});

test('軸的兩軸都讀,而且只讀 [0] [1](hat 常落在更後面的軸)', () => {
  const { x, y } = axisScrollFrame([1, -1, 1, 1, 1, 1, 1, 1, 1, 1], NONE, 16);
  assert.ok(x > 0);
  assert.ok(y < 0);
});

test('軸陣列短少時當作 0,不是 NaN', () => {
  assert.deepEqual(axisScrollFrame([], NONE, 16), { x: 0, y: 0 });
});

// ---- 「已連線」提示的歸屬 --------------------------------------------------
// 提示綁在連線事件上,不是綁在 GamepadFab 的掛載上 —— 那顆 FAB 掛在三條路由上,
// 換頁就重掛,記在元件 state 裡等於每次換頁都重講一次。

test('同一支手把只宣告一次,重掛不重講', () => {
  const first = stepAnnounce(null, 'pad-a');
  assert.deepEqual(first, { state: 'pad-a', announce: true });
  const again = stepAnnounce(first.state, 'pad-a');
  assert.deepEqual(again, { state: 'pad-a', announce: false });
});

test('拔掉會歸零,插回來要重新宣告一次', () => {
  const gone = stepAnnounce('pad-a', null);
  assert.deepEqual(gone, { state: null, announce: false });
  assert.deepEqual(stepAnnounce(gone.state, 'pad-a'), {
    state: 'pad-a',
    announce: true,
  });
});

test('換成另一支手把要重新宣告(名字會變,使用者需要知道)', () => {
  assert.deepEqual(stepAnnounce('pad-a', 'pad-b'), {
    state: 'pad-b',
    announce: true,
  });
});

test('本來就沒手把時不會宣告', () => {
  assert.deepEqual(stepAnnounce(null, null), { state: null, announce: false });
});
