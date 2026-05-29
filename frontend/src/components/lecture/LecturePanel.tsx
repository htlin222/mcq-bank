// Right-hand reader panel (desktop) / bottom-sheet (mobile <md). Two tabs:
//   筆記  — page-anchored notebook (RichEditor, supports @114-001 question refs)
//   標註  — highlight list; click a row to jump, delete to remove
//
// Notes/annotations are per-user, so every row here is editable/deletable.
import { useEffect, useMemo, useState } from "react";
import { Trash2, Pencil, MapPin, X as XIcon, Plus } from "lucide-react";
import { RichEditor } from "../RichEditor";
import type { LectureNote, LectureAnnotation } from "../../lib/lectureApi";

type Tab = "notes" | "annotations";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] } as const;

function paragraphsFromText(text: string) {
	const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
	const content =
		paras.length > 0
			? paras.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }))
			: [{ type: "paragraph" }];
	return { type: "doc", content };
}

export interface LecturePanelProps {
	open: boolean;
	onClose(): void;
	currentPage: number; // 0-based
	pageCount: number;

	notes: LectureNote[];
	notesLoading: boolean;
	onCreateNote(input: { page: number | null; content_json: any }): Promise<unknown>;
	onUpdateNote(id: string, patch: { content_json?: any }): Promise<void> | void;
	onRemoveNote(id: string): Promise<void> | void;

	annotations: LectureAnnotation[];
	onJumpToAnnotation(page: number): void;
	onDeleteAnnotation(id: string, page: number): void;

	/** A 複製到筆記 request from the selection popup; opens a prefilled new note. */
	pendingNote: { text: string; page: number } | null;
	onConsumePending(): void;
}

export function LecturePanel(props: LecturePanelProps) {
	const [tab, setTab] = useState<Tab>("notes");

	return (
		<>
			{/* Mobile scrim */}
			{props.open && (
				<div
					className="fixed inset-0 z-30 bg-black/30 md:hidden"
					onClick={props.onClose}
					aria-hidden="true"
				/>
			)}
			<aside
				className={
					"z-30 flex flex-col border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-800 " +
					// Desktop: in-flow right column that collapses to width 0 when closed.
					"md:relative md:h-full md:border-l md:transition-[width] " +
					(props.open ? "md:w-80 lg:w-96" : "md:w-0 md:overflow-hidden md:border-l-0") +
					// Mobile: bottom sheet.
					" fixed inset-x-0 bottom-0 max-h-[70vh] rounded-t-2xl border-t shadow-paper transition-transform md:inset-auto md:max-h-none md:rounded-none md:border-t-0 md:shadow-none " +
					(props.open ? "translate-y-0" : "translate-y-full md:translate-y-0")
				}
			>
				{/* Header / tabs */}
				<div className="flex items-center justify-between border-b border-ink-200 px-3 dark:border-ink-700">
					<div className="flex">
						<TabBtn active={tab === "notes"} onClick={() => setTab("notes")}>
							筆記
							{props.notes.length > 0 && (
								<Count n={props.notes.length} />
							)}
						</TabBtn>
						<TabBtn
							active={tab === "annotations"}
							onClick={() => setTab("annotations")}
						>
							標註
							{props.annotations.length > 0 && (
								<Count n={props.annotations.length} />
							)}
						</TabBtn>
					</div>
					<button
						type="button"
						onClick={props.onClose}
						aria-label="關閉面板"
						className="text-ink-400 hover:text-ink-700 dark:text-ink-500 dark:hover:text-ink-200"
					>
						<XIcon size={18} />
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-auto">
					{tab === "notes" ? (
						<NotesTab {...props} />
					) : (
						<AnnotationsTab {...props} />
					)}
				</div>
			</aside>
		</>
	);
}

// ── 筆記 ────────────────────────────────────────────────────────────────

function NotesTab(props: LecturePanelProps) {
	const { notes, currentPage } = props;
	const [filter, setFilter] = useState<"all" | "page">("all");
	// New-note composer state.
	const [composing, setComposing] = useState(false);
	const [draft, setDraft] = useState<any>(EMPTY_DOC);
	const [draftPage, setDraftPage] = useState<number | null>(currentPage);
	const [saving, setSaving] = useState(false);
	// Edit-existing state.
	const [editId, setEditId] = useState<string | null>(null);
	const [editDraft, setEditDraft] = useState<any>(EMPTY_DOC);

	// Handle a 複製到筆記 request: open the composer prefilled.
	useEffect(() => {
		if (!props.pendingNote) return;
		setEditId(null);
		setDraft(paragraphsFromText(props.pendingNote.text));
		setDraftPage(props.pendingNote.page);
		setComposing(true);
		props.onConsumePending();
	}, [props.pendingNote]);

	const filtered = useMemo(() => {
		if (filter === "all") return notes;
		return notes.filter((n) => n.page === currentPage);
	}, [notes, filter, currentPage]);

	async function saveNew() {
		if (saving) return;
		setSaving(true);
		try {
			await props.onCreateNote({ page: draftPage, content_json: draft });
			setComposing(false);
			setDraft(EMPTY_DOC);
		} finally {
			setSaving(false);
		}
	}

	async function saveEdit(id: string) {
		await props.onUpdateNote(id, { content_json: editDraft });
		setEditId(null);
	}

	return (
		<div className="p-3">
			{/* Filter + add */}
			<div className="mb-3 flex items-center justify-between gap-2">
				<div className="inline-flex rounded border border-ink-200 text-xs dark:border-ink-700">
					<FilterBtn active={filter === "all"} onClick={() => setFilter("all")}>
						全部
					</FilterBtn>
					<FilterBtn active={filter === "page"} onClick={() => setFilter("page")}>
						本頁 p.{currentPage + 1}
					</FilterBtn>
				</div>
				{!composing && (
					<button
						type="button"
						onClick={() => {
							setEditId(null);
							setDraft(EMPTY_DOC);
							setDraftPage(currentPage);
							setComposing(true);
						}}
						className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-accent hover:bg-accent/10"
					>
						<Plus size={13} /> 新增筆記
					</button>
				)}
			</div>

			{/* Composer */}
			{composing && (
				<div className="mb-4 rounded-lg border-2 border-accent/40 bg-white p-2 dark:bg-ink-800">
					<div className="mb-2 flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400">
						<label className="inline-flex items-center gap-1">
							<MapPin size={12} />
							<select
								value={draftPage === null ? "all" : String(draftPage)}
								onChange={(e) =>
									setDraftPage(
										e.target.value === "all" ? null : Number(e.target.value),
									)
								}
								className="rounded border border-ink-200 bg-white px-1 py-0.5 dark:border-ink-700 dark:bg-ink-900"
							>
								<option value={String(currentPage)}>本頁 p.{currentPage + 1}</option>
								<option value="all">整份講義</option>
							</select>
						</label>
					</div>
					<RichEditor
						content={draft}
						onChange={setDraft}
						placeholder="可輸入 @114-001 連結到題目"
						autofocus
					/>
					<div className="mt-2 flex justify-end gap-2">
						<button
							type="button"
							onClick={() => setComposing(false)}
							disabled={saving}
							className="px-3 py-1 text-sm text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100"
						>
							取消
						</button>
						<button
							type="button"
							onClick={saveNew}
							disabled={saving}
							className="rounded bg-accent px-4 py-1 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-40"
						>
							{saving ? "儲存中…" : "儲存"}
						</button>
					</div>
				</div>
			)}

			{/* List */}
			{props.notesLoading ? (
				<p className="py-6 text-center text-sm text-ink-400 dark:text-ink-500">
					載入筆記中…
				</p>
			) : filtered.length === 0 ? (
				<p className="py-6 text-center text-sm text-ink-400 dark:text-ink-500">
					{filter === "page" ? "本頁尚無筆記。" : "尚無筆記。"}
				</p>
			) : (
				<ul className="space-y-3">
					{filtered.map((n) => (
						<li
							key={n.id}
							className="rounded-lg border border-ink-200 bg-white p-3 dark:border-ink-700 dark:bg-ink-800"
						>
							<div className="mb-1.5 flex items-center justify-between">
								<span className="inline-flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600 dark:bg-ink-700 dark:text-ink-300">
									{n.page === null ? "整份" : `📄 p.${n.page + 1}`}
								</span>
								{editId !== n.id && (
									<div className="flex items-center gap-1">
										<IconAction
											label="編輯"
											onClick={() => {
												setComposing(false);
												setEditId(n.id);
												setEditDraft(n.content_json || EMPTY_DOC);
											}}
										>
											<Pencil size={13} />
										</IconAction>
										<IconAction
											label="刪除"
											onClick={() => props.onRemoveNote(n.id)}
										>
											<Trash2 size={13} />
										</IconAction>
									</div>
								)}
							</div>
							{editId === n.id ? (
								<>
									<RichEditor
										content={editDraft}
										onChange={setEditDraft}
										placeholder="可輸入 @114-001 連結到題目"
										autofocus
									/>
									<div className="mt-2 flex justify-end gap-2">
										<button
											type="button"
											onClick={() => setEditId(null)}
											className="px-3 py-1 text-sm text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100"
										>
											取消
										</button>
										<button
											type="button"
											onClick={() => saveEdit(n.id)}
											className="rounded bg-accent px-4 py-1 text-sm font-medium text-white hover:bg-accent-dark"
										>
											儲存
										</button>
									</div>
								</>
							) : (
								<div className="lecture-note-readonly text-sm">
									<RichEditor content={n.content_json || EMPTY_DOC} editable={false} />
								</div>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

// ── 標註 ────────────────────────────────────────────────────────────────

function AnnotationsTab(props: LecturePanelProps) {
	const highlights = props.annotations.filter((a) => a.kind === "highlight");
	return (
		<div className="p-3">
			{highlights.length === 0 ? (
				<p className="py-6 text-center text-sm text-ink-400 dark:text-ink-500">
					尚無螢光標記。選取講義文字即可標記。
				</p>
			) : (
				<ul className="space-y-2">
					{highlights.map((a) => {
						const snippet = annotationSnippet(a);
						return (
							<li
								key={a.id}
								className="group flex items-start gap-2 rounded-lg border border-ink-200 bg-white p-2.5 transition hover:border-accent dark:border-ink-700 dark:bg-ink-800"
							>
								<button
									type="button"
									onClick={() => props.onJumpToAnnotation(a.page)}
									className="flex min-w-0 flex-1 items-start gap-2 text-left"
									title="跳到此頁"
								>
									<span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
										p.{a.page + 1}
									</span>
									<span className="line-clamp-2 min-w-0 flex-1 text-sm text-ink-700 dark:text-ink-200">
										{snippet || "(螢光標記)"}
									</span>
								</button>
								<IconAction
									label="刪除標註"
									onClick={() => props.onDeleteAnnotation(a.id, a.page)}
								>
									<Trash2 size={13} />
								</IconAction>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

// Best-effort snippet: highlight payloads may carry a `contents` string on the
// annotation. Tolerate stringified payloads defensively.
function annotationSnippet(a: LectureAnnotation): string {
	let payload = a.payload_json;
	if (typeof payload === "string") {
		try {
			payload = JSON.parse(payload);
		} catch {
			return "";
		}
	}
	const anno = payload?.annotation ?? payload;
	const text = anno?.contents;
	return typeof text === "string" ? text.trim() : "";
}

// ── bits ────────────────────────────────────────────────────────────────

function TabBtn({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick(): void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={
				"-mb-px border-b-2 px-4 py-2.5 font-serif text-base transition " +
				(active
					? "border-accent text-ink-900 dark:text-ink-100"
					: "border-transparent text-ink-500 hover:text-ink-700 dark:hover:text-ink-300")
			}
		>
			{children}
		</button>
	);
}

function Count({ n }: { n: number }) {
	return (
		<span className="ml-1.5 rounded-full bg-ink-100 px-1.5 text-[11px] text-ink-500 dark:bg-ink-700 dark:text-ink-400">
			{n}
		</span>
	);
}

function FilterBtn({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick(): void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={
				"px-2 py-1 transition first:rounded-l last:rounded-r " +
				(active
					? "bg-accent/15 text-accent"
					: "text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-700")
			}
		>
			{children}
		</button>
	);
}

function IconAction({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick(): void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-400 transition hover:bg-ink-100 hover:text-accent dark:text-ink-500 dark:hover:bg-ink-700"
		>
			{children}
		</button>
	);
}
