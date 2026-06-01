import { useState, useEffect, useMemo } from 'react';
import { api } from '../lib/api';
import { Avatar } from './Avatar';
import { RichEditor } from './RichEditor';
import { ReadOnlyContent } from './ReadOnlyContent';
import { CommentListSkeleton } from './Skeleton';

type Comment = {
  id: string;
  question_id: string;
  parent_id: string | null;
  author_email: string;
  display_name: string;
  avatar_key: string | null;
  content_json: string;
  created_at: number;
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

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get<Comment[]>(`/api/questions/${questionId}/comments`);
      setComments(data);
      onCountChange?.(data.length);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [questionId]);

  const tree = useMemo(() => buildTree(comments), [comments]);

  return (
    <section className="space-y-6">
      <h3 className="text-lg font-serif font-semibold text-ink-800 dark:text-ink-100 border-b border-ink-200 dark:border-ink-700 pb-2">
        討論串 <span className="text-ink-400 dark:text-ink-500 text-sm font-sans font-normal">({comments.length})</span>
      </h3>

      <NewCommentBox questionId={questionId} onPosted={load} />

      {loading ? (
        <CommentListSkeleton count={3} />
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
  const [content, setContent] = useState<any>({ type: 'doc', content: [] });
  const [busy, setBusy] = useState(false);
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
        onChange={setContent}
        placeholder={parentId ? '回覆…  (@提及成員)' : '寫下你的想法,@提及其他成員…'}
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-800 dark:hover:text-ink-100">
            取消
          </button>
        )}
        <button
          onClick={submit}
          disabled={busy}
          className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-dark disabled:opacity-50 transition-colors"
        >
          {busy ? '送出中…' : (parentId ? '回覆' : '發表')}
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
  const [editContent, setEditContent] = useState<any>(JSON.parse(comment.content_json));
  const isOwn = comment.author_email === currentEmail;
  const maxDepth = 3;

  const saveEdit = async () => {
    await api.patch(`/api/questions/${questionId}/comments/${comment.id}`, {
      content_json: editContent,
    });
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
              <RichEditor content={editContent} onChange={setEditContent} />
              <div className="flex gap-2">
                <button onClick={saveEdit} className="px-3 py-1 text-sm bg-accent text-white rounded">儲存</button>
                <button onClick={() => setEditing(false)} className="px-3 py-1 text-sm text-ink-600 dark:text-ink-300">取消</button>
              </div>
            </div>
          ) : (
            <div className="prose prose-sm">
              <ReadOnlyContent content={JSON.parse(comment.content_json)} />
            </div>
          )}

          <footer className="flex gap-3 mt-2 text-xs text-ink-500 dark:text-ink-400">
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
