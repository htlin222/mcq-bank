import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';

type QListItem = {
  id: string;
  year: number;
  number: number;
  stem: string;
  group: '內科' | '共同' | null;
  difficulty: number | null;
};

export function YearList() {
  const { year } = useParams<{ year: string }>();
  const [items, setItems] = useState<QListItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState<'all' | '內科' | '共同'>('all');

  useEffect(() => {
    if (!year) return;
    api
      .get<QListItem[]>(`/api/questions?year=${year}&limit=200`)
      .then(setItems);
  }, [year]);

  if (items === null) {
    return <div className="p-8 text-center text-ink-400">載入中…</div>;
  }

  const visible = items.filter((q) => {
    if (groupFilter !== 'all' && q.group !== groupFilter) return false;
    if (!filter) return true;
    return (
      String(q.number).includes(filter) ||
      q.stem.includes(filter) ||
      (q.group ?? '').includes(filter)
    );
  });

  const counts = {
    內科: items.filter((q) => q.group === '內科').length,
    共同: items.filter((q) => q.group === '共同').length,
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-6">
        <Link to="/review" className="text-sm text-ink-500 hover:text-accent">
          ← 回到複習模式
        </Link>
        <h1 className="font-serif text-3xl text-ink-900 mt-2">
          民國 {year} 年 · {items.length} 題
        </h1>
        <p className="text-xs text-ink-500 mt-1">
          內科 {counts.內科} · 共同 {counts.共同}
        </p>
      </header>

      <div className="flex gap-2 mb-4">
        {(['all', '內科', '共同'] as const).map((g) => (
          <button
            key={g}
            onClick={() => setGroupFilter(g)}
            className={
              'px-3 py-1 rounded text-sm border transition ' +
              (groupFilter === g
                ? 'bg-accent text-white border-accent'
                : 'bg-white text-ink-700 border-ink-200 hover:border-ink-400')
            }
          >
            {g === 'all' ? '全部' : g}
            {g !== 'all' && (
              <span className="ml-1 text-[10px] opacity-70">({counts[g]})</span>
            )}
          </button>
        ))}
      </div>

      <input
        type="search"
        placeholder="篩選題號、關鍵字…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full border border-ink-200 rounded px-4 py-2 mb-6 focus:outline-none focus:border-accent"
      />

      <ol className="space-y-2">
        {visible.map((q) => (
          <li key={q.id}>
            <Link
              to={`/q/${q.id}`}
              className="flex gap-3 items-start bg-white border border-ink-200 rounded p-3 hover:border-accent hover:shadow-paper transition"
            >
              <span className="font-mono text-sm text-ink-500 shrink-0 w-10 text-right">
                {q.number}.
              </span>
              <span className="text-ink-800 line-clamp-2 leading-relaxed">
                {q.stem}
              </span>
              {q.group && (
                <span
                  className={
                    'ml-auto text-[11px] px-2 py-0.5 rounded shrink-0 self-center ' +
                    (q.group === '內科'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-sky-100 text-sky-800')
                  }
                >
                  {q.group}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
