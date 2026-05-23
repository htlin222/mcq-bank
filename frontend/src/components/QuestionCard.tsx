import { useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkPlus, Check, X, FolderPlus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { QuestionFull } from '../hooks/useQuestion';
import { useBookmarkSet } from '../hooks/useBookmarkSet';

type Props = {
  question: QuestionFull;
  onAnswered?: (chosen: string, correct: boolean) => void;
  onBookmarkToggled?: (bookmarked: boolean) => void;
};

const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

export function QuestionCard({ question, onAnswered, onBookmarkToggled }: Props) {
  const bookmarkSet = useBookmarkSet();
  const [chosen, setChosen] = useState<string | null>(
    question.my_progress?.last_chosen ?? null,
  );
  const [revealed, setRevealed] = useState(!!question.my_progress?.last_chosen);
  const [bookmarked, setBookmarked] = useState(!!question.my_progress?.bookmarked);
  const [folderId, setFolderId] = useState<string | null>(
    question.my_progress?.bookmark_folder_id ?? null,
  );
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

  const options = LETTERS
    .map((L) => ({ L, text: question.options[L] }))
    .filter((o) => !!o.text);

  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-paper p-5 sm:p-7">
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
        <BookmarkButton
          bookmarked={bookmarked}
          onToggle={toggleBookmark}
          onMoveToFolder={moveToFolder}
          currentFolderId={folderId}
        />
      </header>

      <p className="font-serif text-lg sm:text-xl leading-relaxed text-ink-900 dark:text-ink-100 whitespace-pre-wrap">
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
        <div className="mt-6 pt-4 border-t border-ink-100 text-sm text-ink-600 flex items-center gap-3 flex-wrap">
          {chosen === question.answer ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
              <Check size={16} /> 答對了
            </span>
          ) : chosen ? (
            <span className="inline-flex items-center gap-1 text-rose-700 font-medium">
              <X size={16} /> 你選 {chosen},正解 {question.answer}
            </span>
          ) : (
            <span>正解 {question.answer}</span>
          )}
          {question.my_progress && question.my_progress.times_seen > 0 && (
            <span className="text-ink-400">
              · 已看過 {question.my_progress.times_seen} 次,答對{' '}
              {question.my_progress.times_correct} 次
            </span>
          )}
        </div>
      )}
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
        className="text-2xl leading-none transition hover:scale-110 text-ink-500 hover:text-accent"
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
          <div className="px-3 py-2 text-xs text-ink-500 uppercase tracking-wider border-b border-ink-100">
            收藏到資料夾
          </div>
          {folders === null ? (
            <div className="px-3 py-2 text-ink-400">載入中…</div>
          ) : (
            <>
              <button
                onClick={() => { onMoveToFolder(null); setOpen(false); }}
                className={`w-full text-left px-3 py-1.5 hover:bg-ink-50 ${
                  bookmarked && currentFolderId === null ? 'text-accent font-medium' : 'text-ink-700'
                }`}
              >
                未分類
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => { onMoveToFolder(f.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 hover:bg-ink-50 flex items-center justify-between ${
                    bookmarked && currentFolderId === f.id ? 'text-accent font-medium' : 'text-ink-700'
                  }`}
                >
                  <span>{f.name}</span>
                  <span className="text-[11px] text-ink-400">{f.item_count}</span>
                </button>
              ))}
              <div className="border-t border-ink-100 mt-1 pt-1">
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
                      className="flex-1 px-2 py-1 border border-ink-200 rounded text-xs focus:outline-none focus:border-accent"
                    />
                    <button type="submit" className="px-2 text-xs text-accent hover:text-accent-dark">建</button>
                  </form>
                ) : (
                  <button
                    onClick={() => setCreating(true)}
                    className="w-full text-left px-3 py-1.5 hover:bg-ink-50 text-ink-600 inline-flex items-center gap-1.5"
                  >
                    <FolderPlus size={14} /> 新增資料夾
                  </button>
                )}
              </div>
              {bookmarked && (
                <button
                  onClick={() => { onToggle(); setOpen(false); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-rose-50 text-rose-700 border-t border-ink-100 mt-1 pt-1"
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
