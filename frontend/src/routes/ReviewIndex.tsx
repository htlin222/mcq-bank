import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import {
  describePath,
  loadSectionPath,
  clearSectionPath,
  type LastPath,
} from '../lib/lastPath';
import { ResumeChip } from '../components/ResumeChip';
import { ConfidenceCalibration } from '../components/ConfidenceCalibration';

type YearMeta = { year: number; count: number };
type QListItem = {
  id: string;
  year: number;
  number: number;
  stem: string;
  group: string | null;
};
type Stats = {
  questions_attempted: number;
  total_correct: number;
  total_attempts: number;
  by_year: { year: number; seen: number; correct: number }[];
};

export function ReviewIndex() {
  const [years, setYears] = useState<YearMeta[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  // 「你上次停在…」 — last question/year page visited, synced across devices.
  const [resume, setResume] = useState<LastPath | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
    api.get<Stats>('/api/review/stats').then(setStats).catch(() => setStats(null));
    let cancelled = false;
    loadSectionPath('review').then((v) => {
      if (!cancelled) setResume(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // year → { seen, correct } lookup, so we can show per-year progress
  // without an N+1 fetch per card.
  const statsByYear = useMemo(() => {
    const map = new Map<number, { seen: number; correct: number }>();
    if (stats?.by_year) {
      for (const r of stats.by_year) map.set(r.year, { seen: r.seen, correct: r.correct });
    }
    return map;
  }, [stats]);

  async function startRandom() {
    // pick random year, random question — quick path
    const all = await api.get<QListItem[]>('/api/questions?limit=200');
    if (all.length === 0) return;
    const pick = all[Math.floor(Math.random() * all.length)];
    navigate(`/q/${pick.id}`);
  }

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-2">複習模式</h1>
      <p className="text-ink-500 dark:text-ink-400 text-sm mb-8">
        一題一答 · 可協作編輯詳解 · 留言討論
      </p>

      {resume && (
        <div className="mb-6">
          <ResumeChip
            prefix="你上次停在"
            label={describePath(resume.path)}
            to={resume.path}
            onDismiss={() => {
              clearSectionPath('review');
              setResume(null);
            }}
          />
        </div>
      )}

      <button
        onClick={startRandom}
        className="w-full sm:w-auto bg-accent hover:bg-accent-dark text-white px-6 py-3 rounded font-medium transition mb-8"
      >
        隨機抽一題開始
      </button>

      <section className="mb-8">
        <h2 className="font-serif text-xl text-ink-800 dark:text-ink-100 mb-4">信心校準</h2>
        <ConfidenceCalibration />
      </section>

      <h2 className="font-serif text-xl text-ink-800 dark:text-ink-100 mb-4">選擇年度 (民國)</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {years.map((y) => {
          const s = statsByYear.get(y.year);
          const seen = s?.seen ?? 0;
          const correct = s?.correct ?? 0;
          const seenPct = y.count > 0 ? Math.round((seen / y.count) * 100) : 0;
          const accPct = seen > 0 ? Math.round((correct / seen) * 100) : null;
          return (
            <Link
              key={y.year}
              to={`/year/${y.year}`}
              className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 hover:border-accent hover:shadow-paper transition"
            >
              <div className="flex items-baseline gap-2">
                <div className="font-serif text-xl text-ink-900 dark:text-ink-100">
                  {y.year}
                  {y.year === 100 && (
                    <span className="ml-1 text-xs text-ink-400 dark:text-ink-500 align-middle">(模擬)</span>
                  )}
                </div>
                <div className="text-xs text-ink-500 dark:text-ink-400">{y.count} 題</div>
              </div>

              {/* Progress bar — % of questions in this year ever attempted */}
              <div className="mt-3 h-1.5 rounded-full bg-ink-100 dark:bg-ink-700 overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${Math.min(100, seenPct)}%` }}
                />
              </div>

              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-ink-500 dark:text-ink-400">
                  已複習 <span className="font-mono text-ink-700 dark:text-ink-200">{seen}</span>
                  <span className="text-ink-400 dark:text-ink-500">/{y.count}</span>
                  <span className="text-ink-400 dark:text-ink-500 ml-1">({seenPct}%)</span>
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
    </div>
  );
}
