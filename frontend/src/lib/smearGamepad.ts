import type { GamepadAction } from "./gamepad.ts";

/**
 * 抹片作答頁的手把語意。三種情境各自一份,不從筆試那份說明再蓋。
 *
 * SELECT 留給說明面板,這裡一律不理。任何動作都不是「直接看答案」:
 * 全真模式交卷前沒有一條按鍵路徑會把正解畫出來。看選項只存在於複習
 * 模式,所以 `choices` 在全真不會出現。
 */
export type SmearPadPhase = "typing" | "choices" | "answered";

export type SmearPadIntent =
	| { kind: "ignore" }
	| { kind: "move"; delta: 1 | -1 }
	| { kind: "submit" }
	| { kind: "next" }
	| { kind: "prev" };

const DPAD: ReadonlySet<GamepadAction> = new Set(["up", "down", "left", "right"]);

export function smearPadIntent(
	phase: SmearPadPhase,
	action: GamepadAction,
	canSubmit: boolean,
): SmearPadIntent {
	if (action === "select") return { kind: "ignore" };
	if (phase === "answered") {
		if (action === "faceDown" || action === "r1") return { kind: "next" };
		if (action === "l1") return { kind: "prev" };
		return { kind: "ignore" };
	}
	// 上一題跟畫面上那顆鈕一樣:不是第一題就能回去。下一題在送出之前是停用的,
	// 不能用肩鍵跳過還沒答的這一題。
	if (action === "l1") return { kind: "prev" };
	if (phase === "choices") {
		if (action === "down" || action === "right") return { kind: "move", delta: 1 };
		if (action === "up" || action === "left") return { kind: "move", delta: -1 };
		if (action === "faceDown" && canSubmit) return { kind: "submit" };
		return { kind: "ignore" };
	}
	if (DPAD.has(action)) return { kind: "ignore" };
	if (action === "faceDown" && canSubmit) return { kind: "submit" };
	return { kind: "ignore" };
}

/**
 * 選項游標。還沒選時 ↓/→ 落在第一個、↑/← 落在最後一個。到頭就停,
 * 不繞回另一端 —— 繞回去時長按會在兩端之間來回跳。
 */
export function moveSmearChoice(index: number, count: number, delta: 1 | -1): number {
	if (count <= 0) return -1;
	if (index < 0 || index >= count) return delta > 0 ? 0 : count - 1;
	const next = index + delta;
	if (next < 0) return 0;
	if (next >= count) return count - 1;
	return next;
}

/** 三份說明各自寫完,不 spread 另一份再蓋。意思被換掉的鍵不留兩行。 */
export const SMEAR_PAD_HINTS: Record<SmearPadPhase, { btn: string; label: string }[]> = {
	typing: [
		{ btn: "DPAD ↑ ↓ ← →", label: "自由輸入時不改字" },
		{ btn: "FACE ▼", label: "送出答案(輸入框是空的時無作用)" },
		{ btn: "L1", label: "上一題(第一題無作用)" },
		{ btn: "R1", label: "這一題還沒送出時無作用" },
		{ btn: "SELECT", label: "開關這份說明" },
	],
	choices: [
		{
			btn: "DPAD ↑ ↓ ← →",
			label: "移動選項(可長按;還沒選時 ↓→ 第一個、↑← 最後一個)",
		},
		{ btn: "FACE ▼", label: "送出選到的選項(還沒選時無作用)" },
		{ btn: "L1", label: "上一題(第一題無作用)" },
		{ btn: "R1", label: "這一題還沒送出時無作用" },
		{ btn: "SELECT", label: "開關這份說明" },
	],
	answered: [
		{ btn: "FACE ▼ / R1", label: "下一題(最後一題是查看成績;交卷中無作用)" },
		{ btn: "L1", label: "上一題(第一題無作用)" },
		{ btn: "SELECT", label: "開關這份說明" },
	],
};
