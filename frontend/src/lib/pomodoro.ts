// Pomodoro timer logic for the app-wide FAB. Kept free of React so the phase
// machine and the settings clamping can be unit-tested (node --test).
//
// Settings live in localStorage, not on the server: this is a per-device study
// preference (how long *this* sitting should be), not account state — someone
// reading on a phone during a commute wants a different rhythm than at a desk.

export type Phase = 'focus' | 'short' | 'long';

export type PomodoroSettings = {
  /** 專注時長 (minutes) */
  focusMin: number;
  /** 短休息 (minutes) */
  shortMin: number;
  /** 長休息 (minutes) */
  longMin: number;
  /** A long break replaces the short one every N completed focus rounds. */
  longEvery: number;
  /** Roll straight into the next phase instead of waiting for a click. */
  autoStart: boolean;
  /** Chime when a phase ends. */
  sound: boolean;
  /** Browser notification when a phase ends (needs permission). */
  notify: boolean;
};

export const DEFAULT_SETTINGS: PomodoroSettings = {
  focusMin: 25,
  shortMin: 5,
  longMin: 15,
  longEvery: 4,
  autoStart: false,
  sound: true,
  notify: false,
};

// Every numeric field is user-typed, so every one is clamped. Bounds are wide
// (a 90-minute 深度複習 block is legitimate) but finite — a stray "999" would
// otherwise render a timer nobody can wait out.
const BOUNDS: Record<'focusMin' | 'shortMin' | 'longMin' | 'longEvery', [number, number]> = {
  focusMin: [1, 180],
  shortMin: [1, 60],
  longMin: [1, 120],
  longEvery: [1, 12],
};

export const SETTING_BOUNDS = BOUNDS;

function clampInt(v: unknown, [lo, hi]: [number, number], fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function clampSettings(raw: unknown): PomodoroSettings {
  const s = (raw ?? {}) as Partial<PomodoroSettings>;
  return {
    focusMin: clampInt(s.focusMin, BOUNDS.focusMin, DEFAULT_SETTINGS.focusMin),
    shortMin: clampInt(s.shortMin, BOUNDS.shortMin, DEFAULT_SETTINGS.shortMin),
    longMin: clampInt(s.longMin, BOUNDS.longMin, DEFAULT_SETTINGS.longMin),
    longEvery: clampInt(s.longEvery, BOUNDS.longEvery, DEFAULT_SETTINGS.longEvery),
    autoStart: typeof s.autoStart === 'boolean' ? s.autoStart : DEFAULT_SETTINGS.autoStart,
    sound: typeof s.sound === 'boolean' ? s.sound : DEFAULT_SETTINGS.sound,
    notify: typeof s.notify === 'boolean' ? s.notify : DEFAULT_SETTINGS.notify,
  };
}

export function phaseMs(phase: Phase, s: PomodoroSettings): number {
  const min = phase === 'focus' ? s.focusMin : phase === 'short' ? s.shortMin : s.longMin;
  return min * 60_000;
}

/**
 * What follows the phase that just finished. A finished 專注 increments the
 * round counter and earns a 長休息 on every `longEvery`-th round; a finished
 * break always returns to 專注 without touching the counter.
 */
export function nextPhase(
  phase: Phase,
  completedFocus: number,
  s: PomodoroSettings,
): { phase: Phase; completedFocus: number } {
  if (phase !== 'focus') return { phase: 'focus', completedFocus };
  const done = completedFocus + 1;
  return { phase: done % s.longEvery === 0 ? 'long' : 'short', completedFocus: done };
}

export const PHASE_LABEL: Record<Phase, string> = {
  focus: '專注',
  short: '短休息',
  long: '長休息',
};

/** ms → "MM:SS", rounding up so a fresh 25:00 never paints as 24:59. */
export function fmt(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const KEY = 'pomodoro:settings:v1';

export function loadSettings(): PomodoroSettings {
  try {
    return clampSettings(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: PomodoroSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — the timer still works for this sitting */
  }
}
