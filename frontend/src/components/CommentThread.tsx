import { useState, useEffect, useMemo, useRef } from "react";
import { ThumbsUp } from "lucide-react";
import {
	postComment,
	editComment,
	deleteComment,
	toggleHelpful as voteHelpful,
	type Comment,
} from "../lib/commentApi";
import { useComments } from "../hooks/useComments";
import { rankByHelpful } from "../lib/helpful";
import { loadDraft, saveDraft, clearDraft, isEmptyDoc } from "../lib/drafts";
import { Avatar } from "./Avatar";
import { RichEditor } from "./RichEditor";
import { StaticContent } from "./StaticContent";
import { CommentListSkeleton } from "./Skeleton";
import { useOnline } from "../hooks/useOnline";

// 沒有資料時共用同一個空陣列 —— 每次 render 造一個新的,會讓下面那個 useMemo
// 的依賴每次都變,白白重算整棵樹。
const NO_COMMENTS: Comment[] = [];

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
	// 讀取走 commentCache(見 lib/commentApi.ts):切分頁、換題回來都不再重抓。
	const { comments: cached, loading, reload } = useComments(questionId);
	const comments = cached ?? NO_COMMENTS;
	// The empty case is the common one, and the fetch is tiny — so flashing a
	// 3-row skeleton and then collapsing to a one-line「還沒有討論」bumps the
	// layout jarringly. Only reveal the skeleton if the load is actually slow.
	const [showSkeleton, setShowSkeleton] = useState(false);
	// 預設時間序 —— 討論串的可讀性來自時序。「最有幫助」是使用者主動切換的檢視。
	const [sort, setSort] = useState<"time" | "helpful">("time");

	useEffect(() => {
		if (!loading) {
			setShowSkeleton(false);
			return;
		}
		const slow = setTimeout(() => setShowSkeleton(true), 300);
		return () => clearTimeout(slow);
	}, [loading]);

	// 分頁徽章跟著實際筆數走。`cached` 為 null(還沒抓到)時不報 —— 報 0 會讓徽章
	// 先跳成 0 再跳回真值,而題目 payload 裡的 comment_count 本來就是對的。
	useEffect(() => {
		if (cached) onCountChange?.(cached.length);
	}, [cached, onCountChange]);

	// 排序只作用在 root 層;子回覆永遠維持時序,否則對話讀不通。
	const tree = useMemo(() => {
		const roots = buildTree(comments);
		return sort === "helpful" ? rankByHelpful(roots, Date.now()) : roots;
	}, [comments, sort]);

	return (
		<section className="space-y-6">
			<div className="flex items-center gap-3 border-b border-ink-200 dark:border-ink-700 pb-2">
				<h3 className="text-lg font-serif font-semibold text-ink-800 dark:text-ink-100">
					討論串{" "}
					<span className="text-ink-400 dark:text-ink-500 text-sm font-sans font-normal">
						({comments.length})
					</span>
				</h3>
				{comments.length > 1 && (
					<div className="ml-auto flex gap-1">
						{(["time", "helpful"] as const).map((k) => (
							<button
								key={k}
								onClick={() => setSort(k)}
								aria-pressed={sort === k}
								className={
									"px-2.5 py-1 rounded text-xs transition " +
									(sort === k
										? "bg-accent text-white"
										: "bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300 hover:bg-ink-200 dark:hover:bg-ink-600")
								}
							>
								{k === "time" ? "依時間" : "最有幫助"}
							</button>
						))}
					</div>
				)}
			</div>

			<NewCommentBox questionId={questionId} onPosted={reload} />

			{loading ? (
				showSkeleton ? (
					<CommentListSkeleton count={3} />
				) : null
			) : tree.length === 0 ? (
				<p className="text-ink-400 dark:text-ink-500 text-sm italic">
					還沒有討論。寫第一則吧。
				</p>
			) : (
				<ul className="space-y-4">
					{tree.map((c) => (
						<CommentItem
							key={c.id}
							comment={c}
							questionId={questionId}
							currentEmail={currentEmail}
							onChange={reload}
							depth={0}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function NewCommentBox({
	questionId,
	parentId,
	onPosted,
	onCancel,
}: {
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
		() => loadDraft(draftKey) ?? { type: "doc", content: [] },
	);
	// 編輯器要到使用者表示「我要寫」才建。RichEditor 是可編輯的 TipTap,一掛載就
	// 同步建一次 EditorView —— 量到的是 CPU 節流 6x 底下 66.7ms,而那一題**一則留言
	// 都沒有**,那個時間全部是它自己的。開討論串多半是為了看,不是為了寫。
	//
	// 兩種情況要直接展開:
	//
	//   • **這是回覆框。** 它本來就是按下「回覆」才掛載的,那一下已經表達過意圖 ——
	//     再要一次點擊只是把成本轉嫁給每一個要回覆的人。
	//   • **手上有沒送出的草稿。** 看不見的草稿等於弄丟了,而使用者不會知道要去
	//     點一下才找得回來。判準用 `isEmptyDoc()` 而不是 `loadDraft() !== null` ——
	//     後者會被「打了字又刪掉」留下的空文件騙到。
	const [open, setOpen] = useState(
		() => !!parentId || !isEmptyDoc(loadDraft(draftKey)),
	);
	const [busy, setBusy] = useState(false);
	// 留言離線送不出去(也沒有離線佇列),寧可停用按鈕也不要送出後才失敗。
	const online = useOnline();
	const [resetKey, setResetKey] = useState(0);
	// 冪等:同一次送出動作沿用同一個 key(網路重試不重複建留言),成功後重置。
	const idemKey = useRef<string | null>(null);

	const submit = async () => {
		const isEmpty =
			!content?.content?.length ||
			(content.content.length === 1 && !content.content[0]?.content?.length);
		if (isEmpty) return;
		setBusy(true);
		if (!idemKey.current) idemKey.current = crypto.randomUUID();
		try {
			await postComment(
				questionId,
				{ content_json: content, parent_id: parentId },
				idemKey.current,
			);
			idemKey.current = null;
			clearDraft(draftKey);
			setContent({ type: "doc", content: [] });
			setResetKey((k) => k + 1);
			onPosted();
			onCancel?.();
		} finally {
			setBusy(false);
		}
	};

	const prompt = parentId
		? "回覆…  (@提及成員)"
		: "寫下你的想法,@提及其他成員…";

	// 收起來的樣子刻意長得像輸入框(同樣的框線、圓角、內距與灰字提示),不是一顆
	// 「寫留言」按鈕 —— 那會多一個要看懂的東西。點下去 `autofocus` 讓游標直接進去,
	// 所以真的要留言的人並沒有多按一下。
	if (!open) {
		return (
			<button
				type="button"
				data-comment-composer=""
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

function CommentItem({
	comment,
	questionId,
	currentEmail,
	onChange,
	depth,
}: {
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
			const r = await voteHelpful(questionId, comment.id, prev.mine);
			setHelpful({ count: r.helpful_count, mine: !prev.mine }); // 以伺服器為準
		} catch {
			setHelpful(prev);
		} finally {
			setVoting(false);
		}
	};

	const saveEdit = async () => {
		await editComment(questionId, comment.id, editContent);
		clearDraft(editDraftKey);
		setEditing(false);
		onChange();
	};

	const remove = async () => {
		if (!confirm("刪除這則留言?")) return;
		await deleteComment(questionId, comment.id);
		onChange();
	};

	return (
		<li
			className={
				depth === 0 ? "" : "ml-6 sm:ml-10 border-l-2 border-ink-100 pl-4"
			}
		>
			<article className="flex gap-3 fade-in">
				<Avatar
					email={comment.author_email}
					avatarKey={comment.avatar_key}
					name={comment.display_name}
					size={36}
				/>
				<div className="flex-1 min-w-0">
					<header className="flex items-baseline gap-2 mb-1">
						<span className="font-semibold text-ink-800 dark:text-ink-100">
							{comment.display_name}
						</span>
						<time className="text-xs text-ink-400 dark:text-ink-500">
							{new Date(comment.created_at).toLocaleString("zh-TW")}
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
								<button
									onClick={saveEdit}
									className="px-3 py-1 text-sm bg-accent text-white rounded"
								>
									儲存
								</button>
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
							<StaticContent content={JSON.parse(comment.content_json)} />
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
								title={helpful.mine ? "取消標記" : "這則留言幫到我了"}
								className={
									"inline-flex items-center gap-1 transition-colors disabled:opacity-50 " +
									(helpful.mine ? "text-accent" : "hover:text-accent")
								}
							>
								<ThumbsUp
									size={13}
									className={helpful.mine ? "fill-current" : undefined}
								/>
								{helpful.count > 0 && helpful.count}
								<span className="sr-only">有幫助</span>
							</button>
						)}
						{depth < maxDepth && !editing && (
							<button
								onClick={() => setReplying(!replying)}
								className="hover:text-accent"
							>
								{replying ? "取消回覆" : "回覆"}
							</button>
						)}
						{isOwn && !editing && (
							<>
								<button
									onClick={() => setEditing(true)}
									className="hover:text-accent"
								>
									編輯
								</button>
								<button onClick={remove} className="hover:text-accent">
									刪除
								</button>
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
