import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Loader2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ExportScope, ExportFormat, ExportPreview } from '../lib/export-scope';

// 匯出目前範圍的題目 + 共筆詳解 + 我的筆記 + 我的畫記。
// The scope is resolved server-side against the signed-in user, so this dialog
// only ever names a scope — never an email.

const FORMATS: { id: ExportFormat; name: string; blurb: string }[] = [
  { id: 'md', name: 'Markdown', blurb: '離線閱讀、丟進 Obsidian / VS Code,或再轉成別的格式。' },
  { id: 'csv', name: 'Anki CSV', blurb: '直接拖進 Anki 匯入,notetype 血專、deck 血專::匯出。' },
  { id: 'html', name: '單檔 HTML', blurb: '瀏覽器直接開;要 PDF 就用瀏覽器「列印 → 儲存成 PDF」。' },
];

const INCLUDES: { id: 'explanation' | 'note' | 'highlights'; label: string }[] = [
  { id: 'explanation', label: '共筆詳解' },
  { id: 'note', label: '我的筆記' },
  { id: 'highlights', label: '我的畫記' },
];

export function ExportDialog({ scope, onClose }: { scope: ExportScope; onClose: () => void }) {
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('md');
  const [include, setInclude] = useState({ explanation: true, note: true, highlights: true });
  const [embedImages, setEmbedImages] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .post<ExportPreview>('/api/export/preview', { scope })
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? `讀取範圍失敗 (${e.status})` : String(e));
      });
    return () => {
      cancelled = true;
    };
    // scope is a fresh object each render at the call site; stringify to keep
    // this from re-firing forever.
  }, [JSON.stringify(scope)]);

  const tooMany = !!preview && preview.count > preview.max;
  const empty = !!preview && preview.count === 0;

  async function run() {
    if (busy || tooMany || empty || !preview) return;
    setBusy(true);
    setError(null);
    try {
      await api.download('/api/export', {
        scope,
        format,
        include,
        embed_images: format !== 'csv' && embedImages,
      });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 413) {
        setError(`範圍太大(${e.data?.count ?? '?'} 題),請縮小到 ${e.data?.max ?? preview.max} 題以內。`);
      } else if (e instanceof ApiError) {
        setError(`匯出失敗 (${e.status})`);
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-center justify-center dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-paper w-full max-w-lg overflow-hidden flex flex-col max-h-full">
        <header className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-ink-100 dark:border-ink-700">
          <h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 inline-flex items-center gap-2">
            <Download size={17} className="text-accent" />
            匯出
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
            aria-label="關閉"
          >
            <X size={18} />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 space-y-4 text-sm">
          <p className="text-ink-600 dark:text-ink-300">
            {preview === null && !error && '正在計算範圍…'}
            {preview && (
              <>
                將匯出{' '}
                <strong className="text-ink-900 dark:text-ink-100">{preview.count} 題</strong>
                <span className="text-ink-400"> · {preview.label}</span>
                {preview.truncated && (
                  <span className="text-accent"> (已截到前 {preview.max} 題)</span>
                )}
              </>
            )}
          </p>

          <fieldset className="space-y-2">
            <legend className="text-xs uppercase tracking-wide text-ink-400 mb-1">格式</legend>
            {FORMATS.map((f) => (
              <label
                key={f.id}
                className="flex gap-2 items-start p-2 rounded border border-ink-100 dark:border-ink-700 cursor-pointer hover:border-ink-300 dark:hover:border-ink-600"
              >
                <input
                  type="radio"
                  name="export-format"
                  className="mt-1 accent-[#a8442a]"
                  checked={format === f.id}
                  onChange={() => setFormat(f.id)}
                />
                <span>
                  <span className="text-ink-900 dark:text-ink-100">{f.name}</span>
                  <span className="block text-xs text-ink-500 dark:text-ink-400">{f.blurb}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend className="text-xs uppercase tracking-wide text-ink-400 mb-1">內容</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {INCLUDES.map((i) => (
                <label key={i.id} className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-[#a8442a]"
                    checked={include[i.id]}
                    onChange={(e) => setInclude((s) => ({ ...s, [i.id]: e.target.checked }))}
                  />
                  <span className="text-ink-700 dark:text-ink-200">{i.label}</span>
                </label>
              ))}
            </div>
            {format !== 'csv' && (
              <label className="mt-2 inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-[#a8442a]"
                  checked={embedImages}
                  onChange={(e) => setEmbedImages(e.target.checked)}
                />
                <span className="text-ink-700 dark:text-ink-200">
                  內嵌圖片(離線也看得到,上限 20 張 / 4 MB)
                </span>
              </label>
            )}
          </fieldset>

          <p className="text-xs text-ink-500 dark:text-ink-400 border-l-2 border-ink-200 dark:border-ink-600 pl-2 leading-relaxed">
            檔案含你自己的筆記與畫記,請勿轉傳。
            {format === 'csv' && (
              <>
                <br />
                Anki CSV 沒有 guid 欄,匯進去的卡片與 <code>anki-deck/*.apkg</code>{' '}
                是不同的 note,同一題會出現兩張。圖片是站內連結,Anki 不會抓,離線看不到。
              </>
            )}
            {format === 'html' && !embedImages && (
              <>
                <br />
                圖片是站內連結,離線或未登入時看不到;勾「內嵌圖片」可帶著走。
              </>
            )}
          </p>

          {tooMany && (
            <p className="text-accent text-xs">
              範圍太大({preview!.count} 題),請縮小到 {preview!.max} 題以內再匯出。
            </p>
          )}
          {empty && <p className="text-ink-500 text-xs">這個範圍目前沒有題目。</p>}
          {error && <p className="text-accent text-xs">{error}</p>}
        </div>

        <footer className="shrink-0 flex justify-end gap-2 px-5 py-3 border-t border-ink-100 dark:border-ink-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-700"
          >
            取消
          </button>
          <button
            onClick={run}
            disabled={busy || tooMany || empty || preview === null}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            下載
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// Shared trigger so every entry point looks and reads the same.
export function ExportButton({
  scope,
  className,
  label = '匯出',
}: {
  scope: ExportScope;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={
          className ??
          'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm rounded border border-ink-200 dark:border-ink-600 text-ink-600 dark:text-ink-300 hover:border-accent hover:text-accent'
        }
        title="匯出這個範圍"
      >
        <Download size={14} />
        {label}
      </button>
      {open && <ExportDialog scope={scope} onClose={() => setOpen(false)} />}
    </>
  );
}
