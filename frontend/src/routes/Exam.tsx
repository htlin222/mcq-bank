import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api';

type YearMeta = { year: number; count: number };

type ExamQuestion = {
  id: string;
  number: number;
  stem: string;
  options: Record<string, string>;
};

type ExamSession = {
  session_id: string;
  started_at: number;
  questions: ExamQuestion[];
};

export function Exam() {
  const { sid } = useParams<{ sid: string }>();
  if (sid) return <ExamInProgress sessionId={sid} />;
  return <ExamStart />;
}

function ExamStart() {
  const [years, setYears] = useState<YearMeta[]>([]);
  const [starting, setStarting] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
  }, []);

  async function start(year: number) {
    if (starting) return;
    setStarting(year);
    try {
      const s = await api.post<{ session_id: string }>('/api/exam/start', { year });
      // Cache session so we don't refetch immediately
      sessionStorage.setItem(`exam-${s.session_id}`, JSON.stringify(s));
      navigate(`/exam/${s.session_id}`);
    } finally {
      setStarting(null);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 mb-2">全真作答</h1>
      <p className="text-ink-500 text-sm mb-8">
        選擇一個民國年度開始模擬考 (正式年度為 100 題:70 內科 + 30 共同)。完賽後查看分數與錯題回顧。
      </p>

      {years.length === 0 ? (
        <p className="text-ink-400">尚無題庫,請先匯入。</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {years.map((y) => (
            <button
              key={y.year}
              onClick={() => start(y.year)}
              disabled={starting !== null}
              className="bg-white border border-ink-200 rounded-lg p-4 hover:border-accent hover:shadow-paper transition disabled:opacity-40 text-left"
            >
              <div className="font-serif text-2xl text-ink-900">
                {y.year}
                {y.year === 100 && (
                  <span className="ml-1 text-xs text-ink-400 align-middle">(模擬)</span>
                )}
              </div>
              <div className="text-xs text-ink-500 mt-1">{y.count} 題</div>
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

function ExamInProgress({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const [session, setSession] = useState<ExamSession | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState(false);
  const flushTimers = useRef<Record<string, number>>({});

  // Load (from sessionStorage if just started, else GET)
  useEffect(() => {
    const cached = sessionStorage.getItem(`exam-${sessionId}`);
    if (cached) {
      setSession(JSON.parse(cached));
      return;
    }
    api
      .get<{
        session: { started_at: number };
        answers: {
          question_id: string;
          chosen: string | null;
          number: number;
          stem: string;
        }[];
      }>(`/api/exam/${sessionId}`)
      .then((r) => {
        // Rebuild ExamSession-shaped object from server response.
        // (Skipped because GET /:sid is for results — in v1 we rely on sessionStorage
        // for in-progress state. Fallback: redirect home.)
        if (!cached) {
          alert('找不到作答中的 session,可能已過期或被結束。');
          navigate('/exam');
        }
      })
      .catch(() => navigate('/exam'));
  }, [sessionId, navigate]);

  // Tick timer
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Warn on close
  useEffect(() => {
    function beforeUnload(e: BeforeUnloadEvent) {
      if (Object.keys(answers).length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [answers]);

  if (!session) {
    return <div className="p-8 text-center text-ink-400">載入中…</div>;
  }

  const elapsed = Math.floor((now - session.started_at) / 1000);
  const hh = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const mm = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  const q = session.questions[activeIdx];

  function choose(letter: string) {
    setAnswers((prev) => ({ ...prev, [q.id]: letter }));
    // Debounced flush per-question
    if (flushTimers.current[q.id])
      window.clearTimeout(flushTimers.current[q.id]);
    flushTimers.current[q.id] = window.setTimeout(() => {
      api.post(`/api/exam/${sessionId}/answer`, {
        question_id: q.id,
        chosen: letter,
      });
    }, 400);
  }

  async function submit() {
    if (submitting || !session) return;
    if (
      Object.keys(answers).length < session.questions.length &&
      !confirm(
        `你還有 ${session.questions.length - Object.keys(answers).length} 題未作答,確定要交卷嗎?`,
      )
    )
      return;
    setSubmitting(true);
    try {
      // Flush any pending
      Object.entries(flushTimers.current).forEach(([, id]) => window.clearTimeout(id));
      for (const [qid, letter] of Object.entries(answers)) {
        await api.post(`/api/exam/${sessionId}/answer`, {
          question_id: qid,
          chosen: letter,
        });
      }
      await api.post(`/api/exam/${sessionId}/finish`);
      sessionStorage.removeItem(`exam-${sessionId}`);
      navigate(`/exam/${sessionId}/result`);
    } finally {
      setSubmitting(false);
    }
  }

  const answered = Object.keys(answers).length;
  const total = session.questions.length;

  return (
    <div className="min-h-screen bg-ink-50 pb-32">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 bg-white border-b border-ink-200 px-4 sm:px-6 py-3 flex items-center justify-between">
        <div className="text-sm">
          <span className="font-mono text-ink-900">
            {hh}:{mm}:{ss}
          </span>
          <span className="text-ink-400 mx-2">·</span>
          <span className="text-ink-600">
            {answered}/{total} 題已答
          </span>
        </div>
        <button
          onClick={submit}
          disabled={submitting}
          className="bg-accent hover:bg-accent-dark text-white px-4 py-1.5 rounded text-sm font-medium disabled:opacity-40"
        >
          {submitting ? '交卷中…' : '交卷'}
        </button>
      </header>

      {/* Current question */}
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
        <div className="bg-white border border-ink-200 rounded-lg p-5 sm:p-7 shadow-paper">
          <div className="text-sm text-ink-500 mb-3">
            第 {q.number} 題 / {total}
          </div>
          <p className="font-serif text-lg sm:text-xl leading-relaxed text-ink-900 whitespace-pre-wrap">
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
                        : 'border-ink-200 hover:border-ink-400 hover:bg-ink-50'
                    }`}
                  >
                    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-current text-sm font-semibold shrink-0">
                      {L}
                    </span>
                    <span className="leading-relaxed">{q.options[L]}</span>
                  </li>
                );
              })}
          </ul>
        </div>

        <div className="mt-5 flex gap-2 justify-between">
          <button
            onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
            disabled={activeIdx === 0}
            className="px-4 py-2 text-sm text-ink-600 disabled:opacity-30"
          >
            ← 上一題
          </button>
          <button
            onClick={() => setActiveIdx((i) => Math.min(total - 1, i + 1))}
            disabled={activeIdx === total - 1}
            className="px-4 py-2 text-sm text-ink-600 disabled:opacity-30"
          >
            下一題 →
          </button>
        </div>

        {/* Question navigator grid */}
        <details className="mt-8 bg-white border border-ink-200 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-700">
            題號跳轉 ({answered}/{total})
          </summary>
          <div className="grid grid-cols-10 gap-1.5 p-3">
            {session.questions.map((qq, i) => {
              const a = answers[qq.id];
              return (
                <button
                  key={qq.id}
                  onClick={() => setActiveIdx(i)}
                  className={`aspect-square text-xs font-mono rounded border transition ${
                    i === activeIdx
                      ? 'border-accent bg-accent text-white'
                      : a
                      ? 'border-emerald-400 bg-emerald-50 text-emerald-900'
                      : 'border-ink-200 text-ink-500 hover:border-ink-400'
                  }`}
                >
                  {qq.number}
                </button>
              );
            })}
          </div>
        </details>
      </main>
    </div>
  );
}
