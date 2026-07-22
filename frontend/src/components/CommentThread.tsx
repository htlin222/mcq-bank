import { useState, useEffect, useMemo } from 'react';
import { ThumbsUp } from 'lucide-react';
import { api } from '../lib/api';
import { rankByHelpful } from '../lib/helpful';
import { loadDraft, saveDraft, clearDraft } from '../lib/drafts';
import { Avatar } from './Avatar';
import { RichEditor } from './RichEditor';
import { ReadOnlyContent } from './ReadOnlyContent';
import { CommentListSkeleton } from './Skeleton';
import { useOnline } from '../hooks/useOnline';

type Comment = {
  id: string;
  question_id: string;
  parent_id: string | null;
  author_email: string;
  display_name: string;
  avatar_key: string | null;
  content_json: string;
  created_at: number;
  helpful_count: number;
  voted_by_me: 0 | 1;
  // 該題有 status='promoted' 的挑戰,且本留言作者就是提案人 —— 社群已用
  // 行動認證過這個人的判斷,「最有幫助」時置頂。
  adopted: 0 | 1;
};

type Tree = Comment & { children: Tree[] };

function buildTree(items: Comment[]): Tree[] {
  const byId = new Map<string, Tree>();
  items.forEach((c) => byId.set(c.id, { ...c, children: [] }));
  const roots: Tree[] = [];
  byId.forEach((c) => {
    if (c.parent_id && byId.has(c.parent_id)) {
      byId.get(c.parent_id)!.children.push(c);
    } else {
      roots.push(c);
    }
  });
  return roots;
}

export function CommentThread({
  questionId,
  currentEmail,
  onCountChange,
}: {
  questionId: string;
  currentEmail: string;
  // Optional callback so a parent (e.g., Question.tsx) can refresh a tab badge
  // when comments are added/edited/deleted without re-fetching the question.
  onCountChange?: (n: number) => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  // The empty case is the common one, and the fetch is tiny — so flashing a
  // 3-row skeleton and then collapsing to a one-line「還沒有討論」bumps the
  // layout jarringly. Only reveal the skeleton if the load is actually slow.
  const [showSkeleton, setShowSkeleton] = useState(false);
  // 預設時間序 —— 討論串的可讀性來自時序。「最有幫助」是使用者主動切換的檢視。
  const [sort, setSort] = useState<'time' | 'helpful'>('time');

  const load = async () => {
    setLoading(true);
    const slow = setTimeout(() => setShowSkeleton(true), 300);
    try {
      const data = await api.get<Comment[]>(`/api/questions/${questionId}/comments`);
      setComments(data);
      onCountChange?.(data.length);
    } finally {
      clearTimeout(slow);
      setShowSkeleton(false);
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [questionId]);

  // 排序只作用在 root 層;子回覆永遠維持時序,否則對話讀不通。
  const tree = useMemo(() => {
    const roots = buildTree(comments);
    return sort === 'helpful' ? rankByHelpful(roots, Date.now()) : roots;
  }, [comments, sort]);

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3 border-b border-ink-200 dark:border-ink-700 pb-2">
        <h3 className="text-lg font-serif font-semibold text-ink-800 dark:text-ink-100">
          討論串 <span className="text-ink-400 dark:text-ink-500 text-sm font-sans font-normal">({comments.length})</span>
        </h3>
        {comments.length > 1 && (
          <div className="ml-auto flex gap-1">
            {(['time', 'helpful'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setSort(k)}
                aria-pressed={sort === k}
                className={
                  'px-2.5 py-1 rounded text-xs transition ' +
                  (sort === k
                    ? 'bg-accent text-white'
                    : 'bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300 hover:bg-ink-200 dark:hover:bg-ink-600')
                }
              >
                {k === 'time' ? '依時間' : '最有幫助'}
              </button>
            ))}
          </div>
        )}
      </div>

      <NewCommentBox questionId={questionId} onPosted={load} />

      {loading ? (
        showSkeleton ? <CommentListSkeleton count={3} /> : null
      ) : tree.length === 0 ? (
        <p className="text-ink-400 dark:text-ink-500 text-sm italic">還沒有討論。寫第一則吧。</p>
      ) : (
        <ul className="space-y-4">
          {tree.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              questionId={questionId}
              currentEmail={currentEmail}
              onChange={load}
              depth={0}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function NewCommentBox({ questionId, parentId, onPosted, onCancel }: {
  questionId: string;
  parentId?: string;
  onPosted: () => void;
  onCancel?: () => void;
}) {
  // Unsent comment survives route switches — draft lives in sessionStorage.
  const draftKey = parentId
    ? `comment:${questionId}:${parentId}`
    : `comment:${questionId}`;
  const [content, setContent] = useState<any>(
    () => loadDraft(draftKey) ?? { type: 'doc', content: [] },
  );
  const [busy, setBusy] = useState(false);
  // 留言離線送不出去(也沒有離線佇列),寧可停用按鈕也不要送出後才失敗。
  const online = useOnline();
  const [resetKey, setResetKey] = useState(0);

  const submit = async () => {
    const isEmpty = !content?.content?.length ||
      (content.content.length === 1 && !content.content[0]?.content?.length);
    if (isEmpty) return;
    setBusy(true);
    try {
      await api.post(`/api/questions/${questionId}/comments`, {
        content_json: content,
        parent_id: parentId,
      });
      clearDraft(draftKey);
      setContent({ type: 'doc', content: [] });
      setResetKey((k) => k + 1);
      onPosted();
      onCancel?.();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <RichEditor
        key={resetKey}
        content={content}
        onChange={(j) => {
          setContent(j);
          saveDraft(draftKey, j);
        }}
        placeholder={parentId ? '回覆…  (@提及成員)' : '寫下你的想法,@提及其他成員…'}
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button
            onClick={() => {
              clearDraft(draftKey);
              onCancel();
            }}
            className="px-3 py-1.5 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-800 dark:hover:text-ink-100"
          >
            取消
          </button>
        )}
        <button
          onClick={submit}
          disabled={busy || !online}
          title={online ? undefined : '離線中,連線後才能送出'}
          className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-dark disabled:opacity-50 transition-colors"
        >
          {!online ? '離線中' : busy ? '送出中…' : (parentId ? '回覆' : '發表')}
        </button>
      </div>
    </div>
  );
}

function CommentItem({ comment, questionId, currentEmail, onChange, depth }: {
  comment: Tree;
  questionId: string;
  currentEmail: string;
  onChange: () => void;
  depth: number;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  // A half-finished edit survives route switches via sessionStorage.
  const editDraftKey = `comment-edit:${comment.id}`;
  const [editContent, setEditContent] = useState<any>(
    () => loadDraft(editDraftKey) ?? JSON.parse(comment.content_json),
  );
  const isOwn = comment.author_email === currentEmail;
  const maxDepth = 3;

  // 「有幫助」樂觀更新:只動本地狀態,不重抓整串(重抓會把展開中的回覆框、
  // 編輯草稿一併重置)。失敗就回滾。
  const [helpful, setHelpful] = useState({
    count: comment.helpful_count ?? 0,
    mine: comment.voted_by_me === 1,
  });
  const [voting, setVoting] = useState(false);

  // 整串重抓(有人發文/編輯/刪除)時,把別人投的票同步進來。飛行中不動,
  // 免得覆蓋掉樂觀更新。
  useEffect(() => {
    if (voting) return;
    setHelpful({
      count: comment.helpful_count ?? 0,
      mine: comment.voted_by_me === 1,
    });
  }, [comment.helpful_count, comment.voted_by_me]);

  const toggleHelpful = async () => {
    if (voting || isOwn) return;
    const prev = helpful;
    setHelpful({ count: prev.count + (prev.mine ? -1 : 1), mine: !prev.mine });
    setVoting(true);
    try {
      const r = prev.mine
        ? await api.del<{ helpful_count: number }>(`/api/comments/${comment.id}/helpful`)
        : await api.post<{ helpful_count: number }>(`/api/comments/${comment.id}/helpful`, {});
      setHelpful({ count: r.helpful_count, mine: !prev.mine }); // 以伺服器為準
    } catch {
      setHelpful(prev);
    } finally {
      setVoting(false);
    }
  };

  const saveEdit = async () => {
    await api.patch(`/api/questions/${questionId}/comments/${comment.id}`, {
      content_json: editContent,
    });
    clearDraft(editDraftKey);
    setEditing(false);
    onChange();
  };

  const remove = async () => {
    if (!confirm('刪除這則留言?')) return;
    await api.del(`/api/questions/${questionId}/comments/${comment.id}`);
    onChange();
  };

  return (
    <li className={depth === 0 ? '' : 'ml-6 sm:ml-10 border-l-2 border-ink-100 pl-4'}>
      <article className="flex gap-3 fade-in">
        <Avatar
          email={comment.author_email}
          avatarKey={comment.avatar_key}
          name={comment.display_name}
          size={36}
        />
        <div className="flex-1 min-w-0">
          <header className="flex items-baseline gap-2 mb-1">
            <span className="font-semibold text-ink-800 dark:text-ink-100">{comment.display_name}</span>
            <time className="text-xs text-ink-400 dark:text-ink-500">
              {new Date(comment.created_at).toLocaleString('zh-TW')}
            </time>
          </header>

          {editing ? (
            <div className="space-y-2">
              <RichEditor
                content={editContent}
                onChange={(j) => {
                  setEditContent(j);
                  saveDraft(editDraftKey, j);
                }}
              />
              <div className="flex gap-2">
                <button onClick={saveEdit} className="px-3 py-1 text-sm bg-accent text-white rounded">儲存</button>
                <button
                  onClick={() => {
                    clearDraft(editDraftKey);
                    setEditContent(JSON.parse(comment.content_json));
                    setEditing(false);
                  }}
                  className="px-3 py-1 text-sm text-ink-600 dark:text-ink-300"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="prose prose-sm">
              <ReadOnlyContent content={JSON.parse(comment.content_json)} />
            </div>
          )}

          <footer className="flex gap-3 mt-2 text-xs text-ink-500 dark:text-ink-400">
            {/* 自己的留言只顯示計數(對應 API 的 403 禁止自投);零票時連數字
                都不顯示,版面保持安靜、也不讓沒人按的留言變成公開的難堪。 */}
            {isOwn ? (
              helpful.count > 0 && (
                <span className="inline-flex items-center gap-1 text-ink-400 dark:text-ink-500">
                  <ThumbsUp size={13} /> {helpful.count}
                </span>
              )
            ) : (
              <button
                onClick={toggleHelpful}
                disabled={voting}
                aria-pressed={helpful.mine}
                title={helpful.mine ? '取消標記' : '這則留言幫到我了'}
                className={
                  'inline-flex items-center gap-1 transition-colors disabled:opacity-50 ' +
                  (helpful.mine ? 'text-accent' : 'hover:text-accent')
                }
              >
                <ThumbsUp size={13} className={helpful.mine ? 'fill-current' : undefined} />
                {helpful.count > 0 && helpful.count}
                <span className="sr-only">有幫助</span>
              </button>
            )}
            {depth < maxDepth && !editing && (
              <button onClick={() => setReplying(!replying)} className="hover:text-accent">
                {replying ? '取消回覆' : '回覆'}
              </button>
            )}
            {isOwn && !editing && (
              <>
                <button onClick={() => setEditing(true)} className="hover:text-accent">編輯</button>
                <button onClick={remove} className="hover:text-accent">刪除</button>
              </>
            )}
          </footer>

          {replying && (
            <div className="mt-3">
              <NewCommentBox
                questionId={questionId}
                parentId={comment.id}
                onPosted={onChange}
                onCancel={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      </article>

      {comment.children.length > 0 && (
        <ul className="mt-3 space-y-3">
          {comment.children.map((child) => (
            <CommentItem
              key={child.id}
              comment={child}
              questionId={questionId}
              currentEmail={currentEmail}
              onChange={onChange}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
