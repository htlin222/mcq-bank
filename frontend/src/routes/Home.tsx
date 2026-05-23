import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, History, AlertTriangle, CalendarDays } from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../hooks/useMe';
import { ActivityHeatmap } from '../components/ActivityHeatmap';

type YearMeta = { year: number; count: number };
type Stats = {
  questions_attempted: number;
  total_correct: number;
  total_attempts: number;
  by_year: { year: number; seen: number; correct: number }[];
};

// 血液腫瘤次專科考試日 (2026/08/29)
const EXAM_DATE = new Date('2026-08-29T08:00:00+08:00');

function daysUntil(target: Date): number {
  const ms = target.getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

export function Home() {
  const { me } = useMe();
  const [years, setYears] = useState<YearMeta[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [daysLeft, setDaysLeft] = useState(() => daysUntil(EXAM_DATE));

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
    api.get<Stats>('/api/review/stats').then(setStats).catch(() => setStats(null));
    // Recompute at midnight so the countdown rolls over
    const t = window.setInterval(() => setDaysLeft(daysUntil(EXAM_DATE)), 3_600_000);
    return () => window.clearInterval(t);
  }, []);

  const totalQuestions = years.reduce((s, y) => s + y.count, 0);
  const seen = stats?.questions_attempted ?? 0;
  const overallPct = totalQuestions ? Math.round((seen / totalQuestions) * 100) : 0;
  const correctPct = stats && stats.total_attempts
    ? Math.round((stats.total_correct / stats.total_attempts) * 100)
    : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
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
            <div className="font-serif mt-0.5 flex items-baseline gap-2 flex-wrap">
              <span className={`text-4xl sm:text-5xl ${daysLeft <= 30 ? 'text-rose-700' : daysLeft <= 60 ? 'text-amber-700' : 'text-accent'}`}>
                {daysLeft > 0 ? daysLeft : 0}
              </span>
              <span className="text-ink-600 text-base">天</span>
              <span className="ml-2 text-ink-500 dark:text-ink-400 text-sm">
                · 2026 / 08 / 29
              </span>
            </div>
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
              const pct = s && y.count ? Math.round((s.seen / y.count) * 100) : 0;
              return (
                <Link
                  key={y.year}
                  to={`/year/${y.year}`}
                  className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-3 hover:border-accent hover:shadow-paper transition"
                >
                  <div className="font-serif text-2xl text-ink-900 dark:text-ink-100">
                    {y.year}
                    {y.year === 100 && (
                      <span className="ml-1 text-xs text-ink-400 align-middle">(模擬)</span>
                    )}
                  </div>
                  <div className="text-xs text-ink-500 dark:text-ink-400 mt-1">
                    {y.count} 題{pct > 0 && ` · 已讀 ${pct}%`}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

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
