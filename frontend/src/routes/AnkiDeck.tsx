import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Clock } from 'lucide-react';
import { api } from '../lib/api';
import {
  AnkiCardView,
  formatDueAt,
  ratingText,
  type AnkiQuestion,
  type FsrsCard,
  type RatingKey,
} from '../components/AnkiCardView';

type DeckStats = {
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
type NextPayload = {
  deck: DeckStats | null;
  question: AnkiQuestion | null;
};
type ReviewPayload = {
  ok: true;
  rating: RatingKey;
  correct: boolean | null;
  correct_answer: string;
  card: FsrsCard;
};

export function AnkiDeck() {
  const { year } = useParams<{ year: string }>();
  const [payload, setPayload] = useState<NextPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [grading, setGrading] = useState<RatingKey | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadNext = useCallback(async () => {
    if (!year) return;
    setLoading(true);
    setError(null);
    try {
      const next = await api.get<NextPayload>(`/api/review/anki/decks/${year}/next`);
      setPayload(next);
      setChosen(null);
      setRevealed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  const q = payload?.question ?? null;
  const deck = payload?.deck ?? null;

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
      await loadNext();
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
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <Link
            to="/review"
            className="inline-flex items-center gap-1 text-sm text-ink-500 dark:text-ink-400 hover:text-accent"
          >
            <ChevronLeft size={16} /> 回到複習
          </Link>
          <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mt-2">
            Anki · 民國 {year} 年
          </h1>
          {deck && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500 dark:text-ink-400">
              <span>今日 {deck.due_count}</span>
              <span>新卡 {deck.new_count}</span>
              <span>已讀 {deck.studied_count}/{deck.count}</span>
              {deck.next_due_at && deck.due_count === 0 && (
                <span>下次 {formatDueAt(deck.next_due_at)}</span>
              )}
            </div>
          )}
        </div>
        {deck && (
          <div className="hidden sm:grid grid-cols-3 gap-2 text-center text-xs">
            <DeckMetric label="Learning" value={deck.learning_count} />
            <DeckMetric label="Review" value={deck.review_count} />
            <DeckMetric label="Due" value={deck.due_review_count} />
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
          <Clock size={28} className="mx-auto text-ink-400 dark:text-ink-500 mb-3" />
          <h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">
            目前沒有到期卡片
          </h2>
          <p className="text-sm text-ink-500 dark:text-ink-400">
            {deck?.next_due_at ? `下一張: ${formatDueAt(deck.next_due_at)}` : '這副牌已完成。'}
          </p>
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

function DeckMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-20 rounded border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 px-3 py-2">
      <div className="font-mono text-lg text-ink-900 dark:text-ink-100">{value}</div>
      <div className="text-[11px] text-ink-400 dark:text-ink-500">{label}</div>
    </div>
  );
}
