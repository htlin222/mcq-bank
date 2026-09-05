import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../lib/api";
import {
	deleteSmearComment,
	fetchSmearComments,
	postSmearComment,
	type SmearComment,
} from "../../lib/smearApi";
import { loadDraft, saveDraft, clearDraft, isEmptyDoc } from "../../lib/drafts";
import { Avatar } from "../Avatar";
import { RichEditor } from "../RichEditor";
import { StaticContent } from "../StaticContent";
import { useOnline } from "../../hooks/useOnline";

// 抹片診斷的討論串 —— 視覺/互動同 CommentThread.tsx(樹狀建構、懶掛載的
// 留言輸入框),但打的是 smear-community 的端點,而且刻意比 MCQ 那份簡單:
// 沒有 @mention、沒有「有幫助」投票、沒有編輯,只有發表/回覆/刪除(作者本人
// 或 admin)。CLAUDE.md「檢討介面只有一套」那節講的是共用元件,這裡是同一份
// 視覺語彙的**獨立實作**——後端形狀完全不同(dx_id 不是 question_id,沒有
// helpful_count/voted_by_me),硬要 import CommentThread.tsx 只會逼它長出一堆
// if (isSmear) 分支。

const NO_COMMENTS: SmearComment[] = [];

type Tree = SmearComment & { children: Tree[] };

function buildTree(items: SmearComment[]): Tree[] {
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

export function SmearCommentThread({
	dxId,
	currentEmail,
	isAdmin,
}: {
	dxId: string;
	currentEmail: string | undefined;
	isAdmin: boolean;
}) {
	const [comments, setComments] = useState<SmearComment[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [showSkeleton, setShowSkeleton] = useState(false);

	async function reload() {
		try {
			const list = await fetchSmearComments(dxId);
			setComments(Array.isArray(list) ? list : []);
		} catch (e) {
			setComments([]);
			setLoadError(e instanceof ApiError ? `讀取失敗 (${e.status})` : String(e));
		}
	}

	useEffect(() => {
		let cancelled = false;
		setComments(null);
		setLoadError(null);
		fetchSmearComments(dxId)
			.then((list) => {
				if (!cancelled) setComments(Array.isArray(list) ? list : []);
			})
			.catch((e) => {
				if (cancelled) return;
				setComments([]);
				setLoadError(e instanceof ApiError ? `讀取失敗 (${e.status})` : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [dxId]);

	const loading = comments === null;
	useEffect(() => {
		if (!loading) {
			setShowSkeleton(false);
			return;
		}
		const t = setTimeout(() => setShowSkeleton(true), 300);
		return () => clearTimeout(t);
	}, [loading]);

	const list = comments ?? NO_COMMENTS;
	const tree = useMemo(() => buildTree(list), [list]);

	return (
		<section className="space-y-5">
			<h3 className="text-base font-serif font-semibold text-ink-800 dark:text-ink-100">
				討論{" "}
				<span className="text-ink-400 dark:text-ink-500 text-sm font-sans font-normal">
					({list.length})
				</span>
			</h3>

			<NewSmearCommentBox dxId={dxId} onPosted={reload} />

			{loadError ? (
				<p className="text-accent text-sm">讀取失敗:{loadError}</p>
			) : loading ? (
				showSkeleton ? (
					<p className="text-sm text-ink-400 dark:text-ink-500">載入中…</p>
				) : null
			) : tree.length === 0 ? (
				<p className="text-ink-400 dark:text-ink-500 text-sm italic">
					還沒有討論。寫第一則吧。
				</p>
			) : (
				<ul className="space-y-4">
					{tree.map((c) => (
						<SmearCommentItem
							key={c.id}
							comment={c}
							dxId={dxId}
							currentEmail={currentEmail}
							isAdmin={isAdmin}
							onChange={reload}
							depth={0}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function NewSmearCommentBox({
	dxId,
	parentId,
	onPosted,
	onCancel,
}: {
	dxId: string;
	parentId?: string;
	onPosted: () => void;
	onCancel?: () => void;
}) {
	const draftKey = parentId
		? `smear-comment:${dxId}:${parentId}`
		: `smear-comment:${dxId}`;
	const [content, setContent] = useState<any>(
		() => loadDraft(draftKey) ?? { type: "doc", content: [] },
	);
	// 同 CommentThread.tsx 的 NewCommentBox:編輯器要到使用者表示「我要寫」才建
	// (一掛載就同步建 EditorView 的成本見 CLAUDE.md「分頁的載入卡頓」)。回覆框
	// 一律直接展開(按「回覆」已經表達過意圖),手上有未送出草稿也直接展開。
	const [open, setOpen] = useState(
		() => !!parentId || !isEmptyDoc(loadDraft(draftKey)),
	);
	const [busy, setBusy] = useState(false);
	const online = useOnline();
	const [resetKey, setResetKey] = useState(0);

	async function submit() {
		const isEmpty =
			!content?.content?.length ||
			(content.content.length === 1 && !content.content[0]?.content?.length);
		if (isEmpty) return;
		setBusy(true);
		try {
			await postSmearComment(dxId, { content_json: content, parent_id: parentId });
			clearDraft(draftKey);
			setContent({ type: "doc", content: [] });
			setResetKey((k) => k + 1);
			onPosted();
			onCancel?.();
		} catch {
			alert("送出失敗,請稍後再試。");
		} finally {
			setBusy(false);
		}
	}

	const prompt = parentId ? "回覆…" : "分享你對這張抹片的想法…";

	if (!open) {
		return (
			<button
				type="button"
				data-smear-comment-composer=""
				onClick={() => setOpen(true)}
				className="w-full text-left px-3 py-2.5 rounded border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-400 dark:text-ink-500 italic hover:border-ink-300 dark:hover:border-ink-600 transition-colors"
			>
				{prompt}
			</button>
		);
	}

	return (
		<div className="space-y-2">
			<RichEditor
				key={resetKey}
				content={content}
				autofocus
				onChange={(j) => {
					setContent(j);
					saveDraft(draftKey, j);
				}}
				placeholder={prompt}
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
					title={online ? undefined : "離線中,連線後才能送出"}
					className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-dark disabled:opacity-50 transition-colors"
				>
					{!online ? "離線中" : busy ? "送出中…" : parentId ? "回覆" : "發表"}
				</button>
			</div>
		</div>
	);
}

function SmearCommentItem({
	comment,
	dxId,
	currentEmail,
	isAdmin,
	onChange,
	depth,
}: {
	comment: Tree;
	dxId: string;
	currentEmail: string | undefined;
	isAdmin: boolean;
	onChange: () => void;
	depth: number;
}) {
	const [replying, setReplying] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const isOwn = !!currentEmail && comment.author_email === currentEmail;
	const canDelete = isOwn || isAdmin;
	const maxDepth = 3;

	async function remove() {
		if (!confirm("刪除這則留言?")) return;
		setDeleting(true);
		try {
			await deleteSmearComment(comment.id);
			onChange();
		} catch {
			alert("刪除失敗,請稍後再試。");
			setDeleting(false);
		}
	}

	let parsed: unknown = null;
	try {
		parsed = JSON.parse(comment.content_json);
	} catch {
		parsed = null;
	}

	return (
		<li
			className={depth === 0 ? "" : "ml-6 sm:ml-10 border-l-2 border-ink-100 dark:border-ink-700 pl-4"}
		>
			<article className="flex gap-3 fade-in">
				<Avatar
					email={comment.author_email}
					avatarKey={comment.avatar_key}
					name={comment.display_name}
					size={36}
				/>
				<div className="flex-1 min-w-0">
					<header className="flex items-baseline gap-2 mb-1 flex-wrap">
						<span className="font-semibold text-ink-800 dark:text-ink-100 break-words">
							{comment.display_name ?? comment.author_email}
						</span>
						<time className="text-xs text-ink-400 dark:text-ink-500">
							{new Date(comment.created_at).toLocaleString("zh-TW")}
						</time>
					</header>

					<div className="prose prose-sm break-words">
						<StaticContent content={parsed} />
					</div>

					<footer className="flex gap-3 mt-2 text-xs text-ink-500 dark:text-ink-400">
						{depth < maxDepth && (
							<button
								type="button"
								onClick={() => setReplying(!replying)}
								className="hover:text-accent"
							>
								{replying ? "取消回覆" : "回覆"}
							</button>
						)}
						{canDelete && (
							<button
								type="button"
								onClick={remove}
								disabled={deleting}
								className="hover:text-accent disabled:opacity-50"
							>
								{deleting ? "刪除中…" : "刪除"}
							</button>
						)}
					</footer>

					{replying && (
						<div className="mt-3">
							<NewSmearCommentBox
								dxId={dxId}
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
						<SmearCommentItem
							key={child.id}
							comment={child}
							dxId={dxId}
							currentEmail={currentEmail}
							isAdmin={isAdmin}
							onChange={onChange}
							depth={depth + 1}
						/>
					))}
				</ul>
			)}
		</li>
	);
}
