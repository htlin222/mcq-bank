import { useEffect, useRef, useState } from "react";
import {
	type GamepadAction,
	gamepadName,
	isGamepadConnected,
	nonStandardMapping,
	subscribeActions,
	subscribeAxis,
	subscribeConnection,
} from "../lib/gamepad";

/**
 * Run `onAction` for every gamepad button press (and d-pad auto-repeat).
 *
 * A ref holds the latest handler so the subscription is made once and still
 * sees fresh state — the same shape as the window `keydown` handlers in
 * QuestionCard / Question, and for the same reason.
 */
export function useGamepad(onAction: (action: GamepadAction) => void): void {
	const ref = useRef(onAction);
	ref.current = onAction;
	useEffect(() => subscribeActions((a) => ref.current(a)), []);
}

/**
 * Left stick → scroll. `getEl` returns the element to scroll, or null for the
 * window; review mode's columns layout scrolls each pane independently, so the
 * target can't be baked in.
 */
export function useGamepadScroll(getEl: () => HTMLElement | null): void {
	const ref = useRef(getEl);
	ref.current = getEl;
	useEffect(
		() =>
			subscribeAxis(({ y }) => {
				if (y === 0) return;
				const el = ref.current();
				if (el) el.scrollTop += y;
				else window.scrollBy(0, y);
			}),
		[],
	);
}

export type GamepadStatus = {
	connected: boolean;
	/** Non-null only when the mapping can't be trusted (8BitDo S/D/M mode). */
	badMapping: string | null;
	name: string | null;
};

function readStatus(): GamepadStatus {
	return {
		connected: isGamepadConnected(),
		badMapping: nonStandardMapping(),
		name: gamepadName(),
	};
}

/**
 * Whether a pad is attached, what it calls itself, and whether its mapping is
 * one we can trust.
 *
 * Note the browser does not report a pad the moment it pairs over Bluetooth —
 * it stays hidden until the user presses a button on it, as an anti-
 * fingerprinting measure. So `connected` flipping true *is* the first press,
 * and there is no way to show "paired but asleep". GamepadFab turns that into
 * the user-facing story: the FAB appearing means the site can see the pad.
 */
export function useGamepadConnected(): GamepadStatus {
	const [snap, setSnap] = useState(readStatus);
	useEffect(() => subscribeConnection(() => setSnap(readStatus())), []);
	return snap;
}
