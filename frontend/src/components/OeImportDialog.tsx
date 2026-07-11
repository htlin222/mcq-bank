import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Link2, Check } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { parseOeConversation, type OeConversation } from '../lib/oe-import';

// Import a public OpenEvidence conversation by URL. The Worker proxy
// (/api/oe/fetch) retrieves the page server-side (browsers can't fetch OE
// cross-origin — no CORS header), then parseOeConversation splits it into Q&A
// turns here. The user ticks which answers to bring in; each selected answer is
// handed to onInsert, which runs the same image-sideload + paste-transform
// pipeline as an OE copy-paste.
export function OeImportDialog({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (html: string) => Promise<void> | void;
}) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conv, setConv] = useState<OeConversation | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [inserting, setInserting] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function load() {
    const trimmed = url.trim();
    if (!trimmed || loading) return;
    if (!/openevidence\.com\/ask\//i.test(trimmed)) {
      setError('請貼上 OpenEvidence 對話連結(https://www.openevidence.com/ask/…)。');
      return;
    }
    setLoading(true);
    setError(null);
    setConv(null);
    try {
      const { html } = await api.get<{ html: string; url: string }>(
        `/api/oe/fetch?url=${encodeURIComponent(trimmed)}`,
      );
      const parsed = parseOeConversation(html);
      if (parsed.turns.length === 0) {
        setError('這個連結讀不到內容。請確認對話已在 OpenEvidence 設為公開(Share → Make public)。');
        return;
      }
      setConv(parsed);
      // Default to all turns selected — most conversations have just one.
      setSelected(new Set(parsed.turns.map((_, i) => i)));
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 403) {
          setError('這個對話不是公開的。請先在 OpenEvidence 把它設為公開再試。');
        } else if (e.status === 400) {
          setError('連結格式不正確,需是 openevidence.com/ask/… 的對話連結。');
        } else {
          setError(`讀取失敗 (${e.status})。`);
        }
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function importSelected() {
    if (!conv || inserting || selected.size === 0) return;
    setInserting(true);
    try {
      // Insert in conversation order.
      for (let i = 0; i < conv.turns.length; i++) {
        if (selected.has(i)) await onInsert(conv.turns[i].answerHtml);
      }
      onClose();
    } catch (e) {
      setError('匯入時發生錯誤:' + String(e));
      setInserting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-paper w-full max-w-2xl overflow-hidden flex flex-col max-h-[calc(100dvh-2rem)]">
        <header className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-ink-100 dark:border-ink-700">
          <h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 inline-flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border-[1.5px] border-accent text-accent text-[11px] font-bold">
              O
            </span>
            匯入 OpenEvidence 連結
          </h2>
          <button
            onClick={onClose}
            className="text-ink-400 dark:text-ink-500 hover:text-ink-600 dark:hover:text-ink-300"
            aria-label="關閉"
          >
            <X size={18} />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 dark:text-ink-500"
              />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') load();
                }}
                placeholder="https://www.openevidence.com/ask/…"
                className="w-full pl-9 pr-3 py-2 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded focus:outline-none focus:border-accent text-sm text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
                autoFocus
              />
            </div>
            <button
              onClick={load}
              disabled={loading || !url.trim()}
              className="bg-ink-800 dark:bg-ink-200 hover:bg-ink-900 dark:hover:bg-white text-white dark:text-ink-900 px-4 py-2 rounded text-sm font-medium disabled:opacity-40 inline-flex items-center gap-2 shrink-0"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              {loading ? '讀取中…' : '讀取'}
            </button>
          </div>

          {!conv && !error && (
            <p className="text-xs text-ink-500 dark:text-ink-400">
              對話需先在 OpenEvidence 按 Share → Make public 設為公開,這裡才讀得到。讀取後可勾選要匯入的回答。
            </p>
          )}

          {error && (
            <div className="p-2 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-sm">
              {error}
            </div>
          )}

          {conv && (
            <div className="space-y-2">
              <div className="text-xs text-ink-500 dark:text-ink-400">
                找到 {conv.turns.length} 則回答,勾選要匯入的:
              </div>
              {conv.turns.map((turn, i) => (
                <label
                  key={i}
                  className={
                    'flex gap-3 p-3 rounded border cursor-pointer transition ' +
                    (selected.has(i)
                      ? 'border-accent bg-accent/5'
                      : 'border-ink-200 dark:border-ink-700 hover:border-ink-300 dark:hover:border-ink-600')
                  }
                >
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    onChange={() => toggle(i)}
                    className="mt-1 accent-accent shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink-900 dark:text-ink-100 line-clamp-2">
                      {turn.question}
                    </div>
                    <div className="text-xs text-ink-500 dark:text-ink-400 line-clamp-2 mt-0.5">
                      {plainExcerpt(turn.answerHtml)}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {conv && (
          <div className="shrink-0 flex gap-3 justify-end px-5 py-3 border-t border-ink-100 dark:border-ink-700">
            <button
              onClick={onClose}
              disabled={inserting}
              className="px-4 py-2 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-900 dark:hover:text-ink-100"
            >
              取消
            </button>
            <button
              onClick={importSelected}
              disabled={inserting || selected.size === 0}
              className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40 inline-flex items-center gap-2"
            >
              {inserting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              {inserting ? '匯入中…' : `匯入所選 (${selected.size})`}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// Plain-text preview of an answer for the picker row.
function plainExcerpt(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
