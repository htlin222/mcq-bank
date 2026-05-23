import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

type YearMeta = { year: number; count: number };
type QListItem = {
  id: string;
  year: number;
  number: number;
  stem: string;
  group: '內科' | '共同' | null;
};

export function ReviewIndex() {
  const [years, setYears] = useState<YearMeta[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
  }, []);

  async function startRandom() {
    // pick random year, random question — quick path
    const all = await api.get<QListItem[]>('/api/questions?limit=200');
    if (all.length === 0) return;
    const pick = all[Math.floor(Math.random() * all.length)];
    navigate(`/q/${pick.id}`);
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-2">複習模式</h1>
      <p className="text-ink-500 text-sm mb-8">
        一題一答 · 可協作編輯詳解 · 留言討論
      </p>

      <button
        onClick={startRandom}
        className="w-full sm:w-auto bg-accent hover:bg-accent-dark text-white px-6 py-3 rounded font-medium transition mb-8"
      >
        隨機抽一題開始
      </button>

      <h2 className="font-serif text-xl text-ink-800 mb-4">選擇年度 (民國)</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {years.map((y) => (
          <Link
            key={y.year}
            to={`/year/${y.year}`}
            className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 hover:border-accent hover:shadow-paper transition"
          >
            <div className="font-serif text-xl text-ink-900 dark:text-ink-100">
              {y.year}
              {y.year === 100 && (
                <span className="ml-1 text-xs text-ink-400 align-middle">(模擬)</span>
              )}
            </div>
            <div className="text-xs text-ink-500 mt-1">{y.count} 題</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
