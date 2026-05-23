import { useEffect, useState, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pencil, LinkIcon, Sparkles, X as XIcon } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useQuestion } from '../hooks/useQuestion';
import { useLock } from '../hooks/useLock';
import { useMe } from '../hooks/useMe';
import { QuestionCard } from '../components/QuestionCard';
import { RichEditor } from '../components/RichEditor';
import { ReadOnlyContent } from '../components/ReadOnlyContent';
import { CommentThread } from '../components/CommentThread';

type Tab = 'explanation' | 'note';

type SimilarItem = {
  id: string;
  year: number;
  number: number;
  stem: string;
  group: '內科' | '共同' | null;
  shared_tags: number;
  source: 'tag' | 'fts';
};

export function Question() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const { data, loading, error, reload } = useQuestion(id);
  const { state: lockState, acquire, release } = useLock(id || '');

  const [tab, setTab] = useState<Tab>('explanation');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Note tab — has its own edit lifecycle (no lock, no version)
  const [noteEditing, setNoteEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState<any>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // AI summary of the explanation — fetched on demand, scoped to current version
  const [summary, setSummary] = useState<{ text: string; version: number } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const explanationJson = useMemo(() => {
    if (!data?.explanation?.content_json) return null;
    try {
      return JSON.parse(data.explanation.content_json);
    } catch {
      return null;
    }
  }, [data?.explanation?.content_json]);

  const noteJson = useMemo(() => {
    if (!data?.my_note?.content_json) return null;
    try {
      return JSON.parse(data.my_note.content_json);
    } catch {
      return null;
    }
  }, [data?.my_note?.content_json]);

  // Invalidate cached summary when the explanation version moves past it
  useEffect(() => {
    const v = data?.explanation?.version ?? 0;
    if (summary && summary.version !== v) {
      setSummary(null);
      setSummaryError(null);
    }
  }, [data?.explanation?.version, summary]);

  // 相似題目 — lazy-loaded after the main question payload arrives.
  // Kept off the hot /api/questions/:id path so navigation stays snappy.
  const [similar, setSimilar] = useState<SimilarItem[]>([]);
  useEffect(() => {
    if (!data?.id) return;
    let cancelled = false;
    api.get<SimilarItem[]>(`/api/questions/${data.id}/similar`).then(
      (rows) => { if (!cancelled) setSimilar(rows); },
    ).catch(() => { if (!cancelled) setSimilar([]); });
    return () => { cancelled = true; };
  }, [data?.id]);

  const navigate = useNavigate();

  // Prev/next in same year
  const [neighbors, setNeighbors] = useState<{ prev?: string; next?: string }>({});
  useEffect(() => {
    if (!data) return;
    api
      .get<{ id: string; number: number }[]>(
        `/api/questions?year=${data.year}&limit=200`,
      )
      .then((all) => {
        const idx = all.findIndex((q) => q.id === data.id);
        setNeighbors({
          prev: idx > 0 ? all[idx - 1].id : undefined,
          next: idx < all.length - 1 ? all[idx + 1].id : undefined,
        });
      });
  }, [data?.id]);

  async function startEdit() {
    if (!data) return;
    const ok = await acquire();
    if (!ok) return;
    setDraft(explanationJson || { type: 'doc', content: [{ type: 'paragraph' }] });
    setEditing(true);
    setSaveError(null);
  }

  async function cancelEdit() {
    setEditing(false);
    setDraft(null);
    setSaveError(null);
    await release();
  }

  async function save() {
    if (!data || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.put(`/api/questions/${data.id}/explanation`, {
        content_json: draft,
        expected_version: data.explanation?.version ?? 0,
      });
      setEditing(false);
      setDraft(null);
      await release();
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSaveError(
          `版本衝突:伺服器已是 v${e.data?.server_version},你編輯的是 v${e.data?.your_version}。請取消並重新載入。`,
        );
      } else if (e instanceof ApiError && e.status === 423) {
        setSaveError('編輯鎖已被其他人取得,無法儲存。');
      } else {
        setSaveError(String(e));
      }
    } finally {
      setSaving(false);
    }
  }

  function startNoteEdit() {
    if (!data) return;
    setNoteDraft(noteJson || { type: 'doc', content: [{ type: 'paragraph' }] });
    setNoteEditing(true);
    setNoteError(null);
  }

  function cancelNoteEdit() {
    setNoteEditing(false);
    setNoteDraft(null);
    setNoteError(null);
  }

  async function runSummary() {
    if (!data || !explanationJson || summaryLoading) return;
    const plain = tiptapToText(explanationJson);
    if (plain.length < 50) {
      setSummaryError('詳解內容太短,無法摘要。');
      return;
    }
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const r = await api.post<{ summary: string }>('/api/ai/summarize', { text: plain });
      setSummary({ text: r.summary, version: data.explanation?.version ?? 0 });
    } catch (e) {
      setSummaryError(String(e));
    } finally {
      setSummaryLoading(false);
    }
  }

  async function saveNote() {
    if (!data || noteSaving) return;
    setNoteSaving(true);
    setNoteError(null);
    try {
      await api.put(`/api/questions/${data.id}/note`, { content_json: noteDraft });
      setNoteEditing(false);
      setNoteDraft(null);
      await reload();
    } catch (e) {
      setNoteError(String(e));
    } finally {
      setNoteSaving(false);
    }
  }

  // While we have data, keep rendering even during a refetch — this is the
  // common case after saving 詳解, where blanking the page would feel jarring.
  if (!data) {
    if (error) return <div className="p-8 text-center text-rose-700">載入失敗:{String(error)}</div>;
    return <div className="p-8 text-center text-ink-400">載入中…</div>;
  }

  const hasExplanation = explanationJson &&
    explanationJson.content &&
    explanationJson.content.length > 0 &&
    !(explanationJson.content.length === 1 &&
      explanationJson.content[0].type === 'paragraph' &&
      !explanationJson.content[0].content);

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-32">
      <header className="flex items-center justify-between mb-6 text-sm">
        <Link to={`/year/${data.year}`} className="inline-flex items-center gap-1 text-ink-500 hover:text-accent">
          <ChevronLeft size={16} /> 民國 {data.year} 年
        </Link>
        <div className="flex gap-3">
          {neighbors.prev && (
            <button
              onClick={() => navigate(`/q/${neighbors.prev}`)}
              className="inline-flex items-center gap-1 text-ink-500 hover:text-accent"
            >
              <ChevronLeft size={16} /> 上一題
            </button>
          )}
          {neighbors.next && (
            <button
              onClick={() => navigate(`/q/${neighbors.next}`)}
              className="inline-flex items-center gap-1 text-ink-500 hover:text-accent"
            >
              下一題 <ChevronRight size={16} />
            </button>
          )}
        </div>
      </header>

      <QuestionCard question={data} onAnswered={reload} />

      {/* 詳解 / 個人筆記 tabs */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-3 gap-3">
          <div className="inline-flex border-b border-ink-200 dark:border-ink-700">
            <TabButton active={tab === 'explanation'} onClick={() => setTab('explanation')}>
              詳解共筆
            </TabButton>
            <TabButton active={tab === 'note'} onClick={() => setTab('note')}>
              個人筆記
              {data.my_note && <span className="ml-1.5 text-[10px] text-ink-400">●</span>}
            </TabButton>
          </div>
          {tab === 'explanation' && !editing && (
            <div className="flex items-center gap-3">
              {hasExplanation && (
                <button
                  onClick={runSummary}
                  disabled={summaryLoading}
                  className="text-sm text-ink-500 hover:text-accent disabled:opacity-40 inline-flex items-center gap-1"
                  title="用 AI 產生 2-3 句重點摘要"
                >
                  <Sparkles size={14} />
                  {summaryLoading ? '摘要中…' : 'AI 摘要'}
                </button>
              )}
              <button
                onClick={startEdit}
                disabled={lockState.status === 'acquiring' || lockState.status === 'locked-by-other'}
                className="text-sm text-accent hover:text-accent-dark disabled:opacity-40 inline-flex items-center gap-1"
              >
                {lockState.status === 'locked-by-other' ? (
                  <>{lockState.lockedBy} 正在編輯…</>
                ) : (
                  <><Pencil size={14} /> 編輯</>
                )}
              </button>
            </div>
          )}
          {tab === 'note' && !noteEditing && (
            <button
              onClick={startNoteEdit}
              className="text-sm text-accent hover:text-accent-dark inline-flex items-center gap-1"
            >
              <Pencil size={14} /> 編輯
            </button>
          )}
        </div>

        {tab === 'explanation' && (editing ? (
          <div className="bg-white border-2 border-accent/40 rounded-lg p-4 sm:p-5 shadow-paper">
            <div className="mb-3 text-xs text-ink-500">
              {lockState.status === 'held' && (
                <span>
                  ✓ 你正在編輯 · 鎖至 {new Date(lockState.until).toLocaleTimeString('zh-TW')} ·
                  目前版本 v{data.explanation?.version ?? 0}
                </span>
              )}
            </div>
            <RichEditor
              content={draft}
              onChange={setDraft}
              placeholder="輸入詳解。可貼上圖片、@提及他人,輸入 @114 引用題目。"
              autofocus
            />
            {saveError && (
              <div className="mt-3 p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-sm">
                {saveError}
              </div>
            )}
            <div className="mt-4 flex gap-3 justify-end">
              <button
                onClick={cancelEdit}
                disabled={saving}
                className="px-4 py-2 text-sm text-ink-600 hover:text-ink-900"
              >
                取消
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40"
              >
                {saving ? '儲存中…' : '儲存'}
              </button>
            </div>
          </div>
        ) : hasExplanation ? (
          <>
            {(summary || summaryError) && (
              <aside className="mb-3 bg-amber-50/60 dark:bg-amber-900/10 border border-amber-200/70 dark:border-amber-800/40 rounded-lg p-4 text-sm">
                <div className="flex items-start justify-between gap-3 mb-1">
                  <span className="inline-flex items-center gap-1 text-xs text-amber-800 dark:text-amber-300 font-medium tracking-wide">
                    <Sparkles size={12} /> AI 摘要 · 僅供快速回顧
                  </span>
                  <button
                    onClick={() => { setSummary(null); setSummaryError(null); }}
                    className="text-ink-400 hover:text-ink-600"
                    aria-label="關閉摘要"
                  >
                    <XIcon size={14} />
                  </button>
                </div>
                {summaryError ? (
                  <p className="text-rose-700">{summaryError}</p>
                ) : (
                  <p className="text-ink-800 dark:text-ink-200 whitespace-pre-wrap leading-relaxed">
                    {summary!.text}
                  </p>
                )}
              </aside>
            )}
            <article className="bg-white border border-ink-200 rounded-lg p-5 sm:p-7 shadow-paper">
              <ReadOnlyContent content={explanationJson} />
              <footer className="mt-5 pt-3 border-t border-ink-100 text-xs text-ink-400">
                最近更新:{data.explanation?.updated_by ?? '—'}
                {data.explanation?.updated_at && (
                  <> · {new Date(data.explanation.updated_at).toLocaleString('zh-TW')}</>
                )}
                · v{data.explanation?.version ?? 0}
              </footer>
            </article>
          </>
        ) : (
          <div className="bg-ink-50 border border-dashed border-ink-200 rounded-lg p-8 text-center">
            <p className="text-ink-500 mb-3">尚無詳解,你願意第一個寫嗎?</p>
            <button
              onClick={startEdit}
              className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium"
            >
              開始寫詳解
            </button>
          </div>
        ))}

        {tab === 'note' && (noteEditing ? (
          <div className="bg-white border-2 border-accent/40 rounded-lg p-4 sm:p-5 shadow-paper">
            <div className="mb-3 text-xs text-ink-500">
              ✎ 個人筆記 · 僅你可見
            </div>
            <RichEditor
              content={noteDraft}
              onChange={setNoteDraft}
              placeholder="寫下你的私人筆記。可貼圖、@114 引用其他題目。"
              autofocus
            />
            {noteError && (
              <div className="mt-3 p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-sm">
                {noteError}
              </div>
            )}
            <div className="mt-4 flex gap-3 justify-end">
              <button
                onClick={cancelNoteEdit}
                disabled={noteSaving}
                className="px-4 py-2 text-sm text-ink-600 hover:text-ink-900"
              >
                取消
              </button>
              <button
                onClick={saveNote}
                disabled={noteSaving}
                className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40"
              >
                {noteSaving ? '儲存中…' : '儲存'}
              </button>
            </div>
          </div>
        ) : noteJson ? (
          <article className="bg-white border border-ink-200 rounded-lg p-5 sm:p-7 shadow-paper">
            <ReadOnlyContent content={noteJson} />
            <footer className="mt-5 pt-3 border-t border-ink-100 text-xs text-ink-400">
              僅你可見
              {data.my_note?.updated_at && (
                <> · 最近編輯 {new Date(data.my_note.updated_at).toLocaleString('zh-TW')}</>
              )}
            </footer>
          </article>
        ) : (
          <div className="bg-ink-50 border border-dashed border-ink-200 rounded-lg p-8 text-center">
            <p className="text-ink-500 mb-3">尚未寫下個人筆記。這裡僅你可見。</p>
            <button
              onClick={startNoteEdit}
              className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium"
            >
              開始寫筆記
            </button>
          </div>
        ))}
      </section>

      {/* 相似題目 — tag-overlap with BM25 fallback, hidden when empty */}
      {similar.length > 0 && (
        <section className="mt-8">
          <h2 className="font-serif text-lg text-ink-800 mb-3">相似題目</h2>
          <ul className="space-y-1.5">
            {similar.map((s) => (
              <li
                key={s.id}
                className="bg-white border border-ink-200 rounded p-3 flex items-start gap-3 hover:border-accent transition"
              >
                <Link to={`/q/${s.id}`} className="flex-1 flex items-start gap-3 min-w-0">
                  <span className="font-mono text-sm text-ink-500 shrink-0">
                    {s.year}-{String(s.number).padStart(3, '0')}
                  </span>
                  <span className="text-ink-700 line-clamp-1 flex-1">{s.stem}</span>
                </Link>
                <span
                  className={
                    'text-[11px] px-2 py-0.5 rounded shrink-0 self-center ' +
                    (s.source === 'tag'
                      ? 'bg-emerald-50 text-emerald-800'
                      : 'bg-ink-100 text-ink-600')
                  }
                  title={s.source === 'tag' ? '共用標籤數' : '文字相似 (BM25)'}
                >
                  {s.source === 'tag' ? `共 ${s.shared_tags} 個 tag` : '文字相似'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Back-references — appears only when other questions/comments cite this one */}
      {data.back_refs.length > 0 && (
        <section className="mt-10">
          <h2 className="font-serif text-lg text-ink-800 mb-3 inline-flex items-center gap-2">
            <LinkIcon size={16} className="text-ink-400" /> 被引用 ({data.back_refs.length})
          </h2>
          <ul className="space-y-1.5">
            {data.back_refs.map((r) => (
              <li
                key={`${r.source_type}:${r.source_question_id}:${r.created_at}`}
                className="bg-white border border-ink-200 rounded p-3 flex items-start gap-3 hover:border-accent transition"
              >
                <Link to={`/q/${r.source_question_id}`} className="flex-1 flex items-start gap-3 min-w-0">
                  <span className="font-mono text-sm text-ink-500 shrink-0">{r.source_question_id}</span>
                  <span className="text-ink-700 line-clamp-1 flex-1">{r.source_stem}</span>
                </Link>
                <span className="text-xs text-ink-400 shrink-0 self-center">
                  {r.source_type === 'comment' ? '留言' : '詳解'} · {r.by_email.split('@')[0]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Comments */}
      <section className="mt-12">
        <h2 className="font-serif text-xl text-ink-800 mb-3">討論</h2>
        {me ? (
          <CommentThread questionId={data.id} currentEmail={me.email} />
        ) : (
          <p className="text-ink-400 text-sm">載入使用者…</p>
        )}
      </section>
    </div>
  );
}

// Flatten a TipTap doc to plain text — paragraphs joined by \n\n, headings prefixed
// with #, list items with • / 1. We strip image and mention nodes; the AI doesn't
// need them for a summary and they only inflate the prompt.
function tiptapToText(doc: any): string {
  const parts: string[] = [];
  function walkInline(node: any): string {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    if (node.type === 'mention') return `@${node.attrs?.label || node.attrs?.id || ''}`;
    if (node.type === 'hardBreak') return '\n';
    if (Array.isArray(node.content)) return node.content.map(walkInline).join('');
    return '';
  }
  function walkBlock(node: any) {
    if (!node || !node.type) return;
    if (node.type === 'paragraph' || node.type === 'blockquote') {
      const t = (node.content || []).map(walkInline).join('').trim();
      if (t) parts.push(t);
      return;
    }
    if (node.type === 'heading') {
      const t = (node.content || []).map(walkInline).join('').trim();
      const level = node.attrs?.level ?? 1;
      if (t) parts.push('#'.repeat(level) + ' ' + t);
      return;
    }
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      const ordered = node.type === 'orderedList';
      (node.content || []).forEach((li: any, i: number) => {
        const t = (li.content || []).map((c: any) => walkInline(c)).join('').trim();
        if (t) parts.push((ordered ? `${i + 1}. ` : '• ') + t);
      });
      return;
    }
    if (Array.isArray(node.content)) node.content.forEach(walkBlock);
  }
  walkBlock(doc);
  return parts.join('\n\n').slice(0, 4000);
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'px-4 py-2 -mb-px border-b-2 font-serif text-base transition ' +
        (active
          ? 'border-accent text-ink-900 dark:text-ink-100'
          : 'border-transparent text-ink-500 hover:text-ink-700 dark:hover:text-ink-300')
      }
    >
      {children}
    </button>
  );
}
