import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
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
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.get<Session[]>('/api/exam').then(setRows);
  }, []);

  async function remove(s: Session) {
    const label = s.finished_at
      ? `民國 ${s.year} · ${new Date(s.started_at).toLocaleDateString('zh-TW')} · 分數 ${s.score ?? '-'}`
      : `民國 ${s.year} · ${new Date(s.started_at).toLocaleString('zh-TW')} (未完成)`;
    if (!confirm(`刪除這筆作答紀錄?\n${label}`)) return;
    setBusy(s.id);
    try {
      await api.del(`/api/exam/${s.id}`);
      setRows((prev) => prev?.filter((r) => r.id !== s.id) ?? null);
    } catch (e) {
      alert('刪除失敗:' + String(e));
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return <div className="p-8 text-center text-ink-400">載入中…</div>;

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-6">作答紀錄</h1>

      {rows.length === 0 ? (
        <p className="text-ink-400 dark:text-ink-500">尚未完成任何模擬考。</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => {
            const done = !!s.finished_at;
            return (
              <li
                key={s.id}
                className="flex items-stretch gap-2 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded hover:border-accent hover:shadow-paper transition"
              >
                <Link
                  to={done ? `/exam/${s.id}/result` : `/exam/${s.id}`}
                  className="flex items-center gap-3 p-3 flex-1 min-w-0"
                >
                  <span className="font-serif text-xl text-ink-900 dark:text-ink-100 w-16 text-center shrink-0">
                    {s.year}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-ink-500 dark:text-ink-400">
                      {new Date(s.started_at).toLocaleString('zh-TW')}
                    </div>
                    {!done && (
                      <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">未完成 · 點擊繼續</div>
                    )}
                  </div>
                  {done && s.score !== null && (
                    <div className="text-right shrink-0">
                      <div className="font-serif text-xl text-ink-900 dark:text-ink-100">{s.score}</div>
                      <div className="text-[10px] text-ink-400 dark:text-ink-500">
                        {Math.floor((s.duration_sec ?? 0) / 60)} 分
                      </div>
                    </div>
                  )}
                </Link>
                <button
                  onClick={() => remove(s)}
                  disabled={busy === s.id}
                  aria-label="刪除這筆紀錄"
                  className="px-3 text-ink-400 dark:text-ink-500 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-40"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
