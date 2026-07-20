import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronLeft } from 'lucide-react';
import { api } from '../lib/api';
import { dueKindLabel, type DueKind, type DueSummary } from '../lib/due';
import {
  AnkiCardView,
  formatDueAt,
  ratingText,
  type AnkiQuestion,
  type FsrsCard,
  type RatingKey,
} from '../components/AnkiCardView';

type DuePayload = {
  queue: DueSummary;
  kind: DueKind | null;
  question: AnkiQuestion | null;
};
type ReviewPayload = {
  ok: true;
  rating: RatingKey;
  correct: boolean | null;
  correct_answer: string;
  card: FsrsCard;
};

/**
 * 「今天該複習什麼」的單一入口 —— 跨全部年份、按 due_at 排序。
 * 排程與寫入完全沿用既有路徑:評分打 POST /api/review/anki/review,
 * 與逐年的 /anki/:year 是同一支 API。逐年入口仍在,兩者並存。
 */
export function DueQueue() {
  const [payload, setPayload] = useState<DuePayload | null>(null);
  const [served, setServed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [grading, setGrading] = useState<RatingKey | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadNext = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.get<DuePayload>(`/api/review/due/next?served=${served}`);
      setPayload(next);
      setChosen(null);
      setRevealed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [served]);

  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  const q = payload?.question ?? null;
  const queue = payload?.queue ?? null;
  const kind = payload?.kind ?? null;

  async function grade(rating: RatingKey) {
    if (!q || grading) return;
    setGrading(rating);
    setError(null);
    try {
      const result = await api.post<ReviewPayload>('/api/review/anki/review', {
        question_id: q.id,
        rating,
        chosen,
      });
      setNotice(`已用 ${ratingText[rating]} 排程: ${formatDueAt(result.card.due_at)}`);
      // served 前進會觸發 loadNext(它依賴 served),新卡交錯的節奏由伺服器決定。
      setServed((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGrading(null);
    }
  }

  if (loading && !payload) {
    return <div className="p-8 text-center text-ink-400 dark:text-ink-500">載入中…</div>;
  }

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-28">
      <header className="mb-5">
        <Link
          to="/review"
          className="inline-flex items-center gap-1 text-sm text-ink-500 dark:text-ink-400 hover:text-accent"
        >
          <ChevronLeft size={16} /> 回到複習
        </Link>
        <div className="mt-2 flex items-center flex-wrap gap-x-3 gap-y-2">
          <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100">今日複習</h1>
          {kind && (
            <span className="inline-block rounded-full border border-accent/50 text-accent px-2.5 py-0.5 text-xs">
              {dueKindLabel[kind]}
            </span>
          )}
        </div>
        {queue && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500 dark:text-ink-400">
            <span>
              今天 <span className="font-mono text-ink-700 dark:text-ink-200">{queue.due_total}</span> 張
            </span>
            <span>到期 {queue.due_review}</span>
            <span>學習中 {queue.learning}</span>
            <span>新卡 {queue.new_remaining}</span>
            {served > 0 && <span>本次已完成 {served}</span>}
            <span className="text-ink-400 dark:text-ink-500">
              一天從凌晨 {queue.day_start_hour} 點算起
            </span>
          </div>
        )}
      </header>

      {notice && (
        <div className="mb-4 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20 px-3 py-2 text-sm text-rose-800 dark:text-rose-200">
          {error}
        </div>
      )}

      {!q ? (
        <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-8 sm:p-10 text-center shadow-paper">
          <Check size={28} className="mx-auto text-accent mb-3" />
          <h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">
            今天的複習做完了
          </h2>
          <p className="text-sm text-ink-500 dark:text-ink-400 leading-relaxed">
            {served > 0 && `本次完成 ${served} 張。`}
            {queue?.next_due_at ? `下一張 ${formatDueAt(queue.next_due_at)}。` : ''}
            {queue && queue.new_remaining === 0 && queue.new_available > 0
              ? `今日新卡額度已用完 (還有 ${queue.new_available} 張未學)。`
              : ''}
          </p>
          <Link
            to="/review"
            className="mt-4 inline-block text-accent hover:text-accent-dark"
          >
            回到複習模式 →
          </Link>
        </div>
      ) : (
        <AnkiCardView
          question={q}
          chosen={chosen}
          onChoose={setChosen}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          grading={grading}
          onGrade={grade}
        />
      )}
    </div>
  );
}
