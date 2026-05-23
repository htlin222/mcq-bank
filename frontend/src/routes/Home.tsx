import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, History, AlertTriangle, CalendarDays, Scale } from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../hooks/useMe';
import { ActivityHeatmap } from '../components/ActivityHeatmap';

type RecentChallenge = {
  id: string;
  question_id: string;
  year: number;
  number: number;
  stem: string;
  proposer_name: string | null;
  proposer_email: string;
  proposed_answer: string;
  original_answer_at_challenge: string;
  status: 'open' | 'contested';
  contested_at: number | null;
  created_at: number;
  agrees: number;
  disagrees: number;
};

type YearMeta = { year: number; count: number };
type Stats = {
  questions_attempted: number;
  total_correct: number;
  total_attempts: number;
  by_year: { year: number; seen: number; correct: number }[];
};

// 血液腫瘤次專科考試日 — 2026/08/29 上午 9:00 (Taipei time)
const EXAM_DATE = new Date('2026-08-29T09:00:00+08:00');

type Countdown = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  total_ms: number;
};

function countdownTo(target: Date): Countdown {
  const total_ms = Math.max(0, target.getTime() - Date.now());
  const totalSec = Math.floor(total_ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;
  return { days, hours, minutes, seconds, total_ms };
}

export function Home() {
  const { me } = useMe();
  const [years, setYears] = useState<YearMeta[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [challenges, setChallenges] = useState<RecentChallenge[]>([]);
  const [countdown, setCountdown] = useState<Countdown>(() => countdownTo(EXAM_DATE));

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
    api.get<Stats>('/api/review/stats').then(setStats).catch(() => setStats(null));
    api
      .get<RecentChallenge[]>('/api/challenges/recent?limit=5')
      .then(setChallenges)
      .catch(() => setChallenges([]));
    // Tick once per second so the SS digits keep up. State updates are cheap
    // here — only the countdown card depends on it.
    const t = window.setInterval(() => setCountdown(countdownTo(EXAM_DATE)), 1000);
    return () => window.clearInterval(t);
  }, []);

  const daysLeft = countdown.days;
  const finished = countdown.total_ms <= 0;

  const totalQuestions = years.reduce((s, y) => s + y.count, 0);
  const seen = stats?.questions_attempted ?? 0;
  const overallPct = totalQuestions ? Math.round((seen / totalQuestions) * 100) : 0;
  const correctPct = stats && stats.total_attempts
    ? Math.round((stats.total_correct / stats.total_attempts) * 100)
    : 0;

  return (
    <div className="max-w-4xl lg:max-w-5xl xl:max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header className="mb-8">
        <h1 className="font-serif text-3xl sm:text-4xl text-ink-900 dark:text-ink-100">
          {greeting()} {me?.display_name ? <span className="text-accent">{me.display_name}</span> : ''}
        </h1>
        <p className="text-ink-500 dark:text-ink-400 mt-2 text-sm sm:text-base">
          2026 台灣血專衝衝衝 · 共筆詳解 · 全真模擬
        </p>
      </header>

      {/* Countdown to 血專 exam */}
      <section className="mb-8">
        <div className="bg-gradient-to-r from-accent/10 to-amber-50 border border-accent/30 rounded-lg p-5 sm:p-6 flex items-center gap-5">
          <CalendarDays className="text-accent shrink-0" size={36} strokeWidth={1.5} />
          <div className="flex-1">
            <div className="text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400">
              血液腫瘤次專科考試倒數
            </div>
            {finished ? (
              <div className="font-serif mt-0.5 text-2xl sm:text-3xl text-ink-700 dark:text-ink-200">
                考試已開始 — 加油!
              </div>
            ) : (
              <div className="font-serif mt-0.5 flex items-baseline gap-2 flex-wrap">
                <span className={`text-4xl sm:text-5xl ${daysLeft <= 30 ? 'text-rose-700' : daysLeft <= 60 ? 'text-amber-700' : 'text-accent'}`}>
                  {daysLeft}
                </span>
                <span className="text-ink-600 text-base">天</span>
                <span
                  className="font-mono tabular-nums text-ink-600 dark:text-ink-300 text-sm sm:text-base ml-1"
                  aria-live="polite"
                >
                  {String(countdown.hours).padStart(2, '0')}
                  <span className="text-ink-400">:</span>
                  {String(countdown.minutes).padStart(2, '0')}
                  <span className="text-ink-400">:</span>
                  {String(countdown.seconds).padStart(2, '0')}
                </span>
                <span className="ml-2 text-ink-500 dark:text-ink-400 text-xs sm:text-sm">
                  · 2026 / 08 / 29 09:00
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Activity heatmap */}
      <section className="mb-8">
        <ActivityHeatmap />
      </section>

      {/* Stats summary */}
      <section className="grid grid-cols-3 gap-3 sm:gap-5 mb-10">
        <StatBlock label="總題數" value={totalQuestions} />
        <StatBlock
          label="已複習"
          value={seen}
          sub={`${overallPct}%`}
          accent
        />
        <StatBlock label="準確率" value={`${correctPct}%`} sub={`${stats?.total_correct ?? 0}/${stats?.total_attempts ?? 0}`} />
      </section>

      {/* Mode cards */}
      <section className="grid sm:grid-cols-2 gap-4 mb-10">
        <Link
          to="/review"
          className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
        >
          <h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
            複習模式
          </h2>
          <p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
            一題一答即時對照詳解,可協作編輯共筆、留言討論、提及他人。
          </p>
        </Link>
        <Link
          to="/exam"
          className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
        >
          <h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
            全真作答
          </h2>
          <p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
            按年度作答模擬考 (70 內科 + 30 共同),完賽看分數與錯題回顧。
          </p>
        </Link>
      </section>

      {/* Year picker */}
      <section className="mb-10">
        <h2 className="font-serif text-xl text-ink-800 dark:text-ink-200 mb-4">依年度 (民國)</h2>
        {years.length === 0 ? (
          <p className="text-sm text-ink-400">尚無題目。請使用 import-questions 匯入 CSV。</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 sm:gap-3">
            {years.map((y) => {
              const s = stats?.by_year.find((x) => x.year === y.year);
              const seen = s?.seen ?? 0;
              const correct = s?.correct ?? 0;
              const seenPct = y.count > 0 ? Math.round((seen / y.count) * 100) : 0;
              const accPct = seen > 0 ? Math.round((correct / seen) * 100) : null;
              return (
                <Link
                  key={y.year}
                  to={`/year/${y.year}`}
                  className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-3 hover:border-accent hover:shadow-paper transition"
                >
                  <div className="flex items-baseline gap-2">
                    <div className="font-serif text-2xl text-ink-900 dark:text-ink-100">
                      {y.year}
                      {y.year === 100 && (
                        <span className="ml-1 text-xs text-ink-400 align-middle">(模擬)</span>
                      )}
                    </div>
                    <div className="text-xs text-ink-500 dark:text-ink-400">{y.count} 題</div>
                  </div>

                  <div className="mt-2 h-1.5 rounded-full bg-ink-100 dark:bg-ink-700 overflow-hidden">
                    <div
                      className="h-full bg-accent transition-[width]"
                      style={{ width: `${Math.min(100, seenPct)}%` }}
                    />
                  </div>

                  <div className="mt-1.5 flex items-center justify-between text-[11px]">
                    <span className="text-ink-500 dark:text-ink-400">
                      已複習 <span className="font-mono text-ink-700 dark:text-ink-200">{seen}</span>
                      <span className="text-ink-400">/{y.count}</span>
                    </span>
                    {accPct !== null && (
                      <span
                        className={
                          'font-mono ' +
                          (accPct >= 70
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : accPct >= 50
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-rose-700 dark:text-rose-300')
                        }
                        title="準確率 (本年最近一次作答)"
                      >
                        {accPct}%
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* 近期爭議 — active answer challenges across the dataset */}
      {challenges.length > 0 && (
        <section className="mb-10">
          <h2 className="font-serif text-xl text-ink-800 dark:text-ink-200 mb-4 inline-flex items-center gap-2">
            <Scale size={18} className="text-amber-700 dark:text-amber-300" /> 近期爭議
          </h2>
          <ul className="space-y-2">
            {challenges.map((c) => {
              const qid = `${c.year}-${String(c.number).padStart(3, '0')}`;
              const statusLabel = c.status === 'contested' ? '討論中' : '表決中';
              const statusCls =
                c.status === 'contested'
                  ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200'
                  : 'bg-sky-100 dark:bg-sky-900/30 text-sky-800 dark:text-sky-200';
              return (
                <li key={c.id}>
                  <Link
                    to={`/q/${qid}`}
                    className="block bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent transition"
                  >
                    <div className="flex items-start gap-2 flex-wrap text-sm">
                      <span className="font-mono text-ink-500 dark:text-ink-400 shrink-0">{qid}</span>
                      <span className="text-ink-700 dark:text-ink-200 line-clamp-1 flex-1 min-w-0">
                        {c.stem}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-[11px] shrink-0 ${statusCls}`}>
                        {statusLabel}
                      </span>
                    </div>
                    <div className="mt-1.5 text-xs text-ink-500 dark:text-ink-400 flex items-center gap-2 flex-wrap">
                      <span>
                        {c.proposer_name ?? c.proposer_email.split('@')[0]} 主張{' '}
                        <span className="font-mono">{c.original_answer_at_challenge}</span> →{' '}
                        <span className="font-mono font-semibold text-amber-700 dark:text-amber-300">
                          {c.proposed_answer}
                        </span>
                      </span>
                      <span className="text-ink-400">
                        · 同意 {c.agrees} · 反對 {c.disagrees}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Quick links */}
      <section className="flex gap-4 flex-wrap text-sm">
        <Link to="/bookmarks" className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark">
          <Bookmark size={14} /> 我的收藏
        </Link>
        <Link to="/wrong" className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark">
          <AlertTriangle size={14} /> 錯題回顧
        </Link>
        <Link to="/exam-history" className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark">
          <History size={14} /> 作答紀錄
        </Link>
      </section>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '凌晨好';
  if (h < 12) return '早安';
  if (h < 18) return '午安';
  return '晚安';
}

function StatBlock({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 sm:p-5 text-center shadow-paper">
      <div className="text-xs text-ink-500 dark:text-ink-400 mb-1">{label}</div>
      <div className={`font-serif text-2xl sm:text-3xl ${accent ? 'text-accent' : 'text-ink-900 dark:text-ink-100'}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-ink-400 mt-1">{sub}</div>}
    </div>
  );
}
