import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { api } from '../lib/api';

type RecentChallenge = {
  id: string;
  question_id: string;
  year: number;
  number: number;
  stem: string;
  proposer_name: string | null;
  proposer_email: string;
  proposed_answer: string;
  original_answer_at_challenge: string;
  status: 'open' | 'contested' | 'promoted' | 'rejected';
  contested_at: number | null;
  created_at: number;
  resolved_at: number | null;
  agrees: number;
  disagrees: number;
};

export function Challenges() {
  const [challenges, setChallenges] = useState<RecentChallenge[]>([]);
  const [filter, setFilter] = useState<'all' | 'active' | 'promoted' | 'rejected'>('active');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<RecentChallenge[]>('/api/challenges/recent?limit=100&include=resolved')
      .then(setChallenges)
      .catch(() => setChallenges([]))
      .finally(() => setLoading(false));
  }, []);

  const visible = challenges.filter((c) =>
    filter === 'all'
      ? true
      : filter === 'active'
      ? c.status === 'open' || c.status === 'contested'
      : c.status === filter,
  );

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex items-center gap-3 flex-wrap mb-6">
        <h1 className="font-serif text-2xl text-ink-900 dark:text-ink-100 inline-flex items-center gap-2">
          <Scale size={22} className="text-amber-700 dark:text-amber-300" /> 答案挑戰
        </h1>
        <div className="flex gap-1.5 ml-auto">
          {(
            [
              { key: 'all', label: '全部' },
              { key: 'active', label: '表決中' },
              { key: 'promoted', label: '已採納' },
              { key: 'rejected', label: '已駁回' },
            ] as const
          ).map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={
                'px-2.5 py-1 rounded text-xs transition ' +
                (filter === f.key
                  ? 'bg-accent text-white'
                  : 'bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300 hover:bg-ink-200 dark:hover:bg-ink-600')
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-ink-500 dark:text-ink-400 italic">載入中…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-ink-500 dark:text-ink-400 italic">
          {challenges.length === 0
            ? '目前還沒有人對任何題目提出答案挑戰。'
            : '沒有符合此狀態的挑戰。'}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((c) => {
            const qid = `${c.year}-${String(c.number).padStart(3, '0')}`;
            const statusLabel =
              c.status === 'promoted' ? '已採納' : c.status === 'rejected' ? '已駁回' : '表決中';
            const statusCls =
              c.status === 'promoted'
                ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200'
                : c.status === 'rejected'
                ? 'bg-ink-100 dark:bg-ink-900/30 text-ink-600 dark:text-ink-400'
                : 'bg-sky-100 dark:bg-sky-900/30 text-sky-800 dark:text-sky-200';
            return (
              <li key={c.id}>
                <Link
                  to={`/q/${qid}`}
                  className="block bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent transition"
                >
                  <div className="flex items-start gap-2 flex-wrap text-sm">
                    <span className="font-mono text-ink-500 dark:text-ink-400 shrink-0">{qid}</span>
                    <span className="text-ink-700 dark:text-ink-200 line-clamp-1 flex-1 min-w-0">
                      {c.stem}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-[11px] shrink-0 ${statusCls}`}>
                      {statusLabel}
                    </span>
                  </div>
                  <div className="mt-1.5 text-xs text-ink-500 dark:text-ink-400 flex items-center gap-2 flex-wrap">
                    <span>
                      {c.proposer_name ?? c.proposer_email.split('@')[0]} 主張{' '}
                      <span className="font-mono">{c.original_answer_at_challenge}</span> →{' '}
                      <span className="font-mono font-semibold text-amber-700 dark:text-amber-300">
                        {c.proposed_answer}
                      </span>
                    </span>
                    <span className="text-ink-400 dark:text-ink-500">
                      · 同意 {c.agrees} · 反對 {c.disagrees}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
