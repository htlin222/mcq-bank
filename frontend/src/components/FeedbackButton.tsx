import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquareWarning, X, Loader2, CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';

// Header button that opens a feedback dialog. Submissions go through
// /api/feedback which files a GitHub issue tagged `feedback,from-app`.
// The button hides itself if the Worker reports the integration as
// unconfigured (missing GH_FEEDBACK_REPO or token).
export function FeedbackButton() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<{ enabled: boolean }>('/api/feedback/_status')
      .then((r) => { if (!cancelled) setEnabled(r.enabled); })
      .catch(() => { /* leave disabled */ });
    return () => { cancelled = true; };
  }, []);

  if (!enabled) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-2 rounded hover:bg-ink-100 dark:hover:bg-ink-700 text-ink-600 dark:text-ink-300 hover:text-accent transition"
        title="回報 bug 或意見"
        aria-label="回報 bug 或意見"
      >
        <MessageSquareWarning size={18} />
      </button>
      {open && <FeedbackDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [isQuestionFix, setIsQuestionFix] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ url: string; number: number } | null>(null);
  // 冪等:同一次送出動作用同一個 key(網路重試沿用),成功後重置供下次。
  const idemKey = useRef<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit() {
    if (submitting) return;
    if (!title.trim() || !body.trim()) {
      setError('標題與內容都要填。');
      return;
    }
    setSubmitting(true);
    setError(null);
    if (!idemKey.current) idemKey.current = crypto.randomUUID();
    try {
      const r = await api.post<{ url: string; number: number }>('/api/feedback', {
        title: title.trim(),
        body: body.trim(),
        url: window.location.href,
        isQuestionFix,
      }, idemKey.current);
      setSuccess({ url: r.url, number: r.number });
      idemKey.current = null;
    } catch (e) {
      if (e instanceof ApiError) {
        setError(`送出失敗 (${e.status}): ${JSON.stringify(e.data)}`);
      } else {
        setError(String(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-center justify-center dialog-scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-paper w-full max-w-lg overflow-hidden flex flex-col max-h-full">
        <header className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-ink-100 dark:border-ink-700">
          <h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 inline-flex items-center gap-2">
            <MessageSquareWarning size={18} className="text-accent" />
            回報 bug 或意見
          </h2>
          <button
            onClick={onClose}
            className="text-ink-400 dark:text-ink-500 hover:text-ink-600 dark:hover:text-ink-300"
            aria-label="關閉"
          >
            <X size={18} />
          </button>
        </header>

        {success ? (
          <div className="p-6 text-center space-y-3 overflow-y-auto">
            <CheckCircle2 size={36} className="mx-auto text-emerald-600" />
            <p className="text-ink-800 dark:text-ink-200">
              已建立 issue #{success.number},謝謝!
            </p>
            <a
              href={success.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-accent hover:text-accent-dark text-sm"
            >
              在 GitHub 查看 ↗
            </a>
            <div className="pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-900 dark:hover:text-ink-100"
              >
                關閉
              </button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-4 overflow-y-auto">
            <p className="text-xs text-ink-500 dark:text-ink-400">
              送出後會以 GitHub issue 開單,標題與內容、你的 email、目前頁面網址、UA 都會留在 issue。
            </p>
            <div>
              <label className="block text-sm font-medium text-ink-700 dark:text-ink-200 mb-1">
                標題
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="一句話概括"
                maxLength={200}
                className="w-full px-3 py-2 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded focus:outline-none focus:border-accent text-sm text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 dark:text-ink-200 mb-1">
                內容
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="重現步驟、預期行為、實際行為,或單純的想法/建議"
                rows={6}
                maxLength={4000}
                className="w-full px-3 py-2 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded focus:outline-none focus:border-accent text-sm font-mono text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
              />
              <div className="text-right text-[11px] text-ink-400 dark:text-ink-500 mt-1">{body.length} / 4000</div>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-700 dark:text-ink-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isQuestionFix}
                onChange={(e) => setIsQuestionFix(e.target.checked)}
                className="accent-accent"
              />
              這是題目內容問題(錯字、亂碼、選項或答案有誤)
            </label>
            {error && (
              <div className="p-2 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300 text-sm">
                {error}
              </div>
            )}
            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={onClose}
                disabled={submitting}
                className="px-4 py-2 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-900 dark:hover:text-ink-100"
              >
                取消
              </button>
              <button
                onClick={submit}
                disabled={submitting || !title.trim() || !body.trim()}
                className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40 inline-flex items-center gap-2"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {submitting ? '送出中…' : '送出'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
