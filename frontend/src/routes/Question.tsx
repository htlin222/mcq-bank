import { useEffect, useState, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useQuestion } from '../hooks/useQuestion';
import { useLock } from '../hooks/useLock';
import { useMe } from '../hooks/useMe';
import { QuestionCard } from '../components/QuestionCard';
import { RichEditor } from '../components/RichEditor';
import { ReadOnlyContent } from '../components/ReadOnlyContent';
import { CommentThread } from '../components/CommentThread';

export function Question() {
  const { id } = useParams<{ id: string }>();
  const { me } = useMe();
  const { data, loading, error, reload } = useQuestion(id);
  const { state: lockState, acquire, release } = useLock(id || '');

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const explanationJson = useMemo(() => {
    if (!data?.explanation?.content_json) return null;
    try {
      return JSON.parse(data.explanation.content_json);
    } catch {
      return null;
    }
  }, [data?.explanation?.content_json]);

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
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-32">
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

      {/* Explanation block */}
      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-serif text-xl text-ink-800">詳解共筆</h2>
          {!editing && (
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
          )}
        </div>

        {editing ? (
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
              placeholder="輸入詳解。可貼上圖片、@提及他人。"
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
        )}
      </section>

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
