import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

type Session = {
  id: string;
  year: number;
  started_at: number;
  finished_at: number | null;
  score: number | null;
  duration_sec: number | null;
};

export function ExamHistory() {
  const [rows, setRows] = useState<Session[] | null>(null);

  useEffect(() => {
    api.get<Session[]>('/api/exam').then(setRows);
  }, []);

  if (rows === null) return <div className="p-8 text-center text-ink-400">載入中…</div>;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 mb-6">作答紀錄</h1>

      {rows.length === 0 ? (
        <p className="text-ink-400">尚未完成任何模擬考。</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => {
            const done = !!s.finished_at;
            return (
              <li key={s.id}>
                <Link
                  to={done ? `/exam/${s.id}/result` : `/exam/${s.id}`}
                  className="flex items-center gap-3 bg-white border border-ink-200 rounded p-3 hover:border-accent hover:shadow-paper transition"
                >
                  <span className="font-serif text-xl text-ink-900 w-16 text-center shrink-0">
                    {s.year}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-ink-500">
                      {new Date(s.started_at).toLocaleString('zh-TW')}
                    </div>
                    {!done && (
                      <div className="text-xs text-amber-700 mt-0.5">未完成 · 點擊繼續</div>
                    )}
                  </div>
                  {done && s.score !== null && (
                    <div className="text-right shrink-0">
                      <div className="font-serif text-xl text-ink-900">{s.score}</div>
                      <div className="text-[10px] text-ink-400">
                        {Math.floor((s.duration_sec ?? 0) / 60)} 分
                      </div>
                    </div>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
