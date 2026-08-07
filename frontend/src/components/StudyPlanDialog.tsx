import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarPlus, X, RotateCcw } from 'lucide-react';
import { api, ApiError } from '../lib/api';

// 讀書計畫產生器的對話。設計:
// docs/plans/2026-08-07-study-plan-generator-design.md
//
// 專案沒有 shadcn / Radix,message-scroller 那種「訊息一則一則往下長」的感覺
// 自己刻:一個可捲動容器 + 每答完一題 append 兩則(提問 + 答案回顯)。回答一律
// 用選項或數字輸入,**沒有自由文字** —— 七個答案全部要餵進 worker 的純函式,
// 自由文字只會製造解析問題。
//
// 排程不在這裡算。前端只顯示 /api/study-plan/preview 回來的結果 —— 兩邊各算
// 一次,必然會在某個邊界條件上算出不同數字。

type YearStat = { year: number; total: number; completed: number; accuracy: number | null };

export type PlanInput = {
  years: number[];
  completedOverride: number | null;
  minutesPerDay: number;
  secondsPerQuestion: number;
  rounds: number;
  mockExams: number;
  restSunday: boolean;
  studyStart: string;
  studyEnd: string;
};

type Slice = { year: number; round: number; n: number; from: number | null; to: number | null };
type DayPlan = {
  date: string;
  kind: 'study' | 'mock' | 'rest' | 'exam';
  count: number;
  slices: Slice[];
  label: string;
};
type WeekPlan = { week_start: string; days: DayPlan[]; total: number };
type Suggestion =
  | { kind: 'more_per_day'; extra_questions: number; extra_minutes: number }
  | { kind: 'drop_year'; year: number; questions: number }
  | { kind: 'fewer_rounds'; rounds: number };

type PlanResult = {
  exam_date: string;
  days_left: number;
  daily_capacity: number;
  available_days: number;
  demand: number;
  demand_by_round: number[];
  scheduled: number;
  shortfall: number;
  weeks: WeekPlan[];
  mock_dates: string[];
  suggestions: Suggestion[];
};

type Bootstrap = {
  today: string;
  exam_date: string | null;
  years: YearStat[];
  total: number;
  completed: number;
  suggested_seconds: number;
  saved: PlanInput | null;
};

const STEPS = ['progress', 'years', 'minutes', 'seconds', 'rounds', 'mocks', 'time'] as const;
type StepId = (typeof STEPS)[number];

const MINUTE_CHOICES = [30, 60, 90, 120];
const SECOND_CHOICES = [60, 90, 120];

function suggestionText(s: Suggestion): string {
  if (s.kind === 'more_per_day')
    return `每天多 ${s.extra_questions} 題(約多花 ${s.extra_minutes} 分鐘)`;
  if (s.kind === 'drop_year') return `不寫 ${s.year} 年(少 ${s.questions} 題)`;
  return `改成 ${s.rounds} 輪`;
}

const bubbleSys =
  'max-w-[85%] rounded-lg rounded-tl-sm bg-ink-50 dark:bg-ink-700/60 px-3.5 py-2.5 text-ink-800 dark:text-ink-100';
const bubbleMe =
  'max-w-[85%] self-end rounded-lg rounded-tr-sm bg-accent/10 dark:bg-accent/25 px-3.5 py-2 text-ink-800 dark:text-ink-50';
const chip =
  'px-3 py-1.5 rounded-full border text-sm transition border-ink-200 dark:border-ink-600 hover:border-accent text-ink-700 dark:text-ink-200';
const chipOn = 'px-3 py-1.5 rounded-full border text-sm transition border-accent bg-accent/10 text-accent dark:text-accent-light';

export function StudyPlanDialog({ onClose }: { onClose: () => void }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [input, setInput] = useState<PlanInput | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [coaching, setCoaching] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 草稿:年份與數字在按下確定之前只動草稿,不動 input —— 否則每點一個年份
  // chip 都會觸發一次預覽請求。
  const [draftYears, setDraftYears] = useState<number[]>([]);
  const [draftNumber, setDraftNumber] = useState('');
  const [draftStart, setDraftStart] = useState('21:00');
  const [draftEnd, setDraftEnd] = useState('22:30');

  useEffect(() => {
    api
      .get<Bootstrap>('/api/study-plan')
      .then((b) => {
        setBoot(b);
        const base: PlanInput = b.saved ?? {
          years: b.years.map((y) => y.year),
          completedOverride: null,
          minutesPerDay: 60,
          secondsPerQuestion: b.suggested_seconds,
          rounds: 2,
          mockExams: 4,
          restSunday: true,
          studyStart: '21:00',
          studyEnd: '22:30',
        };
        setInput(base);
        setDraftYears(base.years);
        setDraftStart(base.studyStart);
        setDraftEnd(base.studyEnd);
      })
      .catch((e) =>
        setError(e instanceof ApiError ? `讀取進度失敗 (${e.status})` : String(e))
      );
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [step, plan, busy]);

  const runPreview = useCallback(
    async (next: PlanInput, wantCoaching: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const r = await api.post<{ plan: PlanResult; coaching: string | null }>(
          '/api/study-plan/preview',
          { input: next, want_coaching: wantCoaching }
        );
        setPlan(r.plan);
        if (wantCoaching) setCoaching(r.coaching);
        // 只存問卷答案,不存排程結果 —— 排程隨時可重算。
        api.put('/api/study-plan', next).catch(() => {});
      } catch (e) {
        if (e instanceof ApiError && e.data?.error === 'no_exam_date') {
          setError('尚未設定考試日期,無法排程。');
        } else if (e instanceof ApiError) {
          setError(`產生失敗 (${e.status})`);
        } else {
          setError(String(e));
        }
      } finally {
        setBusy(false);
      }
    },
    []
  );

  function answer(patch: Partial<PlanInput>) {
    if (!input) return;
    const next = { ...input, ...patch };
    setInput(next);
    const done = step + 1 >= STEPS.length;
    setStep(step + 1);
    if (done) void runPreview(next, true);
  }

  /** 回到某一題重答。後面的答案保留(它們彼此獨立),只是重新走一遍。 */
  function backTo(i: number) {
    setStep(i);
    setPlan(null);
  }

  async function applySuggestion(s: Suggestion) {
    if (!input || !boot) return;
    let next = input;
    if (s.kind === 'more_per_day') {
      next = { ...input, minutesPerDay: Math.min(720, input.minutesPerDay + s.extra_minutes) };
    } else if (s.kind === 'drop_year') {
      next = { ...input, years: input.years.filter((y) => y !== s.year) };
    } else {
      next = { ...input, rounds: s.rounds };
    }
    setInput(next);
    await runPreview(next, false);
  }

  async function download(format: 'html' | 'ics') {
    if (!input) return;
    setBusy(true);
    try {
      await api.download(`/api/study-plan/export?format=${format}`, {
        input,
        coaching: coaching ?? undefined,
      });
    } catch (e) {
      setError(e instanceof ApiError ? `下載失敗 (${e.status})` : String(e));
    } finally {
      setBusy(false);
    }
  }

  const current: StepId | null = step < STEPS.length ? STEPS[step] : null;

  function promptOf(id: StepId): string {
    if (!boot) return '';
    switch (id) {
      case 'progress':
        return `目前系統紀錄你做過 ${boot.completed} / ${boot.total} 題。這個數字對嗎?`;
      case 'years':
        return '要寫哪幾年?';
      case 'minutes':
        return '每天大概可以投入多少時間?';
      case 'seconds':
        return `一題大概要花多久?(你近期的實測中位數是 ${boot.suggested_seconds} 秒)`;
      case 'rounds':
        return '想跑幾輪?第二輪起只排錯題。';
      case 'mocks':
        return '考前想排幾場全真模擬?每場佔一整天。';
      case 'time':
        return '通常幾點讀書?這只影響匯入行事曆的時間。';
    }
  }

  function answerOf(id: StepId): string {
    if (!input || !boot) return '';
    switch (id) {
      case 'progress':
        return input.completedOverride == null
          ? `以系統紀錄為準(${boot.completed} 題)`
          : `我做過 ${input.completedOverride} 題`;
      case 'years':
        return input.years.length === boot.years.length
          ? `全部 ${input.years.length} 年`
          : input.years.length === 0
            ? '一年都不寫'
            : input.years.join('、') + ' 年';
      case 'minutes':
        return `每天 ${input.minutesPerDay} 分鐘`;
      case 'seconds':
        return `一題 ${input.secondsPerQuestion} 秒`;
      case 'rounds':
        return `${input.rounds} 輪`;
      case 'mocks':
        return input.mockExams === 0 ? '不排模擬考' : `${input.mockExams} 場`;
      case 'time':
        return `${input.studyStart} – ${input.studyEnd}`;
    }
  }

  function controls(id: StepId) {
    if (!boot || !input) return null;
    switch (id) {
      case 'progress':
        return (
          <div className="flex flex-wrap gap-2 items-center">
            <button className={chip} onClick={() => answer({ completedOverride: null })}>
              對,以系統紀錄為準
            </button>
            <span className="inline-flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={boot.total}
                value={draftNumber}
                placeholder="我做過…"
                onChange={(e) => setDraftNumber(e.target.value)}
                className="w-24 px-2 py-1.5 rounded border border-ink-200 dark:border-ink-600 bg-transparent text-sm"
                aria-label="已完成題數"
              />
              <button
                className={chip}
                disabled={draftNumber === ''}
                onClick={() => answer({ completedOverride: Number(draftNumber) })}
              >
                題
              </button>
            </span>
          </div>
        );
      case 'years': {
        const all = boot.years.map((y) => y.year);
        return (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {boot.years.map((y) => {
                const on = draftYears.includes(y.year);
                return (
                  <button
                    key={y.year}
                    className={on ? chipOn : chip}
                    onClick={() =>
                      setDraftYears(
                        on ? draftYears.filter((v) => v !== y.year) : [...draftYears, y.year]
                      )
                    }
                  >
                    {y.year}
                    <span className="ml-1 text-xs opacity-60">剩 {y.total - y.completed}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button className={chip} onClick={() => setDraftYears(all)}>
                全選
              </button>
              <button className={chip} onClick={() => setDraftYears([])}>
                全不選
              </button>
              <button
                className="px-3 py-1.5 rounded-full text-sm bg-accent text-white hover:bg-accent-dark transition"
                onClick={() => answer({ years: [...draftYears].sort((a, b) => b - a) })}
              >
                就這些
              </button>
            </div>
          </div>
        );
      }
      case 'minutes':
        return (
          <div className="flex flex-wrap gap-2">
            {MINUTE_CHOICES.map((m) => (
              <button key={m} className={chip} onClick={() => answer({ minutesPerDay: m })}>
                {m} 分鐘
              </button>
            ))}
          </div>
        );
      case 'seconds':
        return (
          <div className="flex flex-wrap gap-2">
            <button
              className={chip}
              onClick={() => answer({ secondsPerQuestion: boot.suggested_seconds })}
            >
              就用 {boot.suggested_seconds} 秒
            </button>
            {SECOND_CHOICES.filter((s) => s !== boot.suggested_seconds).map((s) => (
              <button key={s} className={chip} onClick={() => answer({ secondsPerQuestion: s })}>
                {s} 秒
              </button>
            ))}
          </div>
        );
      case 'rounds':
        return (
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3].map((r) => (
              <button key={r} className={chip} onClick={() => answer({ rounds: r })}>
                {r} 輪
              </button>
            ))}
          </div>
        );
      case 'mocks':
        return (
          <div className="flex flex-wrap gap-2">
            {[0, 2, 4, 6].map((m) => (
              <button key={m} className={chip} onClick={() => answer({ mockExams: m })}>
                {m === 0 ? '不排' : `${m} 場`}
              </button>
            ))}
          </div>
        );
      case 'time':
        return (
          <div className="flex flex-wrap gap-2 items-center">
            <input
              type="time"
              value={draftStart}
              onChange={(e) => setDraftStart(e.target.value)}
              className="px-2 py-1.5 rounded border border-ink-200 dark:border-ink-600 bg-transparent text-sm"
              aria-label="開始時間"
            />
            <span className="text-ink-400">–</span>
            <input
              type="time"
              value={draftEnd}
              onChange={(e) => setDraftEnd(e.target.value)}
              className="px-2 py-1.5 rounded border border-ink-200 dark:border-ink-600 bg-transparent text-sm"
              aria-label="結束時間"
            />
            <label className="inline-flex items-center gap-1.5 text-sm text-ink-600 dark:text-ink-300 ml-1">
              <input
                type="checkbox"
                className="accent-[#a8442a]"
                checked={input.restSunday}
                onChange={(e) => setInput({ ...input, restSunday: e.target.checked })}
              />
              週日休息
            </label>
            <button
              className="px-3 py-1.5 rounded-full text-sm bg-accent text-white hover:bg-accent-dark transition"
              onClick={() => answer({ studyStart: draftStart, studyEnd: draftEnd })}
            >
              產生計畫
            </button>
          </div>
        );
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="生成讀書計畫"
        className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-paper w-full max-w-lg overflow-hidden flex flex-col max-h-[calc(100dvh-2rem)]"
      >
        <header className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-ink-100 dark:border-ink-700">
          <h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 inline-flex items-center gap-2">
            <CalendarPlus size={17} className="text-accent" />
            生成讀書計畫
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
            aria-label="關閉"
          >
            <X size={18} />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 flex flex-col gap-2.5 text-sm">
          {!boot && !error && <p className="text-ink-500">正在讀取你的進度…</p>}

          {STEPS.slice(0, step).map((id, i) => (
            <div key={id} className="flex flex-col gap-1.5">
              <p className={bubbleSys}>{promptOf(id)}</p>
              <button
                className={`${bubbleMe} text-left hover:ring-1 hover:ring-accent/40`}
                onClick={() => backTo(i)}
                title="點一下重答這題"
              >
                {answerOf(id)}
              </button>
            </div>
          ))}

          {current && boot && (
            <div className="flex flex-col gap-2.5">
              <p className={bubbleSys}>{promptOf(current)}</p>
              {controls(current)}
            </div>
          )}

          {busy && <p className="text-ink-500">排程中…</p>}

          {error && (
            <p className="rounded border border-accent/40 bg-accent/5 px-3 py-2 text-accent">
              {error}
            </p>
          )}

          {plan && !busy && <PlanSummary plan={plan} coaching={coaching} onApply={applySuggestion} />}

          <div ref={bottomRef} />
        </div>

        {plan && (
          <footer className="shrink-0 flex flex-wrap gap-2 items-center px-5 py-3 border-t border-ink-100 dark:border-ink-700">
            <button
              disabled={busy}
              onClick={() => download('html')}
              className="px-3 py-1.5 rounded text-sm bg-accent text-white hover:bg-accent-dark disabled:opacity-50 transition"
            >
              下載計畫表 (HTML)
            </button>
            <button
              disabled={busy}
              onClick={() => download('ics')}
              className="px-3 py-1.5 rounded text-sm border border-ink-200 dark:border-ink-600 hover:border-accent transition"
            >
              匯入行事曆 (.ics)
            </button>
            <button
              onClick={() => {
                setStep(0);
                setPlan(null);
                setCoaching(null);
              }}
              className="ml-auto inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-800 dark:hover:text-ink-200"
            >
              <RotateCcw size={13} /> 重新回答
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
}

function PlanSummary({
  plan,
  coaching,
  onApply,
}: {
  plan: PlanResult;
  coaching: string | null;
  onApply: (s: Suggestion) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat n={plan.days_left} label="天後考試" />
        <Stat n={plan.daily_capacity} label="每天題數上限" />
        <Stat n={plan.scheduled} label="已排入題數" />
      </div>

      {coaching && (
        <p className="border-l-2 border-accent pl-3 text-ink-700 dark:text-ink-200">{coaching}</p>
      )}

      {plan.shortfall > 0 ? (
        <div className="rounded border border-accent/50 bg-accent/5 px-3 py-2.5 space-y-2">
          <p className="text-ink-800 dark:text-ink-100">
            以這個速度,到考前<strong className="text-accent"> 差 {plan.shortfall} 題</strong>。
          </p>
          <div className="flex flex-wrap gap-2">
            {plan.suggestions.map((s) => (
              <button key={s.kind} className={chip} onClick={() => onApply(s)}>
                {suggestionText(s)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-ink-600 dark:text-ink-300">
          排得完 —— {plan.demand_by_round.map((n, i) => `第 ${i + 1} 輪 ${n} 題`).join(' · ')}
          {plan.mock_dates.length > 0 && ` · 全真模擬 ${plan.mock_dates.length} 場`}
        </p>
      )}

      <div className="rounded border border-ink-100 dark:border-ink-700 divide-y divide-ink-100 dark:divide-ink-700 max-h-52 overflow-y-auto">
        {plan.weeks.map((w) => (
          <div key={w.week_start} className="flex justify-between px-3 py-1.5">
            <span className="text-ink-600 dark:text-ink-300">{w.week_start} 起</span>
            <span className="font-mono tabular-nums text-ink-800 dark:text-ink-100">
              {w.total} 題
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded border border-ink-100 dark:border-ink-700 py-2">
      <div className="font-mono tabular-nums text-xl text-accent">{n}</div>
      <div className="text-xs text-ink-500 dark:text-ink-400">{label}</div>
    </div>
  );
}
