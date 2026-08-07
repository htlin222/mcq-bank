import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pencil, Tag, Trash2, Videotape } from "lucide-react";
import { RichEditor } from "../components/RichEditor";
import { NoteContent } from "../components/NoteContent";
import { NoteLinkList } from "../components/NoteLinkList";
import {
	deleteFreeNote,
	getFreeNote,
	getFreeNoteLinks,
	getFreeNoteTags,
	saveFreeNote,
	addFreeNoteTag,
	removeFreeNoteTag,
	type FreeNote as FreeNoteDoc,
	type FreeNoteLink,
	type FreeNoteTag,
} from "../lib/freeNoteApi";

// 其他筆記(自由筆記)的單則頁。設計:
// docs/plans/2026-08-07-free-notes-design.md
//
// 版面刻意跟題目頁的個人筆記面板同構:讀取模式帶畫記,按「編輯」才換成
// RichEditor,下方掛「你可能想連結」。RichEditor 用的是 buildExtensions(),
// 所以 @114-010(連題目)與 @人名 開箱即用,不需要任何新程式。

const TOOL_BTN = (on: boolean) =>
	"inline-flex items-center gap-1 rounded px-2 py-1 text-sm transition " +
	(on
		? "bg-accent/10 text-accent"
		: "text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-700");

export default function FreeNote() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();

	const [note, setNote] = useState<FreeNoteDoc | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<any>(null);
	const [title, setTitle] = useState("");
	const [saving, setSaving] = useState(false);
	const [cloze, setCloze] = useState(false);
	const [tags, setTags] = useState<FreeNoteTag[] | null>(null);
	const [links, setLinks] = useState<FreeNoteLink[]>([]);

	// 載入本體。id 換了要先清空,否則會盯著上一則的內容 —— 跟 useQuestion
	// 當初那個「換題還看得到上一題」是同一類的錯。
	useEffect(() => {
		if (!id) return;
		let alive = true;
		setNote(null);
		setError(null);
		setEditing(false);
		setTags(null);
		setLinks([]);
		getFreeNote(id)
			.then((n) => {
				if (!alive) return;
				setNote(n);
				setTitle(n.title);
			})
			.catch((e) => {
				if (alive) setError(e?.message || "載入失敗");
			});
		return () => {
			alive = false;
		};
	}, [id]);

	// 標籤與建議各自獨立取得:標籤那支可能要等 Workers AI 一兩秒(只在內容
	// 變了時),跟本體綁在一起會讓整頁空著等。
	const reloadSideData = useCallback(() => {
		if (!id) return;
		getFreeNoteTags(id)
			.then(setTags)
			.catch(() => setTags([]));
		getFreeNoteLinks(id)
			.then(setLinks)
			.catch(() => setLinks([]));
	}, [id]);

	// 只在讀取模式抓 —— 編輯中抓回來的建議是舊內容算的,而且存檔後馬上就要
	// 重抓一次,等於白跑。
	useEffect(() => {
		if (note && !editing) reloadSideData();
	}, [note, editing, reloadSideData]);

	async function save() {
		if (!id || !note) return;
		setSaving(true);
		try {
			const content = draft ?? note.content_json;
			await saveFreeNote(id, { title, content_json: content });
			setNote({ ...note, title, content_json: content });
			setDraft(null);
			setEditing(false);
		} catch (e: any) {
			setError(e?.message || "儲存失敗");
		} finally {
			setSaving(false);
		}
	}

	async function remove() {
		if (!id) return;
		if (!confirm("刪除這則筆記?這個動作無法復原。")) return;
		try {
			await deleteFreeNote(id);
			navigate("/lectures?tab=note");
		} catch (e: any) {
			setError(e?.message || "刪除失敗");
		}
	}

	if (error && !note) {
		return (
			<div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
				<BackLink />
				<p className="text-rose-600 dark:text-rose-400 text-sm">
					無法載入筆記:{error}
				</p>
			</div>
		);
	}

	if (!note) {
		return (
			<div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
				<BackLink />
				<div className="h-8 w-2/3 rounded bg-ink-100 dark:bg-ink-800 animate-pulse mb-4" />
				<div className="h-4 w-full rounded bg-ink-100 dark:bg-ink-800 animate-pulse mb-2" />
				<div className="h-4 w-5/6 rounded bg-ink-100 dark:bg-ink-800 animate-pulse" />
			</div>
		);
	}

	return (
		<div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
			<BackLink />

			{editing ? (
				<input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="筆記標題"
					aria-label="筆記標題"
					className="w-full mb-4 bg-transparent font-serif text-2xl text-ink-900 dark:text-ink-100 border-b border-ink-200 dark:border-ink-700 pb-2 focus:outline-none focus:border-accent placeholder:text-ink-300 dark:placeholder:text-ink-600"
				/>
			) : (
				<h1 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-3">
					{note.title || "(未命名筆記)"}
				</h1>
			)}

			<TagRow
				tags={tags}
				editable={!editing}
				onAdd={async (tag) => {
					if (id) setTags(await addFreeNoteTag(id, tag));
				}}
				onRemove={async (tag) => {
					if (id) setTags(await removeFreeNoteTag(id, tag));
				}}
			/>

			{error && (
				<p className="mb-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>
			)}

			<article className="mt-5 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5">
				{editing ? (
					<RichEditor
						content={note.content_json}
						onChange={setDraft}
						placeholder="寫下你的想法…(輸入 @114-010 可以連到題目)"
						autofocus
						toolbarActions={
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={() => {
										setDraft(null);
										setTitle(note.title);
										setEditing(false);
									}}
									className="px-2 py-1 text-sm text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-700 rounded"
								>
									取消
								</button>
								<button
									type="button"
									onClick={save}
									disabled={saving}
									className="px-3 py-1 text-sm rounded bg-accent hover:bg-accent-dark text-white disabled:opacity-50"
								>
									{saving ? "儲存中…" : "儲存"}
								</button>
							</div>
						}
					/>
				) : (
					<>
						<div className="flex flex-wrap items-center gap-1 mb-3 -mt-1">
							<button
								type="button"
								onClick={() => setCloze((v) => !v)}
								title="防劇透:遮住你的螢光標記來自我測驗,點各別揭曉/收回"
								aria-pressed={cloze}
								className={TOOL_BTN(cloze)}
							>
								<Videotape size={14} /> {cloze ? "取消" : "防劇透"}
							</button>
							<button
								type="button"
								onClick={() => setEditing(true)}
								className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-accent hover:bg-accent/10"
							>
								<Pencil size={14} /> 編輯
							</button>
							{/* 平常是灰的、hover 才轉紅 —— 它和「編輯」並排,而兩者的
							    後果完全不對等,顏色要先講清楚這件事。 */}
							<button
								type="button"
								onClick={remove}
								title="刪除這則筆記"
								className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-ink-400 dark:text-ink-500 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/20 dark:hover:text-rose-400"
							>
								<Trash2 size={14} /> 刪除
							</button>
						</div>
						{/* 畫記走全站唯一的 SelectionToolbar,這裡只註冊能力。
						    store_key 前綴 anno:free:<id> —— 收藏頁的「我的畫記」
						    靠這個前綴把它們撈出來。 */}
						<NoteContent
							content={note.content_json}
							annotateKeyPrefix={`anno:free:${note.id}`}
							cloze={cloze}
							// 整頁只有這一則筆記,章節收合著等於打開自己的筆記
							// 只看得到幾個標題。
							defaultSectionsOpen
						/>
						<footer className="mt-5 pt-3 border-t border-ink-100 dark:border-ink-700 text-xs text-ink-400 dark:text-ink-500">
							僅你可見 · 最近編輯{" "}
							{new Date(note.updated_at).toLocaleString("zh-TW")}
						</footer>
						<NoteLinkList links={links} />
					</>
				)}
			</article>
		</div>
	);
}

function BackLink() {
	return (
		<Link
			to="/lectures?tab=note"
			className="inline-flex items-center gap-1 mb-4 text-sm text-ink-500 dark:text-ink-400 hover:text-accent"
		>
			<ArrowLeft size={14} /> 其他筆記
		</Link>
	);
}

// AI 標籤與手動標籤並排,靠底色區分。刪除送 DELETE(伺服器寫墓碑),
// 新增送 POST —— 兩者都回傳整組最新標籤,所以本地不用自己拼結果。
function TagRow({
	tags,
	editable,
	onAdd,
	onRemove,
}: {
	tags: FreeNoteTag[] | null;
	editable: boolean;
	onAdd: (tag: string) => void | Promise<void>;
	onRemove: (tag: string) => void | Promise<void>;
}) {
	const [adding, setAdding] = useState(false);
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (adding) inputRef.current?.focus();
	}, [adding]);

	if (tags === null) {
		return (
			<div className="flex items-center gap-2" aria-label="標籤載入中">
				<div className="h-5 w-16 rounded-full bg-ink-100 dark:bg-ink-800 animate-pulse" />
				<div className="h-5 w-20 rounded-full bg-ink-100 dark:bg-ink-800 animate-pulse" />
			</div>
		);
	}

	const names = tags.map((t) => t.tag);

	function submit() {
		const v = value.trim();
		setValue("");
		setAdding(false);
		if (v && !names.includes(v)) onAdd(v);
	}

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<Tag size={13} className="text-ink-400 dark:text-ink-500" aria-hidden="true" />
			{names.length === 0 && !adding && (
				<span className="text-xs text-ink-400 dark:text-ink-500">
					還沒有標籤 —— 寫點內容後會自動產生
				</span>
			)}
			{tags.map((t) => (
				<span
					key={t.tag}
					title={t.source === "ai" ? "AI 依內容產生" : "你加的標籤"}
					className={
						"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs " +
						(t.source === "ai"
							? "bg-accent/10 text-accent"
							: "bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300")
					}
				>
					{t.tag}
					{editable && (
						<button
							type="button"
							aria-label={`移除標籤 ${t.tag}`}
							onClick={() => onRemove(t.tag)}
							className="opacity-50 hover:opacity-100"
						>
							×
						</button>
					)}
				</span>
			))}
			{editable &&
				(adding ? (
					<input
						ref={inputRef}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onBlur={submit}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
							if (e.key === "Escape") {
								setValue("");
								setAdding(false);
							}
						}}
						placeholder="新標籤"
						aria-label="新增標籤"
						className="w-24 rounded-full border border-ink-200 dark:border-ink-700 bg-transparent px-2 py-0.5 text-xs focus:outline-none focus:border-accent"
					/>
				) : (
					<button
						type="button"
						onClick={() => setAdding(true)}
						className="rounded-full px-2 py-0.5 text-xs text-ink-400 dark:text-ink-500 hover:text-accent hover:bg-accent/10"
					>
						+ 標籤
					</button>
				))}
		</div>
	);
}
