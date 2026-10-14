import { test } from "node:test";
import assert from "node:assert/strict";
import type { GamepadAction } from "./gamepad.ts";
import { SMEAR_PAD_HINTS, moveSmearChoice, smearPadIntent } from "./smearGamepad.ts";

const ACTIONS: GamepadAction[] = [
	"up",
	"down",
	"left",
	"right",
	"faceDown",
	"faceRight",
	"faceLeft",
	"faceUp",
	"l1",
	"r1",
	"l2",
	"r2",
	"select",
	"start",
];

test("自由輸入時十字鍵不產生任何動作,空框的面鍵也不送出", () => {
	for (const action of ["up", "down", "left", "right"] as const) {
		assert.deepEqual(smearPadIntent("typing", action, true), { kind: "ignore" });
	}
	assert.deepEqual(smearPadIntent("typing", "faceDown", false), { kind: "ignore" });
	assert.deepEqual(smearPadIntent("typing", "faceDown", true), { kind: "submit" });
	assert.deepEqual(smearPadIntent("typing", "faceLeft", true), { kind: "ignore" });
	assert.deepEqual(smearPadIntent("typing", "l1", true), { kind: "prev" });
	assert.deepEqual(smearPadIntent("typing", "r1", true), { kind: "ignore" });
});

test("看選項之後十字鍵移動、選了才能送出,還沒送出不能換題", () => {
	assert.deepEqual(smearPadIntent("choices", "down", false), { kind: "move", delta: 1 });
	assert.deepEqual(smearPadIntent("choices", "right", false), { kind: "move", delta: 1 });
	assert.deepEqual(smearPadIntent("choices", "up", true), { kind: "move", delta: -1 });
	assert.deepEqual(smearPadIntent("choices", "left", true), { kind: "move", delta: -1 });
	assert.deepEqual(smearPadIntent("choices", "faceDown", false), { kind: "ignore" });
	assert.deepEqual(smearPadIntent("choices", "faceDown", true), { kind: "submit" });
	assert.deepEqual(smearPadIntent("choices", "faceLeft", true), { kind: "ignore" });
	assert.deepEqual(smearPadIntent("choices", "l1", true), { kind: "prev" });
	assert.deepEqual(smearPadIntent("choices", "r1", true), { kind: "ignore" });
});

test("答完才換題:面鍵與 R1 下一題,L1 上一題,十字鍵不再改選項", () => {
	assert.deepEqual(smearPadIntent("answered", "faceDown", false), { kind: "next" });
	assert.deepEqual(smearPadIntent("answered", "r1", false), { kind: "next" });
	assert.deepEqual(smearPadIntent("answered", "l1", false), { kind: "prev" });
	assert.deepEqual(smearPadIntent("answered", "down", false), { kind: "ignore" });
	assert.deepEqual(smearPadIntent("answered", "faceLeft", true), { kind: "ignore" });
});

test("SELECT 三種情境都留給說明面板,而且沒有任何動作是揭曉正解", () => {
	for (const phase of ["typing", "choices", "answered"] as const) {
		assert.deepEqual(smearPadIntent(phase, "select", true), { kind: "ignore" });
		for (const action of ACTIONS) {
			for (const canSubmit of [true, false]) {
				const intent = smearPadIntent(phase, action, canSubmit);
				assert.notEqual(intent.kind, "reveal");
				assert.equal(JSON.stringify(intent).includes("reveal_answer"), false);
			}
		}
	}
});

test("沒選時往下是第一個、往上是最後一個,到頭停住不繞", () => {
	assert.equal(moveSmearChoice(-1, 3, 1), 0);
	assert.equal(moveSmearChoice(-1, 3, -1), 2);
	assert.equal(moveSmearChoice(0, 3, -1), 0);
	assert.equal(moveSmearChoice(2, 3, 1), 2);
	assert.equal(moveSmearChoice(1, 3, 1), 2);
	assert.equal(moveSmearChoice(0, 0, 1), -1);
});

test("三份說明各自寫,不沿用筆試的收藏與複製", () => {
	const phases = ["typing", "choices", "answered"] as const;
	const blobs = phases.map((p) => SMEAR_PAD_HINTS[p].map((h) => `${h.btn}:${h.label}`).join("\n"));
	assert.equal(new Set(blobs).size, 3);
	const all = blobs.join("\n");
	assert.equal(/收藏|複製題目|略過|直接看答案/.test(all), false);
	assert.match(SMEAR_PAD_HINTS.typing.map((h) => h.label).join(" "), /不改字/);
	assert.match(SMEAR_PAD_HINTS.choices.map((h) => h.label).join(" "), /移動選項/);
	assert.match(SMEAR_PAD_HINTS.answered.map((h) => h.label).join(" "), /下一題/);
	for (const phase of phases) {
		assert.ok(SMEAR_PAD_HINTS[phase].some((h) => h.btn === "SELECT" || h.btn.includes("SELECT")));
	}
	assert.notEqual(
		SMEAR_PAD_HINTS.typing.find((h) => h.btn === "FACE ▼")?.label,
		SMEAR_PAD_HINTS.choices.find((h) => h.btn === "FACE ▼")?.label,
	);
});
