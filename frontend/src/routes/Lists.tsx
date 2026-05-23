import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { X as XIcon } from 'lucide-react';
import { api } from '../lib/api';

type Row = {
  id: string;
  year: number;
  number: number;
  stem: string;
  group: '內科' | '共同' | null;
  times_seen?: number;
  times_correct?: number;
};

type Year = { year: number; count: number };
type Tag = { tag: string; count: number };

export function WrongQuestions() {
  const [year, setYear] = useState('');
  const [group, setGroup] = useState('');
  const [tagSet, setTagSet] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [years, setYears] = useState<Year[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  useEffect(() => {
    api.get<Year[]>('/api/questions/_meta/years').then(setYears);
    api.get<Tag[]>('/api/questions/_meta/tags').then(setAllTags);
  }, []);

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    if (year) sp.set('year', year);
    if (group) sp.set('group', group);
    if (tagSet.size > 0) sp.set('tags', [...tagSet].join(','));
    return sp.toString();
  }, [year, group, tagSet]);

  useEffect(() => {
    setRows(null);
    api.get<Row[]>(`/api/review/wrong${query ? '?' + query : ''}`).then(setRows);
  }, [query]);

  function toggleTag(t: string) {
    setTagSet((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-4">錯題回顧</h1>
      <p className="text-sm text-ink-500 dark:text-ink-400 mb-6">複習模式中答錯的題目,按錯誤率排序。</p>

      <div className="flex flex-wrap gap-2 mb-3 items-center text-sm">
        <select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
        >
          <option value="">所有年度</option>
          {years.map((y) => (
            <option key={y.year} value={y.year}>民國 {y.year}{y.year === 100 ? ' (模擬)' : ''}</option>
          ))}
        </select>
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
        >
          <option value="">所有 group</option>
          <option value="內科">內科</option>
          <option value="共同">共同</option>
        </select>
        {tagSet.size > 0 && (
          <button
            onClick={() => setTagSet(new Set())}
            className="text-xs text-ink-500 hover:text-rose-600 inline-flex items-center gap-1"
          >
            <XIcon size={12} /> 清除 {tagSet.size} 個 tag
          </button>
        )}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-6">
          {allTags.slice(0, 40).map((t) => {
            const on = tagSet.has(t.tag);
            return (
              <button
                key={t.tag}
                onClick={() => toggleTag(t.tag)}
                className={
                  'text-[11px] px-2 py-0.5 rounded transition ' +
                  (on
                    ? 'bg-accent text-white'
                    : 'bg-ink-100 dark:bg-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-200')
                }
              >
                #{t.tag} <span className="opacity-60">{t.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {rows === null ? (
        <div className="text-ink-400 text-sm">載入中…</div>
      ) : rows.length === 0 ? (
        <p className="text-ink-400 text-sm">目前還沒有錯題紀錄 (在這個 filter 下)。</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                to={`/q/${r.id}`}
                className="flex gap-3 items-start bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent hover:shadow-paper transition"
              >
                <span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0 w-16 text-right">
                  {r.year}-{String(r.number).padStart(3, '0')}
                </span>
                <span className="text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed flex-1">{r.stem}</span>
                {r.group && (
                  <span className={
                    'text-[11px] px-2 py-0.5 rounded shrink-0 self-center ' +
                    (r.group === '內科'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-sky-100 text-sky-800')
                  }>{r.group}</span>
                )}
                {r.times_seen !== undefined && r.times_correct !== undefined && (
                  <span className="text-xs text-ink-500 shrink-0 self-center">
                    {r.times_correct}/{r.times_seen}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
