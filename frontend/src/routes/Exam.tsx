import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Pause, Play, ChevronLeft, ChevronRight, AlertTriangle, Flag } from 'lucide-react';
import { api } from '../lib/api';
import { GROUPS, groupCounts } from '../lib/groups';
import { loadSectionPath, clearSectionPath, type LastPath } from '../lib/lastPath';
import { ResumeChip } from '../components/ResumeChip';
import { flaggedIds, reconcileFlags, setFlag, toServerFlags } from '../lib/examFlagStore';
import { TutorReveal } from '../components/TutorReveal';
import {
  startTimer,
  hide,
  show,
  pause as pauseTimer,
  resume as resumeTimer,
  read,
  type TimerState,
} from '../lib/questionTimer';

type YearMeta = { year: number; count: number };

type ExamQuestion = {
  id: string;
  /** 自訂測驗可跨年份,標題要顯示「114-007」而非只有題號。年度考忽略即可。 */
  year?: number;
  number: number;
  stem: string;
  options: Record<string, string>;
  chosen?: string | null;
  /** 標記待回頭檢查(migration 0028 起由 /state 帶出,跨裝置同步)。 */
  flagged?: boolean;
  flagged_at?: number | null;
};

type ExamState = {
  session_id: string;
  started_at: number;
  elapsed_ms: number;
  running_since: number | null;  // null = paused
  cap_ms: number;                // 100 * 60 * 1000
  /** migration 0026 起由 /state 帶出;舊 client / 舊 session 視為年度考。 */
  kind?: 'year' | 'custom';
  tutor?: 0 | 1;
  timed?: 0 | 1;
  questions: ExamQuestion[];
};

export function Exam() {
  const { sid } = useParams<{ sid: string }>();
  if (sid) return <ExamInProgress sessionId={sid} />;
  return <ExamStart />;
}

type Group = string;
const GROUP_COUNTS: Record<string, number> = groupCounts();

function ExamStart() {
  const [years, setYears] = useState<YearMeta[]>([]);
  const [starting, setStarting] = useState<number | null>(null);
  // 冪等:同一次開考動作沿用同一個 key(依年份綁定,重試不會重複建 session);
  // 換年份或成功後重新產生。
  const startIdemKey = useRef<{ year: number; key: string } | null>(null);
  const [groups, setGroups] = useState<Set<Group>>(
    () => new Set(GROUPS.map((g) => g.label)),
  );
  // Unfinished exam session, synced across devices; cleared on submit
  // (the tracker in App.tsx drops it when the result page is reached).
  const [resume, setResume] = useState<LastPath | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
    let cancelled = false;
    loadSectionPath('exam').then((v) => {
      if (!cancelled) setResume(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalCount = GROUPS.reduce(
    (sum, g) => sum + (groups.has(g.label) ? GROUP_COUNTS[g.label] : 0),
    0,
  );

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
    if (!startIdemKey.current || startIdemKey.current.year !== year) {
      startIdemKey.current = { year, key: crypto.randomUUID() };
    }
    try {
      const s = await api.post<ExamState>('/api/exam/start', {
        year,
        groups: [...groups],
      }, startIdemKey.current.key);
      startIdemKey.current = null;
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

      {resume && (
        <div className="mb-6">
          <ResumeChip
            prefix="你上次停在"
            label="進行中的模擬考"
            to={resume.path}
            onDismiss={() => {
              clearSectionPath('exam');
              setResume(null);
            }}
          />
        </div>
      )}

      {/* 自訂測驗入口 — 年度卡片之外的另一條動線 */}
      <Link
        to="/exam/new"
        className="block mb-8 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 hover:border-accent hover:shadow-paper transition"
      >
        <div className="font-serif text-xl text-ink-900 dark:text-ink-100">自訂測驗</div>
        <div className="text-xs text-ink-500 dark:text-ink-400 mt-1">
          挑狀態、範圍與題數,自己出一份卷 →
        </div>
      </Link>

      {/* 科別選擇 */}
      <div className="mb-8 flex flex-wrap gap-2 items-center">
        <span className="text-xs uppercase tracking-wider text-ink-400 dark:text-ink-500 mr-1">科別</span>
        {GROUPS.map((g) => (
          <GroupToggle
            key={g.label}
            group={g.label}
            active={groups.has(g.label)}
            onClick={() => toggleGroup(g.label)}
          />
        ))}
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
  // 標記題目 (待回頭檢查) — 本機(localStorage)即時生效,server 背景同步,
  // 進入 session 時對帳(examFlagStore)。換裝置/關分頁都留得住。
  // 教學模式:已揭曉答案的題目 id。只有送出答案之後才會加進來,
  // TutorReveal 也只在這裡面才 mount —— 否則 /api/questions/:id 會提前
  // 把正解送到瀏覽器。
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [marked, setMarked] = useState<Set<string>>(
    () => new Set(flaggedIds(sessionId)),
  );
  const flushTimers = useRef<Record<string, number>>({});
  // Per-question timer: restarts on every question change, and follows both
  // the tab's visibility and the session's own pause state.
  const timer = useRef<TimerState>(startTimer(Date.now()));

  function toggleMark(qid: string) {
    const next = new Set(marked);
    if (next.has(qid)) next.delete(qid);
    else next.add(qid);
    setMarked(next);
    // 本機立即寫入 + 背景送 server(副作用刻意放在 updater 外)。
    // 不在 API 失敗時回滾 UI —— 離線時標記不該從畫面上消失,
    // 下次進入 session 由 reconcileFlags 補推。
    setFlag(sessionId, qid, next.has(qid));
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
      // 教學模式續答:已作答的題目答案早就送出過,揭曉狀態要一起還原。
      if (s.tutor === 1) setRevealed(new Set(Object.keys(seed)));
      // 標記對帳:複用這份 /state 回應,不多打 API。本機較新的會被推上去,
      // server 較新的直接採用 —— 重新進入 session 以合併結果為準。
      void reconcileFlags(sessionId, toServerFlags(s.questions))
        .then((flags) => {
          setMarked(
            new Set(
              Object.entries(flags)
                .filter(([, v]) => v.flagged)
                .map(([qid]) => qid),
            ),
          );
        })
        .catch(() => {
          /* 對帳失敗不影響作答流程,畫面維持本機標記 */
        });
    }).catch(() => {
      if (!cached) {
        alert('找不到作答中的 session,可能已結束或非你本人。');
        navigate('/exam');
      }
    });
  }, [sessionId, navigate]);

  // Restart the per-question timer on question change, and pause it while
  // the tab is hidden (looking something up shouldn't count as think time).
  useEffect(() => {
    timer.current = startTimer(Date.now());
    function onVisibility() {
      timer.current = document.hidden
        ? hide(timer.current, Date.now())
        : show(timer.current, Date.now());
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [activeIdx]);

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
  // 不計時的 session 沒有「超時」概念(cap 是 24 小時的形式值)。
  const isCustom = state.kind === 'custom';
  const isTutor = state.tutor === 1;
  const isTimed = state.timed !== 0;
  const overtime = isTimed && live > state.cap_ms;
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
    // 教學模式:答案一旦送出就鎖住,不可改答。
    if (isTutor && revealed.has(q.id)) return;
    setAnswers((prev) => ({ ...prev, [q.id]: letter }));
    if (flushTimers.current[q.id])
      window.clearTimeout(flushTimers.current[q.id]);
    if (isTutor) {
      // 不 debounce:答案即刻定案,且要等 POST 成功才揭曉,確保
      // TutorReveal(會抓到正解)不會在答案送出前就 mount。
      const qid = q.id;
      api
        .post(`/api/exam/${sessionId}/answer`, {
          question_id: qid,
          chosen: letter,
          elapsed_ms: read(timer.current, Date.now()).elapsedMs,
        })
        .then(() => setRevealed((prev) => new Set(prev).add(qid)))
        .catch(() => {
          // 送出失敗就不揭曉,使用者可以重選。
          setAnswers((prev) => {
            const next = { ...prev };
            delete next[qid];
            return next;
          });
        });
      return;
    }
    flushTimers.current[q.id] = window.setTimeout(() => {
      api.post(`/api/exam/${sessionId}/answer`, {
        question_id: q.id,
        chosen: letter,
        elapsed_ms: read(timer.current, Date.now()).elapsedMs,
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
      timer.current = pauseTimer(timer.current, Date.now());
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
      timer.current = resumeTimer(timer.current, Date.now());
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
      // Deliberately no elapsed_ms here: this loop re-sends every answer as a
      // safety net at submit time, it isn't a fresh answering event. Attaching
      // a duration would inject fabricated timing into the pacing report.
      for (const [qid, letter] of Object.entries(answers)) {
        await api.post(`/api/exam/${sessionId}/answer`, {
          question_id: qid,
          chosen: letter,
        });
      }
      await api.post(`/api/exam/${sessionId}/finish`);
      sessionStorage.removeItem(`exam-${sessionId}`);
      // 標記刻意保留(server 也留著):結果頁的「標記」頁籤要用它做二輪複習。
      navigate(`/exam/${sessionId}/result`);
    } finally {
      setSubmitting(false);
    }
  }

  const answered = Object.keys(answers).length;
  const total = state.questions.length;
  const warningSoon = isTimed && !overtime && remaining < 10 * 60_000;

  return (
    <div className="min-h-screen bg-ink-50 dark:bg-ink-900 pb-32">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 bg-white dark:bg-ink-800 border-b border-ink-200 dark:border-ink-700 px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <div className="text-sm flex items-center gap-3 flex-wrap">
          {isCustom && (
            <>
              <span className="text-ink-700 dark:text-ink-200">自訂測驗</span>
              <span className="text-ink-400 dark:text-ink-500">·</span>
            </>
          )}
          {/* 不計時:碼表往上跑,不做紅色告警。 */}
          <span
            className={
              'font-mono ' +
              (overtime
                ? 'text-rose-700'
                : warningSoon
                ? 'text-amber-700'
                : 'text-ink-900 dark:text-ink-100')
            }
            title={isPaused ? '已暫停' : isTimed ? '倒數中' : '計時中(不倒數)'}
          >
            {!isTimed
              ? fmt(live)
              : overtime
              ? '超時 ' + fmt(live - state.cap_ms)
              : fmt(remaining)}
          </span>
          {!isTimed && (
            <span className="text-xs text-ink-500 dark:text-ink-400">不計時</span>
          )}
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
              {isTimed ? '倒數計時已停止。' : '計時已暫停。'}隨時點「繼續」恢復。
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
                {isCustom ? (
                  <>
                    第 {activeIdx + 1} / {total} 題
                    <span className="font-mono ml-2 text-ink-400 dark:text-ink-500">
                      {q.year}-{String(q.number).padStart(3, '0')}
                    </span>
                  </>
                ) : (
                  <>
                    第 {q.number} 題 / {total}
                  </>
                )}
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
                  const locked = isTutor && revealed.has(q.id);
                  return (
                    <li
                      key={L}
                      onClick={() => choose(L)}
                      className={`flex gap-3 items-start p-3 rounded border transition ${
                        locked ? 'cursor-default' : 'cursor-pointer'
                      } ${
                        selected
                          ? 'border-accent bg-accent/5'
                          : locked
                          ? 'border-ink-200 dark:border-ink-700 opacity-60'
                          : 'border-ink-200 dark:border-ink-700 hover:border-ink-400 hover:bg-ink-50 dark:hover:bg-ink-700/50'
                      }`}
                    >
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-current text-sm font-semibold shrink-0">
                        {L}
                      </span>
                      {/* min-w-0 + break-words:同 QuestionCard —— 長基因命名
                          不斷行時會撐破選項的框。 */}
                      <span className="min-w-0 break-words leading-relaxed text-ink-800 dark:text-ink-200">
                        {q.options[L]}
                      </span>
                    </li>
                  );
                })}
            </ul>

            {/* 教學模式:只有在答案送出後才 mount(元件內會抓含正解的
                /api/questions/:id,提前 mount 等於提前洩題)。 */}
            {isTutor && revealed.has(q.id) && answers[q.id] && (
              <TutorReveal questionId={q.id} chosen={answers[q.id]} />
            )}
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
                    {/* 自訂測驗跨年份時 number 會重複,格子用卷內序號。 */}
                    {isCustom ? i + 1 : qq.number}
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
