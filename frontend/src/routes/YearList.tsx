import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BookOpen, Check, Clock, X } from 'lucide-react';
import { api } from '../lib/api';
import { BookmarkBadge } from '../components/BookmarkBadge';
import { GROUPS, groupBadgeClass } from '../lib/groups';
import { ResumeChip } from '../components/ResumeChip';
import { ExportButton } from '../components/ExportDialog';
import { GamepadFab, type GamepadHint } from '../components/GamepadFab';
import { useGamepad, useGamepadConnected } from '../hooks/useGamepad';
import { useYearPrefetch } from '../hooks/useYearPrefetch';
import { useYearImages } from '../hooks/useYearImages';
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
type AnswerFilter = 'all' | 'answered' | 'unanswered' | 'correct' | 'wrong';

const ANSWER_FILTERS: { key: AnswerFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'answered', label: '已作答' },
  { key: 'unanswered', label: '未作答' },
  { key: 'correct', label: '答對' },
  { key: 'wrong', label: '答錯' },
];

// Derive answered/correct the same way the list rows do, then test one filter.
function matchesAnswer(q: QListItem, f: AnswerFilter): boolean {
  const answered = (q.times_seen ?? 0) > 0;
  const correct = answered && q.last_correct === 1;
  switch (f) {
    case 'answered':
      return answered;
    case 'unanswered':
      return !answered;
    case 'correct':
      return correct;
    case 'wrong':
      return answered && !correct;
    default:
      return true;
  }
}

const GROUP_FILTER_KEYS = ['all', ...GROUPS.map((g) => g.label)];

// 只有十字鍵會長按連發(見 lib/gamepad.ts 的 REPEATABLE),所以「可長按」這句
// 不能順手加到 L1/R1 上 —— 押著肩鍵等它自己跑,是等不到的。
const YEAR_HINTS: GamepadHint[] = [
  { btn: 'DPAD ↑ ↓', label: '移動游標(可長按連續移動,到底繞回另一端)' },
  { btn: 'DPAD ← →', label: '作答狀態篩選:全部 / 已作答 / 未作答 / 答對 / 答錯' },
  { btn: 'FACE ▼', label: '進入游標所在那一題' },
  { btn: 'L1 / R1', label: '游標 −10 筆 / +10 筆(不連發,一下一次)' },
  { btn: 'L2 / R2', label: '切換科別篩選(含「全部」)' },
  { btn: 'START', label: '回複習模式首頁' },
  { btn: 'SELECT', label: '開關這份說明' },
];

// 在一組固定選項裡循環,給篩選列用。
function cycle<T>(arr: readonly T[], cur: T, dir: 1 | -1): T {
  const i = arr.indexOf(cur);
  return arr[((i < 0 ? 0 : i) + dir + arr.length) % arr.length];
}

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
  const navigate = useNavigate();
  const [items, setItems] = useState<QListItem[] | null>(null);
  const [ankiDeck, setAnkiDeck] = useState<AnkiDeckStats | null>(null);
  const [filter, setFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [answerFilter, setAnswerFilter] = useState<AnswerFilter>('all');
  // 「你上次停在…」 for this specific year, synced across devices, never expires.
  const [resume, setResume] = useState<YearPosition | null>(null);

  // 進來之後在 idle 時把這一年的 payload 拓進 SW 快取,好讓之後離線也讀得到。
  // 判準與並行度都在 lib/yearPrefetch.ts;這裡只把題號交出去。
  // 設計:docs/plans/2026-08-27-offline-year-prefetch-design.md
  const offlineIds = useMemo(() => (items ?? []).map((q) => q.id), [items]);
  const offline = useYearPrefetch(year, offlineIds);
  // 圖片是第二期,而且**不自動拓**:一年 8-17 MB,在行動網路上是真的錢。
  // 只有文字拓完之後才去算張數 —— 快取裡只有一半的 payload 時算出來會偏低,
  // 而按鈕上那個數字正是使用者用來決定要不要按的依據。
  const images = useYearImages(offlineIds, offline.kind === 'ready');

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

  // Answer-filter counts, scoped to the currently-selected group so the badges
  // match what each button would actually show.
  const answerCounts: Record<AnswerFilter, number> = useMemo(() => {
    const base = { all: 0, answered: 0, unanswered: 0, correct: 0, wrong: 0 };
    if (!items) return base;
    const scoped =
      groupFilter === 'all' ? items : items.filter((q) => q.group === groupFilter);
    for (const { key } of ANSWER_FILTERS) {
      base[key] = scoped.filter((q) => matchesAnswer(q, key)).length;
    }
    return base;
  }, [items, groupFilter]);

  // Computed above the early return so the gamepad handler below — which is a
  // hook, and so must run on the loading render too — can see the list.
  const visible = useMemo(
    () =>
      (items ?? []).filter((q) => {
        if (groupFilter !== 'all' && q.group !== groupFilter) return false;
        if (!matchesAnswer(q, answerFilter)) return false;
        if (!filter) return true;
        return (
          String(q.number).includes(filter) ||
          q.stem.includes(filter) ||
          (q.group ?? '').includes(filter)
        );
      }),
    [items, groupFilter, answerFilter, filter],
  );

  // Gamepad cursor over the visible rows. Only drawn while a pad is attached —
  // a stray focus ring on a mouse-driven list is just noise.
  const { connected: padOn } = useGamepadConnected();
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef<HTMLLIElement>(null);
  // 篩選一變,原本的索引就指向別題了 —— 歸零比「猜使用者想留在哪」誠實。
  useEffect(() => {
    setCursor(0);
  }, [groupFilter, answerFilter, filter]);
  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useGamepad((action) => {
    const n = visible.length;
    switch (action) {
      case 'up':
        if (n) setCursor((c) => (c - 1 + n) % n);
        break;
      case 'down':
        if (n) setCursor((c) => (c + 1) % n);
        break;
      case 'l1':
        if (n) setCursor((c) => Math.max(0, c - 10));
        break;
      case 'r1':
        if (n) setCursor((c) => Math.min(n - 1, c + 10));
        break;
      case 'left':
        setAnswerFilter((f) => cycle(ANSWER_FILTERS.map((x) => x.key), f, -1));
        break;
      case 'right':
        setAnswerFilter((f) => cycle(ANSWER_FILTERS.map((x) => x.key), f, 1));
        break;
      case 'l2':
        setGroupFilter((g) => cycle(GROUP_FILTER_KEYS, g, -1));
        break;
      case 'r2':
        setGroupFilter((g) => cycle(GROUP_FILTER_KEYS, g, 1));
        break;
      case 'faceDown': {
        const q = visible[cursor];
        if (q) navigate(`/q/${q.id}`);
        break;
      }
      case 'start':
        navigate('/review');
        break;
    }
  });

  if (items === null) {
    return <div className="p-8 text-center text-ink-400 dark:text-ink-500">載入中…</div>;
  }

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
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">
            {countsSummary}
            {/* 自動 + 無聲 = 使用者不知道現在能不能離線,而那正是他要這個功能的
                唯一原因(通勤、地下室、醫院沒訊號的角落)。失敗與 saveData 一律
                不顯示 —— 不要為了一個他沒要求的背景行為製造焦慮。 */}
            {offline.kind === 'running' && (
              <span className="ml-2 text-ink-400 dark:text-ink-500 tabular-nums">
                · 離線備用中… {offline.done}/{offline.total}
              </span>
            )}
            {offline.kind === 'ready' && (
              <span className="ml-2 text-accent dark:text-accent-light">
                · ✓ 可離線閱讀
              </span>
            )}
          </p>
          {/* 圖片。血液抹片、免疫染色本來就是要學的診斷資訊,所以「沒有圖」不是
              少了裝飾,是真的少了東西 —— 值得一顆明確的按鈕。但 8-17 MB 的量級
              不該自作主張,所以按鈕上先寫出張數與 MB。 */}
          {images.state.kind === 'offer' && (
            <button
              type="button"
              onClick={() => void images.start()}
              className="mt-1 text-xs text-ink-500 dark:text-ink-400 underline underline-offset-2 hover:text-accent"
            >
              連圖片一起離線備用({images.state.label})
            </button>
          )}
          {images.state.kind === 'running' && (
            <p className="mt-1 text-xs text-ink-400 dark:text-ink-500 tabular-nums">
              下載圖片… {images.state.done}/{images.state.total}
            </p>
          )}
          {images.state.kind === 'ready' && (
            <p className="mt-1 text-xs text-accent dark:text-accent-light">
              ✓ 圖片也備好了({images.state.total} 張)
            </p>
          )}
          {images.state.kind === 'no-room' && (
            <p className="mt-1 text-xs text-ink-400 dark:text-ink-500">
              裝置空間不足,無法備用圖片({images.state.label})
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
        <ExportButton scope={{ kind: 'year', year: Number(year) }} />
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
        </div>
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

      {/* Group filter (科別) + answer-state filter (已作答/未作答/答對/答錯) on one
          row, split into two visual groups by a divider. Both combine with each
          other and show scoped counts. Wraps on narrow screens. */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
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

        <span
          aria-hidden="true"
          className="mx-1 h-6 w-px shrink-0 self-center bg-ink-200 dark:bg-ink-700"
        />

        {ANSWER_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setAnswerFilter(f.key)}
            className={
              'px-3 py-1 rounded text-sm border transition ' +
              (answerFilter === f.key
                ? 'bg-accent text-white border-accent'
                : 'bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 border-ink-200 dark:border-ink-700 hover:border-ink-400 dark:hover:border-ink-500')
            }
          >
            {f.label}
            {f.key !== 'all' && (
              <span className="ml-1 text-[10px] opacity-70">({answerCounts[f.key]})</span>
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
        {visible.map((q, i) => {
          const answered = (q.times_seen ?? 0) > 0;
          const correct = answered && q.last_correct === 1;
          const onCursor = padOn && i === cursor;
          return (
            <li key={q.id} ref={onCursor ? cursorRef : undefined}>
              <Link
                to={`/q/${q.id}`}
                className={
                  'flex gap-3 items-start border rounded p-3 hover:border-accent hover:shadow-paper transition ' +
                  (onCursor ? 'ring-2 ring-accent ring-offset-2 ring-offset-ink-50 dark:ring-offset-ink-900 ' : '') +
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
      <GamepadFab hints={YEAR_HINTS} />
    </div>
  );
}
