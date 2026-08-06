// Gamepad support, built on the native Gamepad API rather than a library.
//
// gamecontroller.js was the starting point but buys us nothing we need: its npm
// release predates the haptics API entirely (no vibration at all), it ships UMD
// with no types, it starts a global rAF loop the moment it is imported, and it
// only exposes the d-pad as `button12`–`button15` — so the semantic layer below
// would have to exist either way. See
// docs/plans/2026-08-06-gamepad-control-design.md.

// Positions, not vendor letters. An 8BitDo Pro 2 in X mode and a DualSense
// disagree about which glyph sits on the bottom face button; they agree about
// where it is.
export type GamepadAction =
	| "up"
	| "down"
	| "left"
	| "right"
	| "faceDown"
	| "faceRight"
	| "faceLeft"
	| "faceUp"
	| "l1"
	| "r1"
	| "l2"
	| "r2"
	| "select"
	| "start";

// W3C standard mapping. Only reliable when `gamepad.mapping === 'standard'` —
// the 8BitDo's S/D/M modes report something else and shuffle the face buttons,
// which is why GamepadFab surfaces `nonStandardMapping()` instead of letting
// the indices silently point at the wrong keys.
export const BUTTON_ACTIONS: Readonly<Record<number, GamepadAction>> = {
	0: "faceDown",
	1: "faceRight",
	2: "faceLeft",
	3: "faceUp",
	4: "l1",
	5: "r1",
	6: "l2",
	7: "r2",
	8: "select",
	9: "start",
	12: "up",
	13: "down",
	14: "left",
	15: "right",
};

// Only the d-pad auto-repeats. A held 收藏 / 送出 / 交卷 that fires ten times a
// second is damage, but a 100-question list is unusable without a held ↓.
const REPEATABLE: ReadonlySet<GamepadAction> = new Set<GamepadAction>([
	"up",
	"down",
	"left",
	"right",
]);

export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 120;

export type ButtonState = { down: boolean; repeatAt: number };
export const IDLE_BUTTON: ButtonState = { down: false, repeatAt: 0 };

/**
 * Edge detection with optional auto-repeat, as a pure step function so the
 * timing is testable without a real gamepad.
 *
 * Fires on the frame a button goes down, then — if repeatable — every
 * REPEAT_INTERVAL_MS after an initial REPEAT_DELAY_MS hold.
 */
export function stepButton(
	prev: ButtonState,
	isDown: boolean,
	now: number,
	repeatable: boolean,
): { next: ButtonState; fire: boolean } {
	if (!isDown) return { next: IDLE_BUTTON, fire: false };
	if (!prev.down)
		return { next: { down: true, repeatAt: now + REPEAT_DELAY_MS }, fire: true };
	if (!repeatable) return { next: prev, fire: false };
	if (now >= prev.repeatAt)
		return {
			next: { down: true, repeatAt: now + REPEAT_INTERVAL_MS },
			fire: true,
		};
	return { next: prev, fire: false };
}

export const AXIS_DEADZONE = 0.25;
const SCROLL_MAX_PX_PER_SEC = 1400;

/**
 * Analog stick displacement → pixels to scroll this frame.
 *
 * Squared response past the deadzone: a nudge nudges, a full push moves fast.
 * Linear feels twitchy at the low end, which is where long-form reading lives.
 */
export function axisScrollDelta(value: number, dtMs: number): number {
	const mag = Math.abs(value);
	if (mag < AXIS_DEADZONE) return 0;
	const t = (mag - AXIS_DEADZONE) / (1 - AXIS_DEADZONE);
	return Math.sign(value) * t * t * SCROLL_MAX_PX_PER_SEC * (dtMs / 1000);
}

// ---------------------------------------------------------------- rumble

export type RumblePreset = "tap" | "correct" | "wrong";

type Pulse = {
	duration: number;
	startDelay: number;
	strongMagnitude: number;
	weakMagnitude: number;
};

// `tap` fires the instant 送出 is pressed; `correct`/`wrong` land when the
// server answers. Both halves exist because the round trip is long enough that
// either one alone feels wrong — see the design doc.
const PATTERNS: Readonly<Record<RumblePreset, readonly Pulse[]>> = {
	tap: [{ duration: 60, startDelay: 0, strongMagnitude: 0, weakMagnitude: 0.4 }],
	correct: [
		{ duration: 40, startDelay: 0, strongMagnitude: 0, weakMagnitude: 0.5 },
		{ duration: 40, startDelay: 60, strongMagnitude: 0, weakMagnitude: 0.5 },
	],
	wrong: [
		{ duration: 180, startDelay: 0, strongMagnitude: 0.6, weakMagnitude: 0.3 },
	],
};

const RUMBLE_KEY = "gamepad-rumble";

export function rumbleEnabled(): boolean {
	try {
		return localStorage.getItem(RUMBLE_KEY) !== "off";
	} catch {
		return true;
	}
}

export function setRumbleEnabled(on: boolean): void {
	try {
		localStorage.setItem(RUMBLE_KEY, on ? "on" : "off");
	} catch {
		/* ignore quota/availability errors */
	}
}

type Actuator = {
	playEffect: (type: string, params: Pulse) => Promise<string>;
};

function actuator(): Actuator | null {
	const gp = activeGamepad();
	// WebKit ships no vibrationActuator at all, so this is the normal path on
	// iOS/iPadOS rather than an error case.
	const a = (gp as unknown as { vibrationActuator?: Actuator } | null)
		?.vibrationActuator;
	return a && typeof a.playEffect === "function" ? a : null;
}

/**
 * Best-effort haptics. Silently does nothing with no gamepad, no actuator
 * (Safari), or rumble switched off — never throws, never blocks a caller.
 */
export async function rumble(preset: RumblePreset): Promise<void> {
	if (!rumbleEnabled()) return;
	for (const pulse of PATTERNS[preset]) {
		// Re-read each pulse: a `playEffect` cancels whatever is playing, so the
		// sequence has to await, and the pad may vanish mid-sequence.
		const a = actuator();
		if (!a) return;
		try {
			await a.playEffect("dual-rumble", pulse);
		} catch {
			return;
		}
	}
}

// ---------------------------------------------------------------- poller

type ActionHandler = (action: GamepadAction) => void;
type AxisHandler = (delta: { x: number; y: number }) => void;

// One poller for the whole app. Review mode alone has two subscribers
// (QuestionCard owns answering, Question owns navigation); a loop each would
// read the same press twice and fight over edge state.
const actionSubs = new Set<ActionHandler>();
const axisSubs = new Set<AxisHandler>();
const connectionSubs = new Set<() => void>();

let rafId = 0;
let lastTs = 0;
let states = new Map<number, ButtonState>();

function pads(): (Gamepad | null)[] {
	if (typeof navigator === "undefined" || !navigator.getGamepads) return [];
	try {
		return Array.from(navigator.getGamepads());
	} catch {
		return [];
	}
}

export function activeGamepad(): Gamepad | null {
	for (const gp of pads()) if (gp?.connected) return gp;
	return null;
}

export function isGamepadConnected(): boolean {
	return activeGamepad() !== null;
}

/** Non-null when a pad is connected but not in standard mapping — the 8BitDo
 *  mode-switch case, where the index table above points at the wrong buttons. */
export function nonStandardMapping(): string | null {
	const gp = activeGamepad();
	if (!gp) return null;
	return gp.mapping === "standard" ? null : gp.id || "unknown";
}

/** The pad's self-reported name, trimmed of the vendor/product hex the browser
 *  appends — "8BitDo Pro 2" reads better than the 40-char raw id. */
export function gamepadName(): string | null {
	const raw = activeGamepad()?.id;
	if (!raw) return null;
	const cleaned = raw
		.replace(/\((?:STANDARD GAMEPAD )?Vendor:.*$/i, "")
		.replace(/\([0-9a-f]{4}-[0-9a-f]{4}-.*$/i, "")
		.trim();
	return cleaned || raw;
}

function tick(ts: number) {
	rafId = requestAnimationFrame(tick);
	const dt = lastTs ? Math.min(ts - lastTs, 100) : 16;
	lastTs = ts;

	const gp = activeGamepad();
	if (!gp) return;

	for (const [idx, action] of Object.entries(BUTTON_ACTIONS)) {
		const i = Number(idx);
		const btn = gp.buttons[i];
		const { next, fire } = stepButton(
			states.get(i) ?? IDLE_BUTTON,
			!!btn?.pressed,
			ts,
			REPEATABLE.has(action),
		);
		states.set(i, next);
		if (fire) for (const fn of actionSubs) fn(action);
	}

	if (axisSubs.size > 0) {
		const x = axisScrollDelta(gp.axes[0] ?? 0, dt);
		const y = axisScrollDelta(gp.axes[1] ?? 0, dt);
		if (x !== 0 || y !== 0) for (const fn of axisSubs) fn({ x, y });
	}
}

// Seed the edge detector with whatever is already held, so starting the poller
// never manufactures a press.
//
// This is not a nicety. Route changes unsubscribe the old page before the new
// one subscribes, so `actionSubs` hits zero for an instant and the loop stops.
// A real button press lasts 100ms+ and easily spans that gap — so on restart
// the still-held button reads as a fresh edge and the *new* page acts on the
// same physical press. Observed: START on a question page shot straight through
// 年度列表 and landed on /review, because YearList's START fired too.
function primeStates() {
	states = new Map();
	const gp = activeGamepad();
	if (!gp) return;
	const t = typeof performance !== "undefined" ? performance.now() : 0;
	for (const idx of Object.keys(BUTTON_ACTIONS)) {
		const i = Number(idx);
		if (gp.buttons[i]?.pressed)
			states.set(i, { down: true, repeatAt: t + REPEAT_DELAY_MS });
	}
}

// Poll only while something is listening AND a pad is attached — on a study
// site that is almost never, and an always-on rAF loop is pure battery burn.
// Chrome withholds pads from getGamepads() until the first button press, but
// `gamepadconnected` fires at exactly that moment, so nothing is missed.
function sync() {
	const want =
		(actionSubs.size > 0 || axisSubs.size > 0) && isGamepadConnected();
	if (want && !rafId) {
		lastTs = 0;
		primeStates();
		rafId = requestAnimationFrame(tick);
	} else if (!want && rafId) {
		cancelAnimationFrame(rafId);
		rafId = 0;
	}
}

if (typeof window !== "undefined") {
	const onChange = () => {
		sync();
		for (const fn of connectionSubs) fn();
	};
	window.addEventListener("gamepadconnected", onChange);
	window.addEventListener("gamepaddisconnected", onChange);
}

export function subscribeActions(fn: ActionHandler): () => void {
	actionSubs.add(fn);
	sync();
	return () => {
		actionSubs.delete(fn);
		sync();
	};
}

export function subscribeAxis(fn: AxisHandler): () => void {
	axisSubs.add(fn);
	sync();
	return () => {
		axisSubs.delete(fn);
		sync();
	};
}

export function subscribeConnection(fn: () => void): () => void {
	connectionSubs.add(fn);
	return () => {
		connectionSubs.delete(fn);
	};
}
