import { useState } from 'react';
import { api } from '../lib/api';
import type { QuestionFull } from '../hooks/useQuestion';

type Props = {
  question: QuestionFull;
  onAnswered?: (chosen: string, correct: boolean) => void;
  onBookmarkToggled?: (bookmarked: boolean) => void;
};

const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

export function QuestionCard({ question, onAnswered, onBookmarkToggled }: Props) {
  const [chosen, setChosen] = useState<string | null>(
    question.my_progress?.last_chosen ?? null,
  );
  const [revealed, setRevealed] = useState(!!question.my_progress?.last_chosen);
  const [bookmarked, setBookmarked] = useState(!!question.my_progress?.bookmarked);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!chosen || submitting) return;
    setSubmitting(true);
    try {
      const r = await api.post<{ correct: boolean; correct_answer: string }>(
        '/api/review/answer',
        { question_id: question.id, chosen },
      );
      setRevealed(true);
      onAnswered?.(chosen, r.correct);
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleBookmark() {
    const next = !bookmarked;
    setBookmarked(next);
    try {
      await api.post('/api/review/bookmark', {
        question_id: question.id,
        bookmarked: next,
      });
      onBookmarkToggled?.(next);
    } catch {
      setBookmarked(!next);
    }
  }

  const options = LETTERS
    .map((L) => ({ L, text: question.options[L] }))
    .filter((o) => !!o.text);

  return (
    <div className="bg-white border border-ink-200 rounded-lg shadow-paper p-5 sm:p-7">
      <header className="flex items-start justify-between gap-3 mb-4">
        <div className="text-sm text-ink-500 font-medium flex items-center flex-wrap gap-x-2 gap-y-1">
          <span>民國 {question.year} 年 · 第 {question.number} 題</span>
          {question.group && (
            <span
              className={
                'inline-block px-2 py-0.5 rounded text-xs ' +
                (question.group === '內科'
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-sky-100 text-sky-800')
              }
            >
              {question.group}
            </span>
          )}
          {question.tags && question.tags.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {question.tags.map((t) => (
                <span
                  key={t}
                  className="inline-block bg-ink-100 text-ink-700 px-2 py-0.5 rounded text-[11px]"
                >
                  #{t}
                </span>
              ))}
            </span>
          )}
        </div>
        <button
          onClick={toggleBookmark}
          className="text-2xl leading-none transition hover:scale-110"
          aria-label={bookmarked ? '取消收藏' : '收藏'}
          title={bookmarked ? '取消收藏' : '收藏'}
        >
          {bookmarked ? '★' : '☆'}
        </button>
      </header>

      <p className="font-serif text-lg sm:text-xl leading-relaxed text-ink-900 whitespace-pre-wrap">
        {question.stem}
      </p>

      <ul className="mt-6 space-y-2.5">
        {options.map(({ L, text }) => {
          const selected = chosen === L;
          const isCorrect = L === question.answer;
          let cls =
            'flex gap-3 items-start p-3 rounded border cursor-pointer transition select-none';
          if (!revealed) {
            cls += selected
              ? ' border-accent bg-accent/5'
              : ' border-ink-200 hover:border-ink-400 hover:bg-ink-50';
          } else {
            if (isCorrect)
              cls += ' border-emerald-500 bg-emerald-50';
            else if (selected)
              cls += ' border-rose-500 bg-rose-50';
            else cls += ' border-ink-200 opacity-70';
          }
          return (
            <li
              key={L}
              className={cls}
              onClick={() => !revealed && setChosen(L)}
            >
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-current text-sm font-semibold shrink-0">
                {L}
              </span>
              <span className="leading-relaxed text-ink-800">{text}</span>
              {revealed && isCorrect && (
                <span className="ml-auto text-emerald-700 text-sm font-medium">正解</span>
              )}
              {revealed && selected && !isCorrect && (
                <span className="ml-auto text-rose-700 text-sm font-medium">你的選擇</span>
              )}
            </li>
          );
        })}
      </ul>

      {!revealed && (
        <div className="mt-6 flex gap-3 justify-end">
          <button
            onClick={() => setRevealed(true)}
            className="text-ink-500 px-4 py-2 text-sm hover:text-ink-700"
          >
            略過 / 直接看答案
          </button>
          <button
            onClick={submit}
            disabled={!chosen || submitting}
            className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40 transition"
          >
            提交答案
          </button>
        </div>
      )}

      {revealed && (
        <div className="mt-6 pt-4 border-t border-ink-100 text-sm text-ink-600">
          {chosen === question.answer ? (
            <span className="text-emerald-700 font-medium">✓ 答對了</span>
          ) : chosen ? (
            <span className="text-rose-700 font-medium">
              ✗ 你選 {chosen},正解 {question.answer}
            </span>
          ) : (
            <span>正解 {question.answer}</span>
          )}
          {question.my_progress && question.my_progress.times_seen > 0 && (
            <span className="ml-3 text-ink-400">
              · 已看過 {question.my_progress.times_seen} 次,答對{' '}
              {question.my_progress.times_correct} 次
            </span>
          )}
        </div>
      )}
    </div>
  );
}
