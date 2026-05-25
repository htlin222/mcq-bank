import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, Clock } from 'lucide-react';
import { api } from '../lib/api';
import { BookmarkBadge } from '../components/BookmarkBadge';
import { GROUPS, groupBadgeClass } from '../lib/groups';

type QListItem = {
  id: string;
  year: number;
  number: number;
  stem: string;
  group: string | null;
  difficulty: number | null;
};
type AnkiDeckStats = {
  year: number;
  count: number;
  due_count: number;
  new_count: number;
  due_review_count: number;
  learning_count: number;
  review_count: number;
  studied_count: number;
  next_due_at: number | null;
};

export function YearList() {
  const { year } = useParams<{ year: string }>();
  const [items, setItems] = useState<QListItem[] | null>(null);
  const [ankiDeck, setAnkiDeck] = useState<AnkiDeckStats | null>(null);
  const [filter, setFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('all');

  useEffect(() => {
    if (!year) return;
    api
      .get<QListItem[]>(`/api/questions?year=${year}&limit=200`)
      .then(setItems);
    api
      .get<AnkiDeckStats[]>('/api/review/anki/decks')
      .then((decks) => setAnkiDeck(decks.find((d) => String(d.year) === year) ?? null))
      .catch(() => setAnkiDeck(null));
  }, [year]);

  if (items === null) {
    return <div className="p-8 text-center text-ink-400 dark:text-ink-500">載入中…</div>;
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

  const counts: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    for (const g of GROUPS) {
      out[g.label] = items.filter((q) => q.group === g.label).length;
    }
    return out;
  }, [items]);

  const countsSummary = GROUPS.map((g) => `${g.label} ${counts[g.label]}`).join(' · ');

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <Link to="/review" className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent">
            ← 回到複習模式
          </Link>
          <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mt-2">
            民國 {year} 年 · {items.length} 題
          </h1>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">{countsSummary}</p>
        </div>
        <Link
          to={`/anki/${year}`}
          className="inline-flex items-center justify-center gap-2 rounded bg-accent hover:bg-accent-dark text-white px-4 py-2 text-sm font-medium transition"
        >
          <BookOpen size={16} />
          Anki FSRS
          {ankiDeck && (
            <span className="inline-flex items-center gap-1 text-xs text-white/80">
              <Clock size={12} />
              今日 {ankiDeck.due_count} · 新卡 {ankiDeck.new_count}
            </span>
          )}
        </Link>
      </header>

      <div className="flex gap-2 mb-4">
        {['all', ...GROUPS.map((g) => g.label)].map((g) => (
          <button
            key={g}
            onClick={() => setGroupFilter(g)}
            className={
              'px-3 py-1 rounded text-sm border transition ' +
              (groupFilter === g
                ? 'bg-accent text-white border-accent'
                : 'bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 border-ink-200 dark:border-ink-700 hover:border-ink-400 dark:hover:border-ink-500')
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
        className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded px-4 py-2 mb-6 focus:outline-none focus:border-accent text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
      />

      <ol className="space-y-2">
        {visible.map((q) => (
          <li key={q.id}>
            <Link
              to={`/q/${q.id}`}
              className="flex gap-3 items-start bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent hover:shadow-paper transition"
            >
              <span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0 w-10 text-right">
                {q.number}.
              </span>
              <BookmarkBadge questionId={q.id} className="mt-1" />
              <span className="text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed">
                {q.stem}
              </span>
              {q.group && (
                <span
                  className={
                    'ml-auto text-[11px] px-2 py-0.5 rounded shrink-0 self-center ' +
                    groupBadgeClass(q.group)
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
