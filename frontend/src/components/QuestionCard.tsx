import { useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkPlus, Check, X, FolderPlus, RotateCcw, Copy, ShieldCheck, Loader2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { QuestionFull } from '../hooks/useQuestion';
import { useBookmarkSet } from '../hooks/useBookmarkSet';
import { useMe } from '../hooks/useMe';
import { ChallengePanel } from './ChallengePanel';
import { groupBadgeClass } from '../lib/groups';

type Props = {
  question: QuestionFull;
  onAnswered?: (chosen: string, correct: boolean) => void;
  onBookmarkToggled?: (bookmarked: boolean) => void;
  onProgressCleared?: () => void;
};

const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

export function QuestionCard({ question, onAnswered, onBookmarkToggled, onProgressCleared }: Props) {
  const bookmarkSet = useBookmarkSet();
  const { me } = useMe();
  const [chosen, setChosen] = useState<string | null>(
    question.my_progress?.last_chosen ?? null,
  );
  const [revealed, setRevealed] = useState(!!question.my_progress?.last_chosen);
  const [bookmarked, setBookmarked] = useState(!!question.my_progress?.bookmarked);
  const [folderId, setFolderId] = useState<string | null>(
    question.my_progress?.bookmark_folder_id ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [currentAnswer, setCurrentAnswer] = useState(question.answer);
  const [answerEditing, setAnswerEditing] = useState(false);
  const [answerDraft, setAnswerDraft] = useState(question.answer);
  const [answerSaving, setAnswerSaving] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);

  useEffect(() => {
    setCurrentAnswer(question.answer);
    setAnswerDraft(question.answer);
    setAnswerEditing(false);
    setAnswerError(null);
  }, [question.id, question.answer]);

  // Aggregate (anonymous) review-mode stats. Lazy-loaded once the answer
  // is revealed — adds one extra request per card view, not per page load.
  type StatsPayload = {
    attempts: number;
    correct: number;
    responders: number;
    accuracy: number | null;
  };
  const [stats, setStats] = useState<StatsPayload | null>(null);
  useEffect(() => {
    if (!revealed) return;
    let cancelled = false;
    api.get<StatsPayload>(`/api/questions/${question.id}/stats`).then(
      (r) => { if (!cancelled) setStats(r); },
    ).catch(() => { /* stats are best-effort */ });
    return () => { cancelled = true; };
  }, [revealed, question.id]);

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

  const [copied, setCopied] = useState(false);
  async function copyAsMarkdown() {
    const lines: string[] = [];
    lines.push(`**民國 ${question.year} 年 · 第 ${question.number} 題**${question.group ? ` (${question.group})` : ''}`);
    lines.push('');
    lines.push(question.stem);
    lines.push('');
    for (const { L, text } of options) {
      lines.push(`- ${L}. ${text}`);
    }
    const md = lines.join('\n');
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert('複製失敗,請手動選取。');
    }
  }

  const [clearing, setClearing] = useState(false);
  async function clearProgress() {
    if (clearing) return;
    if (!window.confirm('要清除本題的作答紀錄嗎?(只清你的,不影響其他人)')) return;
    setClearing(true);
    try {
      await api.del(`/api/review/answer/${question.id}`);
      setChosen(null);
      setRevealed(false);
      setStats(null);
      onProgressCleared?.();
    } catch (e) {
      alert('清除失敗:' + String(e));
    } finally {
      setClearing(false);
    }
  }

  async function toggleBookmark() {
    const next = !bookmarked;
    setBookmarked(next);
    if (next) bookmarkSet.add(question.id);
    else bookmarkSet.remove(question.id);
    try {
      if (next) {
        await api.put(`/api/bookmarks/${question.id}`, { folder_id: folderId });
      } else {
        await api.del(`/api/bookmarks/${question.id}`);
        setFolderId(null);
      }
      onBookmarkToggled?.(next);
    } catch (e) {
      setBookmarked(!next);
      if (next) bookmarkSet.remove(question.id);
      else bookmarkSet.add(question.id);
      if (!(e instanceof ApiError)) throw e;
    }
  }

  async function moveToFolder(newFolderId: string | null) {
    setFolderId(newFolderId);
    setBookmarked(true);
    bookmarkSet.add(question.id);
    await api.put(`/api/bookmarks/${question.id}`, { folder_id: newFolderId });
    onBookmarkToggled?.(true);
  }

  async function saveAnswer() {
    if (answerSaving || answerDraft === currentAnswer) {
      setAnswerEditing(false);
      setAnswerError(null);
      return;
    }
    setAnswerSaving(true);
    setAnswerError(null);
    try {
      const r = await api.put<{ ok: true; answer: string; changed: boolean }>(
        `/api/questions/${question.id}/answer`,
        { answer: answerDraft },
      );
      setCurrentAnswer(r.answer);
      setAnswerDraft(r.answer);
      setAnswerEditing(false);
      setStats(null);
    } catch (e) {
      if (e instanceof ApiError) {
        setAnswerError(String(e.data?.error ?? e.message));
      } else {
        setAnswerError(String(e));
      }
    } finally {
      setAnswerSaving(false);
    }
  }

  const options = LETTERS
    .map((L) => ({ L, text: question.options[L] }))
    .filter((o) => !!o.text);
  const canEditAnswer = question.can_edit_answer === true;

  // Keyboard shortcuts for review mode. A ref holds the latest handler so the
  // single window listener always sees fresh state without re-binding.
  //   A–E  toggle an option (while unanswered; mutually exclusive)
  //   Enter 提交答案   Space 直接看答案 (while unanswered)
  //   y    複製題目    b 收藏 (once answered — b is option B while answering)
  // Skipped when typing in an input / textarea / contenteditable or holding a
  // modifier. Prev/next, tab nav and note editing live in Question.tsx.
  const shortcutRef = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        t.isContentEditable)
    )
      return;

    if (e.key.toLowerCase() === 'y') {
      e.preventDefault();
      copyAsMarkdown();
      return;
    }

    if (!revealed) {
      const L = e.key.toUpperCase() as (typeof LETTERS)[number];
      if ((LETTERS as readonly string[]).includes(L) && question.options[L]) {
        setChosen((cur) => (cur === L ? null : L)); // toggle, single-select
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
        return;
      }
      if (e.key === ' ') {
        e.preventDefault(); // Space would otherwise scroll the page
        setRevealed(true);
        return;
      }
      return;
    }

    // Answered: A–E are inactive, so b is free to toggle the bookmark.
    if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleBookmark();
    }
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => shortcutRef.current(e);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-paper p-5 sm:p-7">
      <header className="flex items-start justify-between gap-3 mb-4">
        <div className="text-sm text-ink-500 dark:text-ink-400 font-medium flex items-center flex-wrap gap-x-2 gap-y-1">
          <span>民國 {question.year} 年 · 第 {question.number} 題</span>
          {question.group && (
            <span
              className={
                'inline-block px-2 py-0.5 rounded text-xs ' +
                groupBadgeClass(question.group)
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
                  className="inline-block bg-ink-100 dark:bg-ink-700 text-ink-700 dark:text-ink-200 px-2 py-0.5 rounded text-[11px]"
                >
                  #{t}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={copyAsMarkdown}
            title={copied ? '已複製' : '複製題目與選項為 Markdown'}
            aria-label="複製為 Markdown"
            className={
              'p-1.5 rounded transition ' +
              (copied
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-ink-400 dark:text-ink-500 hover:text-ink-700 dark:hover:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-700')
            }
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
          </button>
          <BookmarkButton
            bookmarked={bookmarked}
            onToggle={toggleBookmark}
            onMoveToFolder={moveToFolder}
            currentFolderId={folderId}
          />
        </div>
      </header>

      <p className="font-serif text-lg sm:text-xl leading-relaxed text-ink-900 dark:text-ink-100 whitespace-pre-wrap">
        {question.stem}
      </p>

      <ul className="mt-6 space-y-2.5">
        {options.map(({ L, text }) => {
          const selected = chosen === L;
          const isCorrect = L === currentAnswer;
          let cls =
            'flex gap-3 items-start p-3 rounded border cursor-pointer transition';
          if (!revealed) {
            cls += selected
              ? ' border-accent bg-accent/5 dark:bg-accent/15'
              : ' border-ink-200 dark:border-ink-700 hover:border-ink-400 dark:hover:border-ink-500 hover:bg-ink-50 dark:hover:bg-ink-700/40';
          } else {
            if (isCorrect)
              cls += ' border-emerald-500 bg-emerald-50 dark:bg-emerald-500/15';
            else if (selected)
              cls += ' border-rose-500 bg-rose-50 dark:bg-rose-500/15';
            else cls += ' border-ink-200 dark:border-ink-700 opacity-70';
          }
          return (
            <li
              key={L}
              className={cls}
              onClick={() => {
                if (revealed) return;
                // Drag-selecting option text fires a click on mouseup — don't
                // treat that as choosing the option.
                if (window.getSelection()?.toString()) return;
                setChosen(L);
              }}
            >
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-current text-sm font-semibold shrink-0">
                {L}
              </span>
              <span className="leading-relaxed text-ink-800 dark:text-ink-200">{text}</span>
              {revealed && isCorrect && (
                <span className="ml-auto inline-flex items-center gap-1 text-emerald-700 text-sm font-medium shrink-0">
                  <Check size={16} /> 正解
                </span>
              )}
              {revealed && selected && !isCorrect && (
                <span className="ml-auto inline-flex items-center gap-1 text-rose-700 text-sm font-medium shrink-0">
                  <X size={16} /> 你的選擇
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {!revealed && (
        <div className="mt-6 flex gap-3 justify-end">
          <button
            onClick={() => setRevealed(true)}
            className="text-ink-500 dark:text-ink-400 px-4 py-2 text-sm hover:text-ink-700 dark:hover:text-ink-200"
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
        <div className="mt-6 pt-4 border-t border-ink-100 dark:border-ink-700 text-sm text-ink-600 dark:text-ink-300 flex items-center gap-3 flex-wrap">
          {chosen === currentAnswer ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
              <Check size={16} /> 答對了
            </span>
          ) : chosen ? (
            <span className="inline-flex items-center gap-1 text-rose-700 font-medium">
              <X size={16} /> 你選 {chosen},正解 {currentAnswer}
            </span>
          ) : (
            <span>正解 {currentAnswer}</span>
          )}
          {question.my_progress && question.my_progress.times_seen > 0 && (
            <span className="text-ink-400 dark:text-ink-500">
              · 已看過 {question.my_progress.times_seen} 次,答對{' '}
              {question.my_progress.times_correct} 次
            </span>
          )}
          {stats && stats.attempts > 0 && (
            <span className="text-ink-400 dark:text-ink-500">
              · 全體被作答 {stats.attempts} 次 / 答對 {stats.correct} 次,
              答對率 {stats.accuracy ?? 0}%
            </span>
          )}
          <div className="ml-auto flex items-center justify-end gap-2 flex-wrap">
            {canEditAnswer && (
              <AdminAnswerEditor
                currentAnswer={currentAnswer}
                draft={answerDraft}
                options={options.map((o) => o.L)}
                editing={answerEditing}
                saving={answerSaving}
                error={answerError}
                onStart={() => {
                  setAnswerDraft(currentAnswer);
                  setAnswerEditing(true);
                  setAnswerError(null);
                }}
                onDraft={setAnswerDraft}
                onSave={saveAnswer}
                onCancel={() => {
                  setAnswerDraft(currentAnswer);
                  setAnswerEditing(false);
                  setAnswerError(null);
                }}
              />
            )}
            <button
              onClick={clearProgress}
              disabled={clearing}
              className="inline-flex items-center gap-1 text-xs text-ink-400 dark:text-ink-500 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-40"
              title="只清除你自己在本題的作答紀錄"
            >
              <RotateCcw size={12} />
              {clearing ? '清除中…' : '清除本題作答紀錄'}
            </button>
          </div>
        </div>
      )}

      {revealed && (
        <ChallengePanel
          key={`${question.id}:${currentAnswer}`}
          questionId={question.id}
          currentAnswer={currentAnswer}
          availableLetters={options.map((o) => o.L)}
          meEmail={me?.email ?? null}
        />
      )}
    </div>
  );
}

function AdminAnswerEditor({
  currentAnswer,
  draft,
  options,
  editing,
  saving,
  error,
  onStart,
  onDraft,
  onSave,
  onCancel,
}: {
  currentAnswer: string;
  draft: string;
  options: string[];
  editing: boolean;
  saving: boolean;
  error: string | null;
  onStart: () => void;
  onDraft: (answer: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (!editing) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100"
        title="管理員可直接修正本題正解"
      >
        <ShieldCheck size={12} />
        管理員編輯正解
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      <div className="inline-flex items-center gap-1 rounded border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-2 py-1">
        <span className="text-xs text-amber-800 dark:text-amber-200 mr-1">正解</span>
        {options.map((L) => (
          <button
            key={L}
            type="button"
            onClick={() => onDraft(L)}
            disabled={saving}
            className={
              'w-7 h-7 rounded-full border text-xs font-mono font-semibold transition disabled:opacity-50 ' +
              (draft === L
                ? 'bg-amber-600 border-amber-600 text-white'
                : 'bg-white dark:bg-ink-800 border-amber-300 dark:border-amber-600 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40')
            }
            aria-label={`設為 ${L}`}
          >
            {L}
          </button>
        ))}
        <button
          type="button"
          onClick={onSave}
          disabled={saving || draft === currentAnswer}
          className="ml-1 inline-flex items-center gap-1 rounded bg-amber-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-40"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          儲存
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs text-ink-500 hover:text-ink-800 dark:hover:text-ink-200 disabled:opacity-40"
        >
          <X size={12} />
          取消
        </button>
      </div>
      {error && <span className="w-full text-right text-xs text-rose-700">{error}</span>}
    </div>
  );
}

// ----------------------------------------------------------------
// Bookmark button with inline folder picker
// ----------------------------------------------------------------
type Folder = { id: string; name: string; item_count: number };

function BookmarkButton({
  bookmarked,
  onToggle,
  onMoveToFolder,
  currentFolderId,
}: {
  bookmarked: boolean;
  onToggle: () => void;
  onMoveToFolder: (id: string | null) => Promise<void>;
  currentFolderId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewName('');
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function load() {
    const r = await api.get<{ folders: Folder[]; uncategorized_count: number }>('/api/folders');
    setFolders(r.folders);
  }

  async function createFolder() {
    if (!newName.trim()) return;
    const r = await api.post<{ id: string }>('/api/folders', { name: newName.trim() });
    setNewName('');
    setCreating(false);
    await load();
    await onMoveToFolder(r.id);
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => {
          if (e.shiftKey || e.altKey) {
            setOpen((v) => !v);
            if (!open && !folders) load();
          } else {
            onToggle();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
          if (!open && !folders) load();
        }}
        className="text-2xl leading-none transition hover:scale-110 text-ink-500 dark:text-ink-400 hover:text-accent"
        aria-label={bookmarked ? '管理收藏' : '收藏 (右鍵選資料夾)'}
        title={bookmarked ? '管理收藏 (右鍵選資料夾)' : '收藏 (右鍵選資料夾)'}
      >
        {bookmarked ? (
          <Bookmark size={22} fill="currentColor" />
        ) : (
          <BookmarkPlus size={22} />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 w-56 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded shadow-lg z-30 py-1 text-sm">
          <div className="px-3 py-2 text-xs text-ink-500 dark:text-ink-400 uppercase tracking-wider border-b border-ink-100 dark:border-ink-700">
            收藏到資料夾
          </div>
          {folders === null ? (
            <div className="px-3 py-2 text-ink-400 dark:text-ink-500">載入中…</div>
          ) : (
            <>
              <button
                onClick={() => { onMoveToFolder(null); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-700 ${
                  bookmarked && currentFolderId === null ? 'text-accent font-medium' : 'text-ink-700 dark:text-ink-200'
                }`}
              >
                未分類
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => { onMoveToFolder(f.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-700 flex items-center justify-between ${
                    bookmarked && currentFolderId === f.id ? 'text-accent font-medium' : 'text-ink-700 dark:text-ink-200'
                  }`}
                >
                  <span>{f.name}</span>
                  <span className="text-[11px] text-ink-400 dark:text-ink-500">{f.item_count}</span>
                </button>
              ))}
              <div className="border-t border-ink-100 dark:border-ink-700 mt-1 pt-1">
                {creating ? (
                  <form
                    onSubmit={(e) => { e.preventDefault(); createFolder(); }}
                    className="px-2 py-1 flex gap-1"
                  >
                    <input
                      autoFocus
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="資料夾名稱"
                      className="flex-1 px-2 py-1 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500 rounded text-xs focus:outline-none focus:border-accent"
                    />
                    <button type="submit" className="px-2 text-xs text-accent hover:text-accent-dark">建</button>
                  </form>
                ) : (
                  <button
                    onClick={() => setCreating(true)}
                    className="w-full text-left px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-700 text-ink-600 dark:text-ink-300 inline-flex items-center gap-1.5"
                  >
                    <FolderPlus size={14} /> 新增資料夾
                  </button>
                )}
              </div>
              {bookmarked && (
                <button
                  onClick={() => { onToggle(); setOpen(false); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-700 dark:text-rose-400 border-t border-ink-100 dark:border-ink-700 mt-1 pt-1"
                >
                  取消收藏
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
