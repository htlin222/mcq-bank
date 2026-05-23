import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useMe } from '../hooks/useMe';

type YearMeta = { year: number; count: number };
type Stats = {
  questions_attempted: number;
  total_correct: number;
  total_attempts: number;
  by_year: { year: number; seen: number; correct: number }[];
};

export function Home() {
  const { me } = useMe();
  const [years, setYears] = useState<YearMeta[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
    api.get<Stats>('/api/review/stats').then(setStats).catch(() => setStats(null));
  }, []);

  const totalQuestions = years.reduce((s, y) => s + y.count, 0);
  const seen = stats?.questions_attempted ?? 0;
  const overallPct = totalQuestions ? Math.round((seen / totalQuestions) * 100) : 0;
  const correctPct = stats && stats.total_attempts
    ? Math.round((stats.total_correct / stats.total_attempts) * 100)
    : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header className="mb-10">
        <h1 className="font-serif text-3xl sm:text-4xl text-ink-900">
          晚安 {me?.display_name ? <span className="text-accent">{me.display_name}</span> : ''}
        </h1>
        <p className="text-ink-500 mt-2 text-sm sm:text-base">
          專業考試題庫 · 共筆詳解 · 全真模擬
        </p>
      </header>

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
          className="bg-white border border-ink-200 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
        >
          <h2 className="font-serif text-xl text-ink-900 group-hover:text-accent transition">
            複習模式
          </h2>
          <p className="text-sm text-ink-500 mt-2 leading-relaxed">
            一題一答即時對照詳解,可協作編輯共筆、留言討論、提及他人。
          </p>
        </Link>
        <Link
          to="/exam"
          className="bg-white border border-ink-200 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
        >
          <h2 className="font-serif text-xl text-ink-900 group-hover:text-accent transition">
            全真作答
          </h2>
          <p className="text-sm text-ink-500 mt-2 leading-relaxed">
            按年度作答 100 題模擬考,完賽看分數與錯題回顧。
          </p>
        </Link>
      </section>

      {/* Year picker */}
      <section className="mb-10">
        <h2 className="font-serif text-xl text-ink-800 mb-4">依年度 (民國)</h2>
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
                  className="bg-white border border-ink-200 rounded-lg px-4 py-3 hover:border-accent hover:shadow-paper transition"
                >
                  <div className="font-serif text-2xl text-ink-900">
                    {y.year}
                    {y.year === 100 && (
                      <span className="ml-1 text-xs text-ink-400 align-middle">(模擬)</span>
                    )}
                  </div>
                  <div className="text-xs text-ink-500 mt-1">
                    {y.count} 題{pct > 0 && ` · 已讀 ${pct}%`}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Quick links */}
      <section className="flex gap-3 flex-wrap text-sm">
        <Link to="/bookmarks" className="text-accent hover:text-accent-dark">★ 我的收藏</Link>
        <span className="text-ink-300">·</span>
        <Link to="/wrong" className="text-accent hover:text-accent-dark">錯題回顧</Link>
        <span className="text-ink-300">·</span>
        <Link to="/exam-history" className="text-accent hover:text-accent-dark">作答紀錄</Link>
      </section>
    </div>
  );
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
    <div className="bg-white border border-ink-200 rounded-lg p-4 sm:p-5 text-center shadow-paper">
      <div className="text-xs text-ink-500 mb-1">{label}</div>
      <div className={`font-serif text-2xl sm:text-3xl ${accent ? 'text-accent' : 'text-ink-900'}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-ink-400 mt-1">{sub}</div>}
    </div>
  );
}
