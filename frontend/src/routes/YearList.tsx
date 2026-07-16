import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, Check, Clock, X } from 'lucide-react';
import { api } from '../lib/api';
import { BookmarkBadge } from '../components/BookmarkBadge';
import { GROUPS, groupBadgeClass } from '../lib/groups';
import { ResumeChip } from '../components/ResumeChip';
import {
  loadYearPosition,
  clearYearPosition,
  type YearPosition,
} from '../lib/lastPath';

type QListItem = {
  id: string;
  year: number;
  number: number;
  stem: string;
  group: string | null;
  difficulty: number | null;
  times_seen: number | null; // from review_progress; null = never answered
  last_correct: number | null; // 1/0 for the latest attempt
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
  // 「你上次停在…」 for this specific year, synced across devices, never expires.
  const [resume, setResume] = useState<YearPosition | null>(null);

  useEffect(() => {
    if (!year) return;
    setResume(null);
    api
      .get<QListItem[]>(`/api/questions?year=${year}&limit=200`)
      .then(setItems);
    api
      .get<AnkiDeckStats[]>('/api/review/anki/decks')
      .then((decks) => setAnkiDeck(decks.find((d) => String(d.year) === year) ?? null))
      .catch(() => setAnkiDeck(null));
    let cancelled = false;
    loadYearPosition(Number(year)).then((v) => {
      if (!cancelled) setResume(v);
    });
    return () => {
      cancelled = true;
    };
  }, [year]);

  // NOTE: this hook must stay ABOVE the early return below. A hook called
  // after a conditional return runs a different number of times between the
  // loading render (items === null) and the loaded render → React error #310.
  const counts: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    if (!items) return out;
    for (const g of GROUPS) {
      out[g.label] = items.filter((q) => q.group === g.label).length;
    }
    return out;
  }, [items]);

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

  const countsSummary = GROUPS.map((g) => `${g.label} ${counts[g.label]}`).join(' · ');

  // Label the resume chip with the question's number, looked up from the loaded
  // list — the id/number mapping isn't always positional, so never derive it.
  const resumeItem = resume ? items.find((q) => q.id === resume.questionId) : null;

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

      {resumeItem && (
        <div className="mb-4">
          <ResumeChip
            prefix="你上次停在"
            label={`第 ${resumeItem.number} 題`}
            to={`/q/${resumeItem.id}`}
            onDismiss={() => {
              clearYearPosition(Number(year));
              setResume(null);
            }}
          />
        </div>
      )}

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
        {visible.map((q) => {
          const answered = (q.times_seen ?? 0) > 0;
          const correct = answered && q.last_correct === 1;
          return (
            <li key={q.id}>
              <Link
                to={`/q/${q.id}`}
                className={
                  'flex gap-3 items-start border rounded p-3 hover:border-accent hover:shadow-paper transition ' +
                  (!answered
                    ? 'bg-white dark:bg-ink-800 border-ink-200 dark:border-ink-700'
                    : correct
                      ? 'bg-emerald-50/60 dark:bg-emerald-900/15 border-emerald-200 dark:border-emerald-800/60'
                      : 'bg-rose-50/60 dark:bg-rose-900/15 border-rose-200 dark:border-rose-800/60')
                }
              >
                <span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0 w-10 text-right">
                  {q.number}.
                </span>
                {answered &&
                  (correct ? (
                    <Check
                      size={16}
                      className="mt-1 shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-label="上次答對"
                    />
                  ) : (
                    <X
                      size={16}
                      className="mt-1 shrink-0 text-rose-600 dark:text-rose-400"
                      aria-label="上次答錯"
                    />
                  ))}
                <BookmarkBadge questionId={q.id} className="mt-1" />
                <span
                  className={
                    'line-clamp-2 leading-relaxed ' +
                    (answered
                      ? 'text-ink-600 dark:text-ink-400'
                      : 'text-ink-800 dark:text-ink-200')
                  }
                >
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
          );
        })}
      </ol>
    </div>
  );
}
