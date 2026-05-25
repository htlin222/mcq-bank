import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Pause, Play, ChevronLeft, ChevronRight, AlertTriangle, Flag } from 'lucide-react';
import { api } from '../lib/api';

type YearMeta = { year: number; count: number };

type ExamQuestion = {
  id: string;
  number: number;
  stem: string;
  options: Record<string, string>;
  chosen?: string | null;
};

type ExamState = {
  session_id: string;
  started_at: number;
  elapsed_ms: number;
  running_since: number | null;  // null = paused
  cap_ms: number;                // 100 * 60 * 1000
  questions: ExamQuestion[];
};

export function Exam() {
  const { sid } = useParams<{ sid: string }>();
  if (sid) return <ExamInProgress sessionId={sid} />;
  return <ExamStart />;
}

type Group = '內科' | '共同';
const GROUP_COUNTS: Record<Group, number> = { '內科': 70, '共同': 30 };

function ExamStart() {
  const [years, setYears] = useState<YearMeta[]>([]);
  const [starting, setStarting] = useState<number | null>(null);
  const [groups, setGroups] = useState<Set<Group>>(new Set(['內科', '共同']));
  const navigate = useNavigate();

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
  }, []);

  const totalCount =
    (groups.has('內科') ? GROUP_COUNTS['內科'] : 0) +
    (groups.has('共同') ? GROUP_COUNTS['共同'] : 0);

  function toggleGroup(g: Group) {
    setGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }

  async function start(year: number) {
    if (starting || groups.size === 0) return;
    setStarting(year);
    try {
      const s = await api.post<ExamState>('/api/exam/start', {
        year,
        groups: [...groups],
      });
      sessionStorage.setItem(`exam-${s.session_id}`, JSON.stringify(s));
      navigate(`/exam/${s.session_id}`);
    } finally {
      setStarting(null);
    }
  }

  const canStart = groups.size > 0;

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-2">全真作答</h1>
      <p className="text-ink-500 dark:text-ink-400 text-sm mb-6">
        {totalCount > 0 ? `${totalCount} 分鐘模擬考` : '選擇科別'} · 可中途暫停離開、稍後續答 · 完賽看分數與錯題回顧
      </p>

      {/* 科別選擇 */}
      <div className="mb-8 flex flex-wrap gap-2 items-center">
        <span className="text-xs uppercase tracking-wider text-ink-400 dark:text-ink-500 mr-1">科別</span>
        <GroupToggle group="內科" active={groups.has('內科')} onClick={() => toggleGroup('內科')} />
        <GroupToggle group="共同" active={groups.has('共同')} onClick={() => toggleGroup('共同')} />
        {totalCount > 0 && (
          <span className="text-xs text-ink-500 dark:text-ink-400 ml-2">
            共 {totalCount} 題
          </span>
        )}
      </div>

      {!canStart && (
        <p className="text-rose-700 dark:text-rose-300 text-sm mb-4">至少選一個科別才能開始。</p>
      )}

      {years.length === 0 ? (
        <p className="text-ink-400 dark:text-ink-500">尚無題庫,請先匯入。</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {years.map((y) => (
            <button
              key={y.year}
              onClick={() => start(y.year)}
              disabled={starting !== null || !canStart}
              className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 hover:border-accent hover:shadow-paper transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-ink-200 dark:disabled:hover:border-ink-700 disabled:hover:shadow-none text-left"
            >
              <div className="font-serif text-2xl text-ink-900 dark:text-ink-100">
                {y.year}
                {y.year === 100 && (
                  <span className="ml-1 text-xs text-ink-400 dark:text-ink-500 align-middle">(模擬)</span>
                )}
              </div>
              <div className="text-xs text-ink-500 dark:text-ink-400 mt-1">{totalCount} 題</div>
              {starting === y.year && (
                <div className="text-[11px] text-accent mt-2">準備中…</div>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="mt-10">
        <Link to="/exam-history" className="text-sm text-accent hover:text-accent-dark">
          → 查看歷次作答紀錄
        </Link>
      </div>
    </div>
  );
}

function GroupToggle({
  group,
  active,
  onClick,
}: {
  group: Group;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition ' +
        (active
          ? 'bg-accent/10 border-accent text-accent-dark dark:text-accent font-medium'
          : 'bg-white dark:bg-ink-800 border-ink-200 dark:border-ink-700 text-ink-500 dark:text-ink-400 hover:border-ink-400')
      }
    >
      <span className={'inline-block w-2 h-2 rounded-full ' + (active ? 'bg-accent' : 'bg-ink-300 dark:bg-ink-600')} />
      {group} ({GROUP_COUNTS[group]})
    </button>
  );
}

function ExamInProgress({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<ExamState | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState(false);
  // 標記題目 (待回頭檢查) — local-only, persisted in sessionStorage so a
  // refresh during the exam doesn't drop the user's flags. Not synced to
  // the server (these are ephemeral exam-time aids, no need for a roundtrip).
  const [marked, setMarked] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem(`exam-marks-${sessionId}`);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const flushTimers = useRef<Record<string, number>>({});

  function toggleMark(qid: string) {
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(qid)) next.delete(qid);
      else next.add(qid);
      try {
        sessionStorage.setItem(`exam-marks-${sessionId}`, JSON.stringify([...next]));
      } catch {
        /* storage full / disabled — non-fatal */
      }
      return next;
    });
  }

  // Load: prefer fresh state from server (works after refresh / device switch)
  useEffect(() => {
    const cached = sessionStorage.getItem(`exam-${sessionId}`);
    if (cached) {
      const s = JSON.parse(cached) as ExamState;
      setState(s);
      const seed: Record<string, string> = {};
      for (const q of s.questions) if (q.chosen) seed[q.id] = q.chosen;
      setAnswers(seed);
    }
    api.get<ExamState>(`/api/exam/${sessionId}/state`).then((s) => {
      setState(s);
      sessionStorage.setItem(`exam-${sessionId}`, JSON.stringify(s));
      const seed: Record<string, string> = {};
      for (const q of s.questions) if (q.chosen) seed[q.id] = q.chosen;
      setAnswers((prev) => ({ ...seed, ...prev }));
    }).catch(() => {
      if (!cached) {
        alert('找不到作答中的 session,可能已結束或非你本人。');
        navigate('/exam');
      }
    });
  }, [sessionId, navigate]);

  // Tick (only when running)
  useEffect(() => {
    if (!state || state.running_since === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [state?.running_since, !!state]);

  // Warn on close while running
  useEffect(() => {
    function beforeUnload(e: BeforeUnloadEvent) {
      if (state?.running_since !== null && Object.keys(answers).length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [answers, state?.running_since]);

  // Auto-force-finish at cap — must run before any early return to keep hook
  // count stable across renders (Rules of Hooks).
  useEffect(() => {
    if (!state || state.running_since === null || submitting) return;
    const liveMs = state.elapsed_ms + (now - state.running_since);
    if (liveMs >= state.cap_ms) submit();
  }, [now, state, submitting]);

  if (!state) {
    return <div className="p-8 text-center text-ink-400 dark:text-ink-500">載入中…</div>;
  }

  const live = state.running_since
    ? state.elapsed_ms + (now - state.running_since)
    : state.elapsed_ms;
  const remaining = Math.max(0, state.cap_ms - live);
  const overtime = live > state.cap_ms;
  const isPaused = state.running_since === null;

  // Format mm:ss for remaining (or live elapsed if overtime)
  function fmt(ms: number): string {
    const sec = Math.floor(ms / 1000);
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    return (
      String(hh).padStart(2, '0') + ':' +
      String(mm).padStart(2, '0') + ':' +
      String(ss).padStart(2, '0')
    );
  }

  const q = state.questions[activeIdx];

  function choose(letter: string) {
    if (isPaused) return;
    setAnswers((prev) => ({ ...prev, [q.id]: letter }));
    if (flushTimers.current[q.id])
      window.clearTimeout(flushTimers.current[q.id]);
    flushTimers.current[q.id] = window.setTimeout(() => {
      api.post(`/api/exam/${sessionId}/answer`, {
        question_id: q.id,
        chosen: letter,
      });
    }, 400);
  }

  async function pause() {
    if (busy || isPaused) return;
    setBusy(true);
    try {
      const r = await api.post<{ elapsed_ms: number; running_since: null }>(
        `/api/exam/${sessionId}/pause`
      );
      setState((s) => s && { ...s, elapsed_ms: r.elapsed_ms, running_since: null });
    } finally { setBusy(false); }
  }

  async function resume() {
    if (busy || !isPaused) return;
    setBusy(true);
    try {
      const r = await api.post<{ elapsed_ms: number; running_since: number }>(
        `/api/exam/${sessionId}/resume`
      );
      setState((s) => s && { ...s, elapsed_ms: r.elapsed_ms, running_since: r.running_since });
    } finally { setBusy(false); }
  }

  async function submit() {
    if (submitting || !state) return;
    if (
      !overtime &&
      Object.keys(answers).length < state.questions.length &&
      !confirm(
        `你還有 ${state.questions.length - Object.keys(answers).length} 題未作答,確定要交卷嗎?`,
      )
    )
      return;
    setSubmitting(true);
    try {
      Object.entries(flushTimers.current).forEach(([, id]) => window.clearTimeout(id));
      for (const [qid, letter] of Object.entries(answers)) {
        await api.post(`/api/exam/${sessionId}/answer`, {
          question_id: qid,
          chosen: letter,
        });
      }
      await api.post(`/api/exam/${sessionId}/finish`);
      sessionStorage.removeItem(`exam-${sessionId}`);
      sessionStorage.removeItem(`exam-marks-${sessionId}`);
      navigate(`/exam/${sessionId}/result`);
    } finally {
      setSubmitting(false);
    }
  }

  const answered = Object.keys(answers).length;
  const total = state.questions.length;
  const warningSoon = !overtime && remaining < 10 * 60_000;

  return (
    <div className="min-h-screen bg-ink-50 dark:bg-ink-900 pb-32">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 bg-white dark:bg-ink-800 border-b border-ink-200 dark:border-ink-700 px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <div className="text-sm flex items-center gap-3 flex-wrap">
          <span
            className={
              'font-mono ' +
              (overtime
                ? 'text-rose-700'
                : warningSoon
                ? 'text-amber-700'
                : 'text-ink-900 dark:text-ink-100')
            }
            title={isPaused ? '已暫停' : '倒數中'}
          >
            {overtime ? '超時 ' + fmt(live - state.cap_ms) : fmt(remaining)}
          </span>
          <span className="text-ink-400 dark:text-ink-500">·</span>
          <span className="text-ink-600 dark:text-ink-300">
            {answered}/{total} 題已答
          </span>
          {isPaused && (
            <span className="inline-flex items-center gap-1 text-xs bg-ink-100 dark:bg-ink-700 text-ink-700 dark:text-ink-200 px-2 py-0.5 rounded">
              <Pause size={12} /> 暫停中
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isPaused ? (
            <button
              onClick={resume}
              disabled={busy}
              className="inline-flex items-center gap-1 text-accent hover:text-accent-dark px-3 py-1.5 rounded text-sm disabled:opacity-40"
            >
              <Play size={14} /> 繼續
            </button>
          ) : (
            <button
              onClick={pause}
              disabled={busy}
              className="inline-flex items-center gap-1 text-ink-600 dark:text-ink-300 hover:text-accent px-3 py-1.5 rounded text-sm disabled:opacity-40"
            >
              <Pause size={14} /> 暫停
            </button>
          )}
          <button
            onClick={submit}
            disabled={submitting}
            className="bg-accent hover:bg-accent-dark text-white px-4 py-1.5 rounded text-sm font-medium disabled:opacity-40"
          >
            {submitting ? '交卷中…' : '交卷'}
          </button>
        </div>
      </header>

      {warningSoon && !isPaused && (
        <div className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700 px-4 py-2 text-sm text-amber-800 dark:text-amber-200 inline-flex items-center gap-2 w-full">
          <AlertTriangle size={14} /> 剩下不到 10 分鐘,記得交卷。
        </div>
      )}

      {isPaused && (
        <div className="bg-ink-50 dark:bg-ink-900 border-b border-ink-200 dark:border-ink-700">
          <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8 text-center">
            <Pause className="mx-auto text-ink-400 dark:text-ink-500" size={48} strokeWidth={1.5} />
            <h2 className="font-serif text-xl text-ink-800 dark:text-ink-200 mt-3">已暫停作答</h2>
            <p className="text-sm text-ink-500 dark:text-ink-400 mt-1">
              倒數計時已停止。隨時點「繼續」恢復。
            </p>
            <button
              onClick={resume}
              disabled={busy}
              className="mt-4 inline-flex items-center gap-2 bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40"
            >
              <Play size={16} /> 繼續作答
            </button>
          </div>
        </div>
      )}

      {/* Current question */}
      {!isPaused && (
        <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
          <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 sm:p-7 shadow-paper">
            <div className="flex items-center justify-between mb-3 gap-3">
              <div className="text-sm text-ink-500 dark:text-ink-400">
                第 {q.number} 題 / {total}
              </div>
              <button
                onClick={() => toggleMark(q.id)}
                className={
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition ' +
                  (marked.has(q.id)
                    ? 'bg-amber-100 dark:bg-amber-900/30 border-amber-400 text-amber-800 dark:text-amber-200'
                    : 'border-ink-200 dark:border-ink-700 text-ink-500 dark:text-ink-400 hover:border-amber-400 hover:text-amber-700')
                }
                aria-pressed={marked.has(q.id)}
                title={marked.has(q.id) ? '取消標記' : '標記待回頭檢查'}
              >
                <Flag size={13} className={marked.has(q.id) ? 'fill-amber-500' : ''} />
                {marked.has(q.id) ? '已標記' : '標記'}
              </button>
            </div>
            <p className="font-serif text-lg sm:text-xl leading-relaxed text-ink-900 dark:text-ink-100 whitespace-pre-wrap">
              {q.stem}
            </p>
            <ul className="mt-6 space-y-2.5">
              {(['A', 'B', 'C', 'D', 'E'] as const)
                .filter((L) => q.options[L])
                .map((L) => {
                  const selected = answers[q.id] === L;
                  return (
                    <li
                      key={L}
                      onClick={() => choose(L)}
                      className={`flex gap-3 items-start p-3 rounded border cursor-pointer transition ${
                        selected
                          ? 'border-accent bg-accent/5'
                          : 'border-ink-200 dark:border-ink-700 hover:border-ink-400 hover:bg-ink-50 dark:hover:bg-ink-700/50'
                      }`}
                    >
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-current text-sm font-semibold shrink-0">
                        {L}
                      </span>
                      <span className="leading-relaxed text-ink-800 dark:text-ink-200">{q.options[L]}</span>
                    </li>
                  );
                })}
            </ul>
          </div>

          <div className="mt-5 flex gap-2 justify-between">
            <button
              onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
              disabled={activeIdx === 0}
              className="inline-flex items-center gap-1 px-4 py-2 text-sm text-ink-600 dark:text-ink-300 disabled:opacity-30"
            >
              <ChevronLeft size={14} /> 上一題
            </button>
            <button
              onClick={() => setActiveIdx((i) => Math.min(total - 1, i + 1))}
              disabled={activeIdx === total - 1}
              className="inline-flex items-center gap-1 px-4 py-2 text-sm text-ink-600 dark:text-ink-300 disabled:opacity-30"
            >
              下一題 <ChevronRight size={14} />
            </button>
          </div>

          {/* Question navigator grid */}
          <details className="mt-8 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-700 dark:text-ink-300 flex items-center gap-3 flex-wrap">
              <span>題號跳轉 ({answered}/{total})</span>
              {marked.size > 0 && (
                <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                  <Flag size={12} className="fill-amber-500" /> {marked.size} 題已標記
                </span>
              )}
            </summary>
            <div className="grid grid-cols-10 gap-1.5 p-3">
              {state.questions.map((qq, i) => {
                const a = answers[qq.id];
                const m = marked.has(qq.id);
                return (
                  <button
                    key={qq.id}
                    onClick={() => setActiveIdx(i)}
                    className={`relative aspect-square text-xs font-mono rounded border transition ${
                      i === activeIdx
                        ? 'border-accent bg-accent text-white'
                        : m
                        ? a
                          ? 'border-amber-500 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-900 dark:text-emerald-200'
                          : 'border-amber-500 bg-amber-50 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200'
                        : a
                        ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-900 dark:text-emerald-200'
                        : 'border-ink-200 dark:border-ink-700 text-ink-500 dark:text-ink-400 hover:border-ink-400'
                    }`}
                  >
                    {qq.number}
                    {m && (
                      <Flag
                        size={9}
                        className={
                          'absolute top-0.5 right-0.5 fill-amber-500 ' +
                          (i === activeIdx ? 'text-white' : 'text-amber-600')
                        }
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </details>
        </main>
      )}
    </div>
  );
}
