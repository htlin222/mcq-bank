import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { BookmarkBadge } from '../components/BookmarkBadge';
import { choicePct, type StatsPayload } from '../lib/choiceStats';
import { describeFilters } from '../lib/customTestLabel';

type Result = {
  session: {
    id: string;
    year: number;
    started_at: number;
    finished_at: number;
    score: number;
    duration_sec: number;
    /** migration 0026;舊列走 DEFAULT 'year'。判斷種類看 kind,不要看 year。 */
    kind?: 'year' | 'custom';
    filter_json?: string | null;
  };
  answers: {
    question_id: string;
    chosen: string | null;
    is_correct: 0 | 1 | null;
    number: number;
    correct_answer: string;
    stem: string;
    /** null for sessions predating the attempts log (migration 0023). */
    elapsed_ms: number | null;
  }[];
};

type Pacing = {
  n: number;
  first_half_avg_ms: number | null;
  second_half_avg_ms: number | null;
  delta_pct: number | null;
  median_ms: number | null;
  slowest: { question_id: string; number: number; ms: number }[];
};

/** mm:ss — matches the 分/秒 style used elsewhere on this page. */
function fmtMs(ms: number): string {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function ExamResult() {
  const { sid } = useParams<{ sid: string }>();
  const [data, setData] = useState<Result | null>(null);
  const [filter, setFilter] = useState<'all' | 'wrong' | 'right'>('wrong');
  const [pacing, setPacing] = useState<Pacing | null>(null);

  useEffect(() => {
    if (!sid) return;
    api.get<Result>(`/api/exam/${sid}`).then(setData);
    api.get<Pacing>(`/api/exam/${sid}/pacing`).then(setPacing).catch(() => {
      /* pacing is best-effort — never block the result page */
    });
  }, [sid]);

  if (!data) return <div className="p-8 text-center text-ink-400 dark:text-ink-500">載入中…</div>;

  const total = data.answers.length;
  const correct = data.session.score;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  const mins = Math.floor(data.session.duration_sec / 60);
  const secs = data.session.duration_sec % 60;

  const visible = data.answers.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'wrong') return a.is_correct !== 1;
    return a.is_correct === 1;
  });

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-8">
        <Link to="/exam" className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent">
          ← 全真作答
        </Link>
      </header>

      {/* Score banner */}
      <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mb-8 text-center">
        <div className="text-sm text-ink-500 dark:text-ink-400 mb-2">
          {data.session.kind === 'custom' ? (
            <>
              自訂測驗
              {describeFilters(data.session.filter_json) && (
                <span className="block text-xs mt-0.5">
                  {describeFilters(data.session.filter_json)}
                </span>
              )}
            </>
          ) : (
            <>{data.session.year} 年度模擬考</>
          )}
        </div>
        <div className="font-serif text-6xl text-ink-900 dark:text-ink-100 mb-3">
          {correct}<span className="text-ink-300 dark:text-ink-600 text-3xl">/{total}</span>
        </div>
        <div className={`text-lg font-medium ${pct >= 60 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
          {pct}%
        </div>
        <div className="text-xs text-ink-400 dark:text-ink-500 mt-3">
          用時 {mins} 分 {secs} 秒 ·{' '}
          {new Date(data.session.finished_at).toLocaleString('zh-TW')}
        </div>
      </div>

      {/* Pacing card */}
      {pacing && (
        <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 sm:p-5 shadow-paper mb-8">
          {pacing.n === 0 ? (
            <p className="text-sm text-ink-400 dark:text-ink-500">
              本場沒有逐題計時資料(舊場次)
            </p>
          ) : (
            <>
              <div className="text-xs text-ink-500 dark:text-ink-400 mb-2">配速</div>
              <p className="text-sm text-ink-700 dark:text-ink-300 leading-relaxed">
                前半段平均 {fmtMs(pacing.first_half_avg_ms ?? 0)} ·{' '}
                後半段平均 {fmtMs(pacing.second_half_avg_ms ?? 0)}
                {pacing.delta_pct !== null && (
                  <>
                    {' '}·{' '}
                    <span
                      className={
                        pacing.delta_pct > 25
                          ? 'font-medium text-rose-700 dark:text-rose-400'
                          : pacing.delta_pct < -25
                          ? 'font-medium text-emerald-700 dark:text-emerald-400'
                          : 'font-medium text-ink-800 dark:text-ink-200'
                      }
                    >
                      {pacing.delta_pct >= 0
                        ? `後段慢了 ${pacing.delta_pct}%`
                        : `後段快了 ${-pacing.delta_pct}%`}
                    </span>
                  </>
                )}
              </p>
              {pacing.slowest.length > 0 && (
                <div className="text-xs text-ink-500 dark:text-ink-400 mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  <span>最慢五題:</span>
                  {pacing.slowest.map((s) => (
                    <Link
                      key={s.question_id}
                      to={`/q/${s.question_id}`}
                      className="hover:text-accent"
                    >
                      第 {s.number} 題 {fmtMs(s.ms)}
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4 text-sm">
        {(['wrong', 'right', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded border transition ${
              filter === f
                ? 'bg-ink-900 dark:bg-ink-700 text-white border-ink-900 dark:border-ink-700'
                : 'border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-ink-400 dark:hover:border-ink-500'
            }`}
          >
            {f === 'all' && `全部 (${total})`}
            {f === 'right' && `答對 (${correct})`}
            {f === 'wrong' && `答錯/未答 (${total - correct})`}
          </button>
        ))}
      </div>

      {/* Per-question list */}
      <ul className="space-y-2">
        {visible.map((a) => {
          const right = a.is_correct === 1;
          const unanswered = !a.chosen;
          return (
            <li key={a.question_id}>
              <Link
                to={`/q/${a.question_id}`}
                className="flex gap-3 items-start bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent hover:shadow-paper transition"
              >
                <span
                  className={`shrink-0 w-9 h-9 rounded-full grid place-items-center font-mono text-sm ${
                    right
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : unanswered
                      ? 'bg-ink-100 dark:bg-ink-700 text-ink-500 dark:text-ink-400'
                      : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
                  }`}
                >
                  {a.number}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed inline-flex items-start gap-1.5">
                    <BookmarkBadge questionId={a.question_id} className="mt-1" />
                    <span>{a.stem}</span>
                  </p>
                  <div className="text-xs text-ink-500 dark:text-ink-400 mt-1">
                    {unanswered ? (
                      <span>未作答 · 正解 {a.correct_answer}</span>
                    ) : right ? (
                      <span className="text-emerald-700 dark:text-emerald-400">✓ {a.chosen}</span>
                    ) : (
                      <span className="text-rose-700 dark:text-rose-400">
                        ✗ 你選 {a.chosen} · 正解 {a.correct_answer}
                      </span>
                    )}
                    <span> · 用時 {a.elapsed_ms === null ? '—' : fmtMs(a.elapsed_ms)}</span>
                  </div>
                </div>
              </Link>
              <ChoiceDistribution
                questionId={a.question_id}
                chosen={a.chosen}
                correctAnswer={a.correct_answer}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 逐題檢討的選項分布。100 題全部預抓等於 100 個 request,所以只在
 * 使用者展開該題時才打 `/stats`(每題最多一次)。
 */
function ChoiceDistribution({
  questionId,
  chosen,
  correctAnswer,
}: {
  questionId: string;
  chosen: string | null;
  correctAnswer: string;
}) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || stats) return;
    let cancelled = false;
    api
      .get<StatsPayload>(`/api/questions/${questionId}/stats`)
      .then((r) => { if (!cancelled) setStats(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, stats, questionId]);

  // server 只在 choices_state === 'ok' 時給 letters;其餘狀態沒有分布可畫。
  const letters = stats?.choices_state === 'ok' ? Object.keys(stats.choice_pct ?? {}) : [];

  return (
    <div className="px-3 pb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-ink-400 dark:text-ink-500 hover:text-accent py-1"
      >
        {open ? '收合選項分布' : '看選項分布'}
      </button>
      {open && (
        <div className="pb-2 text-xs text-ink-500 dark:text-ink-400">
          {failed && <p>分布載入失敗</p>}
          {!failed && !stats && <p>載入中…</p>}
          {stats?.choices_state === 'not_answered' && (
            <p>本題你未作答,作答後才會顯示分布</p>
          )}
          {stats?.choices_state === 'below_threshold' && (
            <p>作答人數不足,暫不顯示選項分布</p>
          )}
          {letters.map((L) => {
            const pct = choicePct(stats, L) ?? 0;
            const isCorrect = L === correctAnswer;
            return (
              <div key={L} className="flex items-center gap-2 py-0.5">
                <span className="w-4 font-mono text-ink-700 dark:text-ink-300">{L}</span>
                <span className="relative h-3 flex-1 rounded bg-ink-100 dark:bg-ink-700/50 overflow-hidden">
                  <span
                    aria-hidden
                    className={
                      'absolute inset-y-0 left-0 ' +
                      (isCorrect ? 'bg-accent/15' : 'bg-ink-200/60 dark:bg-ink-600/40')
                    }
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="w-12 text-right tabular-nums">{pct}%</span>
                <span className="w-8 shrink-0">
                  {isCorrect && '✓'}
                  {L === chosen && '你'}
                </span>
              </div>
            );
          })}
          {stats?.choices_state === 'ok' && (
            <p className="mt-1">{stats.choice_responders} 人作答</p>
          )}
        </div>
      )}
    </div>
  );
}
