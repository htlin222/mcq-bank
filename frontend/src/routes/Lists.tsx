import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

type Row = {
  id: string;
  year: number;
  number: number;
  stem: string;
  times_seen?: number;
  times_correct?: number;
};

export function Bookmarks() {
  return (
    <SimpleQList
      title="我的收藏"
      endpoint="/api/review/bookmarks"
      emptyText="尚無收藏題目。在複習模式中點 ☆ 即可收藏。"
    />
  );
}

export function WrongQuestions() {
  return (
    <SimpleQList
      title="錯題回顧"
      endpoint="/api/review/wrong"
      emptyText="目前還沒有錯題紀錄。"
      showStats
    />
  );
}

function SimpleQList({
  title,
  endpoint,
  emptyText,
  showStats,
}: {
  title: string;
  endpoint: string;
  emptyText: string;
  showStats?: boolean;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    api.get<Row[]>(endpoint).then(setRows);
  }, [endpoint]);

  if (rows === null) return <div className="p-8 text-center text-ink-400">載入中…</div>;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 mb-6">{title}</h1>

      {rows.length === 0 ? (
        <p className="text-ink-400">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                to={`/q/${r.id}`}
                className="flex gap-3 items-start bg-white border border-ink-200 rounded p-3 hover:border-accent hover:shadow-paper transition"
              >
                <span className="font-mono text-sm text-ink-500 shrink-0 w-16 text-right">
                  {r.year}-{String(r.number).padStart(3, '0')}
                </span>
                <span className="text-ink-800 line-clamp-2 leading-relaxed">{r.stem}</span>
                {showStats &&
                  r.times_seen !== undefined &&
                  r.times_correct !== undefined && (
                    <span className="ml-auto text-xs text-ink-500 shrink-0 self-center">
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
