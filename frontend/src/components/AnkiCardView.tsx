import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { BookOpen, Check, Clock, Loader2, RotateCcw, X } from 'lucide-react';
import { ReadOnlyContent } from './ReadOnlyContent';
import { groupBadgeClass } from '../lib/groups';

export type RatingKey = 'again' | 'hard' | 'good' | 'easy';
export type FsrsPreview = {
  due_at: number;
  scheduled_days: number;
  state: number;
};
export type FsrsCard = {
  due_at: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review_at: number | null;
};
export type AnkiQuestion = {
  id: string;
  year: number;
  number: number;
  stem: string;
  options: Record<string, string>;
  answer: string;
  group: string | null;
  tags: string[];
  explanation: {
    question_id: string;
    content_json: string;
    version: number;
    updated_by?: string | null;
    updated_at?: number | null;
  } | null;
  fsrs: {
    card: FsrsCard | null;
    preview: Record<RatingKey, FsrsPreview>;
    retrievability: number | null;
  };
};

const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

type Props = {
  question: AnkiQuestion;
  chosen: string | null;
  onChoose: (letter: string) => void;
  revealed: boolean;
  onReveal: () => void;
  grading: RatingKey | null;
  onGrade: (rating: RatingKey) => void;
};

/**
 * 單張 Anki 卡的呈現層 — 選項、揭曉、四顆 FSRS 評分鈕。
 * 由 /anki/:year(逐年入口)與 /due(跨年份到期佇列)共用,狀態全部由呼叫端持有。
 */
export function AnkiCardView({
  question: q,
  chosen,
  onChoose,
  revealed,
  onReveal,
  grading,
  onGrade,
}: Props) {
  const options = useMemo(
    () => LETTERS.map((L) => ({ L, text: q.options[L] })).filter((o) => !!o.text),
    [q.options],
  );
  const explanationJson = useMemo(() => {
    if (!q.explanation?.content_json) return null;
    try {
      return JSON.parse(q.explanation.content_json);
    } catch {
      return null;
    }
  }, [q.explanation?.content_json]);

  return (
    <article
      data-testid="anki-card"
      className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-paper p-5 sm:p-7"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="text-sm text-ink-500 dark:text-ink-400 font-medium flex items-center flex-wrap gap-x-2 gap-y-1">
          <span>民國 {q.year} 年 · 第 {q.number} 題</span>
          {q.group && (
            <span
              className={
                'inline-block px-2 py-0.5 rounded text-xs ' +
                groupBadgeClass(q.group)
              }
            >
              {q.group}
            </span>
          )}
          {q.tags.map((tag) => (
            <span
              key={tag}
              className="inline-block bg-ink-100 dark:bg-ink-700 text-ink-700 dark:text-ink-200 px-2 py-0.5 rounded text-[11px]"
            >
              #{tag}
            </span>
          ))}
        </div>
        {q.fsrs.retrievability !== null && (
          <span className="shrink-0 text-xs font-mono text-ink-400 dark:text-ink-500">
            R {Math.round(q.fsrs.retrievability * 100)}%
          </span>
        )}
      </div>

      <p className="font-serif text-lg sm:text-xl leading-relaxed text-ink-900 dark:text-ink-100 whitespace-pre-wrap">
        {q.stem}
      </p>

      <ul className="mt-6 space-y-2.5">
        {options.map(({ L, text }) => {
          const selected = chosen === L;
          const isCorrect = L === q.answer;
          let cls =
            'flex gap-3 items-start p-3 rounded border cursor-pointer transition select-none';
          if (!revealed) {
            cls += selected
              ? ' border-accent bg-accent/5 dark:bg-accent/15'
              : ' border-ink-200 dark:border-ink-700 hover:border-ink-400 dark:hover:border-ink-500 hover:bg-ink-50 dark:hover:bg-ink-700/40';
          } else if (isCorrect) {
            cls += ' border-emerald-500 bg-emerald-50 dark:bg-emerald-500/15';
          } else if (selected) {
            cls += ' border-rose-500 bg-rose-50 dark:bg-rose-500/15';
          } else {
            cls += ' border-ink-200 dark:border-ink-700 opacity-70';
          }
          return (
            <li
              key={L}
              className={cls}
              onClick={() => !revealed && onChoose(L)}
            >
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-current text-sm font-semibold shrink-0">
                {L}
              </span>
              {/* min-w-0 + break-words:同 QuestionCard —— 長基因命名不斷行時
                  會把「✓ 正解」擠出卡片。 */}
              <span className="min-w-0 break-words leading-relaxed text-ink-800 dark:text-ink-200">
                {text}
              </span>
              {revealed && isCorrect && (
                <span className="ml-auto inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 text-sm font-medium shrink-0">
                  <Check size={16} /> 正解
                </span>
              )}
              {revealed && selected && !isCorrect && (
                <span className="ml-auto inline-flex items-center gap-1 text-rose-700 dark:text-rose-300 text-sm font-medium shrink-0">
                  <X size={16} /> 你的選擇
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {!revealed ? (
        <div className="mt-6 flex justify-end">
          <button
            data-testid="anki-show-answer"
            type="button"
            onClick={onReveal}
            className="inline-flex items-center gap-2 bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium transition"
          >
            <BookOpen size={16} />
            顯示答案
          </button>
        </div>
      ) : (
        <>
          <section className="mt-6 pt-5 border-t border-ink-100 dark:border-ink-700">
            <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-medium">
                <Check size={16} /> 正解 {q.answer}
              </span>
              {chosen && chosen !== q.answer && (
                <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300 font-medium">
                  <X size={16} /> 你選 {chosen}
                </span>
              )}
            </div>

            <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ratingOrder.map((rating) => (
                <RatingButton
                  key={rating}
                  rating={rating}
                  preview={q.fsrs.preview[rating]}
                  busy={grading === rating}
                  disabled={!!grading}
                  onClick={() => onGrade(rating)}
                />
              ))}
            </div>

            {explanationJson ? (
              <div className="prose-answer">
                <ReadOnlyContent content={explanationJson} />
              </div>
            ) : (
              <div className="rounded border border-dashed border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-900/30 p-4 text-sm text-ink-500 dark:text-ink-400">
                尚無詳解。
              </div>
            )}
          </section>
        </>
      )}
    </article>
  );
}

function RatingButton({
  rating,
  preview,
  busy,
  disabled,
  onClick,
}: {
  rating: RatingKey;
  preview: FsrsPreview;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const cfg = ratingConfig[rating];
  const Icon = cfg.Icon;
  return (
    <button
      data-testid={`anki-rating-${rating}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'min-h-16 rounded border px-3 py-2 text-left transition disabled:opacity-50 ' +
        cfg.className
      }
    >
      <span className="flex items-center gap-2 font-medium">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
        {cfg.label}
      </span>
      <span className="mt-1 block text-xs opacity-75">{formatDueDelta(preview.due_at)}</span>
    </button>
  );
}

const ratingOrder: RatingKey[] = ['again', 'hard', 'good', 'easy'];
export const ratingText: Record<RatingKey, string> = {
  again: '重來',
  hard: '困難',
  good: '良好',
  easy: '簡單',
};
const ratingConfig: Record<
  RatingKey,
  { label: string; Icon: LucideIcon; className: string }
> = {
  again: {
    label: '重來',
    Icon: RotateCcw,
    className:
      'border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-200',
  },
  hard: {
    label: '困難',
    Icon: Clock,
    className:
      'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200',
  },
  good: {
    label: '良好',
    Icon: Check,
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-200',
  },
  easy: {
    label: '簡單',
    Icon: BookOpen,
    className:
      'border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-900/20 dark:text-sky-200',
  },
};

function formatDueDelta(dueAt: number) {
  const diff = dueAt - Date.now();
  if (diff <= 45_000) return '現在';
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours} 小時`;
  return `${Math.ceil(hours / 24)} 天`;
}

// 真正的實作住在 lib/due.ts(首頁 CTA 也要用),這裡只 re-export 給兩支
// 卡片頁沿用既有的 import 路徑。
export { formatDueAt } from '../lib/due';
