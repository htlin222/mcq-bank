import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Timer,
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  Settings2,
  X,
  Gamepad2,
} from 'lucide-react';
import {
  PHASE_LABEL,
  SETTING_BOUNDS,
  clampSettings,
  fmt,
  isTimerPath,
  loadSettings,
  nextPhase,
  phaseMs,
  saveSettings,
  type Phase,
  type PomodoroSettings,
} from '../lib/pomodoro';

// 番茄鐘 FAB for 複習模式. Mounted app-wide but only *shown* on the 複習 routes:
// a detour to 全真 or 收藏 mid-session shouldn't silently kill a running timer,
// so the hooks keep ticking while the button hides.
//
// The countdown is derived from an absolute `endsAt` timestamp rather than
// decremented per tick — a throttled background tab fires setInterval far less
// often than every 250ms, and a decrementing timer would drift by minutes.

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

export function PomodoroFab() {
  const { pathname } = useLocation();
  const visible = isTimerPath(pathname);

  const [settings, setSettings] = useState<PomodoroSettings>(() => loadSettings());
  const [phase, setPhase] = useState<Phase>('focus');
  const [completedFocus, setCompletedFocus] = useState(0);
  const [running, setRunning] = useState(false);
  // Exactly one of these drives the display: `endsAt` while running, the frozen
  // `leftMs` while paused.
  const [endsAt, setEndsAt] = useState(0);
  const [leftMs, setLeftMs] = useState(() => phaseMs('focus', settings));
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const remaining = running ? Math.max(0, endsAt - now) : leftMs;
  const onBreak = phase !== 'focus';
  const total = phaseMs(phase, settings);
  const progress = total > 0 ? 1 - Math.min(1, remaining / total) : 0;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  const chime = useCallback(() => {
    if (!settings.sound) return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.65);
      osc.onended = () => void ctx.close();
    } catch {
      /* autoplay policy / no WebAudio — the visual state is still correct */
    }
  }, [settings.sound]);

  // `startNext` decides whether the next phase runs immediately: a phase that
  // ran out obeys 自動接續, while a manual 跳過 just carries the current
  // running/paused state over — skipping out of a live tomato shouldn't
  // silently park you on a paused break.
  const advance = useCallback(
    (startNext: boolean) => {
      const nx = nextPhase(phase, completedFocus, settings);
      setPhase(nx.phase);
      setCompletedFocus(nx.completedFocus);
      const ms = phaseMs(nx.phase, settings);
      setLeftMs(ms);
      setRunning(startNext);
      if (startNext) setEndsAt(Date.now() + ms);
    },
    [phase, completedFocus, settings],
  );

  // Phase ended.
  useEffect(() => {
    if (!running || remaining > 0) return;
    chime();
    if (settings.notify && 'Notification' in window && Notification.permission === 'granted') {
      const done = PHASE_LABEL[phase];
      const nx = nextPhase(phase, completedFocus, settings);
      try {
        new Notification(`${done}結束`, { body: `接著是${PHASE_LABEL[nx.phase]}` });
      } catch {
        /* some browsers only allow notifications from a service worker */
      }
    }
    advance(settings.autoStart);
  }, [running, remaining, chime, advance, settings, phase, completedFocus]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function start() {
    setEndsAt(Date.now() + leftMs);
    setNow(Date.now());
    setRunning(true);
  }

  function pause() {
    setLeftMs(Math.max(0, endsAt - Date.now()));
    setRunning(false);
  }

  function reset() {
    setRunning(false);
    setLeftMs(phaseMs(phase, settings));
  }

  function switchPhase(p: Phase) {
    setRunning(false);
    setPhase(p);
    setLeftMs(phaseMs(p, settings));
  }

  function patch(p: Partial<PomodoroSettings>) {
    const next = clampSettings({ ...settings, ...p });
    setSettings(next);
    saveSettings(next);
    // Re-length the *current* phase only while it is idle; changing 專注時長
    // mid-tomato would otherwise yank time out from under the countdown.
    if (!running) setLeftMs(phaseMs(phase, next));
  }

  // Only ever stores `true` once the browser has actually granted permission,
  // so the checkbox can't sit checked while nothing would ever fire.
  function toggleNotify(on: boolean) {
    if (!on || !('Notification' in window)) return patch({ notify: false });
    if (Notification.permission === 'granted') return patch({ notify: true });
    if (Notification.permission === 'denied') return patch({ notify: false });
    void Notification.requestPermission().then((perm) =>
      patch({ notify: perm === 'granted' }),
    );
  }

  const untilLong = useMemo(() => {
    const into = completedFocus % settings.longEvery;
    return settings.longEvery - into;
  }, [completedFocus, settings.longEvery]);

  if (!visible) return null;

  return (
    <div
      ref={panelRef}
      className="fixed right-4 sm:right-6 z-30 bottom-[calc(var(--bottom-nav-h)+1rem)] sm:bottom-6 flex flex-col items-end gap-2"
    >
      {open && (
        <div className="w-72 max-h-[calc(100dvh-var(--bottom-nav-h)-9rem)] overflow-y-auto rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-paper p-4 animate-fade-in">
          <div className="flex items-center gap-1 mb-3">
            {(['focus', 'short', 'long'] as Phase[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => switchPhase(p)}
                aria-pressed={phase === p}
                className={
                  'px-2 py-1 rounded text-xs transition ' +
                  (phase === p
                    ? 'bg-accent text-white'
                    : 'text-ink-500 dark:text-ink-400 hover:bg-accent/10 hover:text-accent')
                }
              >
                {PHASE_LABEL[p]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              aria-pressed={showSettings}
              aria-label="番茄鐘設定"
              className="ml-auto p-1.5 rounded text-ink-400 hover:text-accent hover:bg-accent/10"
            >
              <Settings2 size={15} />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="關閉"
              className="p-1.5 rounded text-ink-400 hover:text-accent hover:bg-accent/10"
            >
              <X size={15} />
            </button>
          </div>

          <div className="text-center font-mono text-4xl tabular-nums text-ink-900 dark:text-ink-100">
            {fmt(remaining)}
          </div>
          <p className="text-center text-[11px] text-ink-400 dark:text-ink-500 mt-1">
            已完成 {completedFocus} 輪專注 · 再 {untilLong} 輪長休息
          </p>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={running ? pause : start}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded bg-accent hover:bg-accent-dark text-white px-3 py-2 text-sm font-medium"
            >
              {running ? (
                <>
                  <Pause size={15} /> 暫停
                </>
              ) : (
                <>
                  <Play size={15} /> 開始
                </>
              )}
            </button>
            <button
              type="button"
              onClick={reset}
              aria-label="重設"
              title="重設這一段"
              className="p-2 rounded text-ink-500 dark:text-ink-400 hover:text-accent hover:bg-accent/10"
            >
              <RotateCcw size={16} />
            </button>
            <button
              type="button"
              onClick={() => advance(running)}
              aria-label="跳過"
              title="跳到下一段"
              className="p-2 rounded text-ink-500 dark:text-ink-400 hover:text-accent hover:bg-accent/10"
            >
              <SkipForward size={16} />
            </button>
          </div>

          {/* 2048 的入口。休息時段給它份量,專注時段收成一行淡字 —— 同一個
              連結兩種強度,而不是在專注時把它藏起來(藏起來只會讓人以為壞了)。 */}
          <Link
            to="/play"
            onClick={() => setOpen(false)}
            className={
              'mt-2 flex items-center justify-center gap-1.5 rounded px-3 py-2 text-sm transition ' +
              (onBreak
                ? 'border border-accent/40 text-accent hover:bg-accent/10'
                : 'text-ink-400 dark:text-ink-500 hover:text-accent hover:bg-accent/10')
            }
          >
            <Gamepad2 size={15} />
            {onBreak ? '休息一下,玩 2048' : '玩 2048'}
          </Link>

          {showSettings && (
            <div className="mt-4 pt-3 border-t border-ink-100 dark:border-ink-700 space-y-2">
              <NumField
                label="專注時長"
                unit="分"
                value={settings.focusMin}
                bounds={SETTING_BOUNDS.focusMin}
                onChange={(v) => patch({ focusMin: v })}
              />
              <NumField
                label="短休息"
                unit="分"
                value={settings.shortMin}
                bounds={SETTING_BOUNDS.shortMin}
                onChange={(v) => patch({ shortMin: v })}
              />
              <NumField
                label="長休息"
                unit="分"
                value={settings.longMin}
                bounds={SETTING_BOUNDS.longMin}
                onChange={(v) => patch({ longMin: v })}
              />
              <NumField
                label="長休息間隔"
                unit="輪"
                value={settings.longEvery}
                bounds={SETTING_BOUNDS.longEvery}
                onChange={(v) => patch({ longEvery: v })}
              />
              <CheckField
                label="自動接續下一段"
                checked={settings.autoStart}
                onChange={(v) => patch({ autoStart: v })}
              />
              <CheckField
                label="結束提示音"
                checked={settings.sound}
                onChange={(v) => patch({ sound: v })}
              />
              <CheckField
                label="瀏覽器通知"
                checked={settings.notify}
                onChange={toggleNotify}
              />
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={running ? `番茄鐘 ${PHASE_LABEL[phase]} 剩 ${fmt(remaining)}` : '番茄鐘'}
        aria-expanded={open}
        className={
          'relative h-14 w-14 rounded-full shadow-paper border transition grid place-items-center ' +
          (running
            ? 'bg-accent border-accent text-white'
            : 'bg-white dark:bg-ink-800 border-ink-200 dark:border-ink-700 text-ink-500 dark:text-ink-400 hover:text-accent hover:border-accent')
        }
      >
        {/* Progress ring — starts at 12 o'clock and sweeps clockwise. */}
        <svg
          viewBox="0 0 60 60"
          className="absolute inset-0 h-full w-full -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="30"
            cy="30"
            r={RING_R}
            fill="none"
            strokeWidth="3"
            className={running ? 'stroke-white/25' : 'stroke-transparent'}
          />
          <circle
            cx="30"
            cy="30"
            r={RING_R}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - progress)}
            className={running ? 'stroke-white' : 'stroke-transparent'}
          />
        </svg>
        {running ? (
          <span className="font-mono text-[13px] tabular-nums leading-none">
            {fmt(remaining)}
          </span>
        ) : (
          <Timer size={22} />
        )}
      </button>
    </div>
  );
}

/**
 * Number input that lets you actually type. Clamping on every keystroke would
 * rewrite the field mid-edit — clearing "25" yields Number("") === 0, snaps to
 * the minimum, and "30" comes out as 130 — so the draft text is local, only
 * in-range values are committed as you type, and blur clamps whatever is left.
 */
function NumField({
  label,
  unit,
  value,
  bounds,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  bounds: [number, number];
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [lo, hi] = bounds;
  return (
    <label className="flex items-center gap-2 text-sm text-ink-600 dark:text-ink-300">
      <span className="flex-1">{label}</span>
      <input
        type="number"
        min={lo}
        max={hi}
        value={draft ?? String(value)}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          const n = Number(t);
          if (/^\d+$/.test(t) && n >= lo && n <= hi) onChange(n);
        }}
        onBlur={() => {
          if (draft !== null) {
            const n = Number(draft);
            onChange(Number.isFinite(n) && draft.trim() !== '' ? n : value);
            setDraft(null);
          }
        }}
        className="w-16 px-2 py-1 text-right rounded border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 text-ink-800 dark:text-ink-100 focus:outline-none focus:border-accent"
      />
      <span className="w-4 text-xs text-ink-400 dark:text-ink-500">{unit}</span>
    </label>
  );
}

function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-600 dark:text-ink-300 cursor-pointer">
      <span className="flex-1">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-accent"
      />
    </label>
  );
}
