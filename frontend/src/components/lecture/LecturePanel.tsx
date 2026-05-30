// Right-hand reader panel (desktop) / bottom-sheet (mobile <md). Two tabs:
//   筆記  — page-anchored notebook (RichEditor, supports @114-001 question refs)
//   標註  — highlight list; click a row to jump, delete to remove
//
// Notes/annotations are per-user, so every row here is editable/deletable.
import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, X as XIcon } from "lucide-react";
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
	/** Desktop panel width in px (applied at md+). Ignored on mobile sheet. */
	width: number;
	currentPage: number; // 0-based
	pageCount: number;

	notesLoading: boolean;
	/** The single note for a page, if any. */
	noteForPage(page: number): LectureNote | undefined;
	/** Upsert the one note for `page`. */
	onSavePageNote(page: number, content_json: any): void | Promise<void>;

	annotations: LectureAnnotation[];
	onJumpToAnnotation(page: number): void;
	onDeleteAnnotation(id: string, page: number): void;

	/** A 複製到筆記 request from the selection popup; appended to the current page note. */
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
				style={{ width: props.open ? props.width : 0 }}
				className={
					"z-30 flex flex-col border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-800 " +
					// Desktop: in-flow right column; width is driven by inline style so
					// drag-resize stays smooth (no width transition). On mobile the inline
					// width is neutralised (!w-auto) so the bottom sheet stays full-width.
					"max-md:!w-auto md:relative md:h-full md:border-l " +
					(props.open ? "" : "md:overflow-hidden md:border-l-0") +
					// Mobile: bottom sheet (inline width is overridden by inset-x-0 below).
					" fixed inset-x-0 bottom-0 max-h-[70vh] rounded-t-2xl border-t shadow-paper transition-transform md:inset-auto md:bottom-auto md:max-h-none md:rounded-none md:border-t-0 md:shadow-none " +
					(props.open ? "translate-y-0" : "translate-y-full md:translate-y-0")
				}
			>
				{/* Header / tabs */}
				<div className="flex items-center justify-between border-b border-ink-200 px-3 dark:border-ink-700">
					<div className="flex">
						<TabBtn active={tab === "notes"} onClick={() => setTab("notes")}>
							筆記
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

// Exactly one note per page, always editable inline. Switching pages remounts
// the editor (key={currentPage}) so its content resets cleanly to the new
// page's note without tripping RichEditor's focused-sync edge cases.
function NotesTab(props: LecturePanelProps) {
	const { currentPage } = props;
	return (
		<div className="p-3">
			<PageNoteEditor
				key={currentPage}
				currentPage={currentPage}
				loaded={props.noteForPage(currentPage)}
				notesLoading={props.notesLoading}
				onSave={props.onSavePageNote}
				pendingNote={props.pendingNote}
				onConsumePending={props.onConsumePending}
			/>
		</div>
	);
}

type SaveStatus = "idle" | "saving" | "saved";

function PageNoteEditor({
	currentPage,
	loaded,
	notesLoading,
	onSave,
	pendingNote,
	onConsumePending,
}: {
	currentPage: number;
	loaded: LectureNote | undefined;
	notesLoading: boolean;
	onSave(page: number, content_json: any): void | Promise<void>;
	pendingNote: { text: string; page: number } | null;
	onConsumePending(): void;
}) {
	const loadedDoc = loaded?.content_json ?? EMPTY_DOC;
	const [draft, setDraft] = useState<any>(loadedDoc);
	const [status, setStatus] = useState<SaveStatus>("idle");
	// The last doc we know is persisted (server or loaded), to skip no-op saves.
	const savedRef = useRef<string>(JSON.stringify(loadedDoc));
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const savedFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const persist = useCallback(
		async (doc: any) => {
			const serialized = JSON.stringify(doc);
			if (serialized === savedRef.current) return; // no-op / untouched
			savedRef.current = serialized;
			setStatus("saving");
			try {
				await onSave(currentPage, doc);
				setStatus("saved");
				if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
				savedFadeRef.current = setTimeout(() => setStatus("idle"), 1500);
			} catch {
				// hook surfaces the error; allow a retry by clearing the cached state
				savedRef.current = "";
				setStatus("idle");
			}
		},
		[currentPage, onSave],
	);

	// Debounced autosave on edits.
	const onChange = useCallback((doc: any) => {
		setDraft(doc);
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			void persist(doc);
		}, 800);
	}, [persist]);

	// Save immediately on blur (flush any pending debounce).
	const onBlur = useCallback(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		void persist(draft);
	}, [draft, persist]);

	// 複製到筆記: append the copied text to the current page's note, then save.
	// The popup copies from the page the reader is on, so we always append to
	// the current draft regardless of pendingNote.page.
	useEffect(() => {
		if (!pendingNote) return;
		const appended = paragraphsFromText(pendingNote.text).content;
		const base = Array.isArray(draft?.content) ? draft.content : [];
		const nextDoc = { type: "doc", content: [...base, ...appended] };
		setDraft(nextDoc);
		void persist(nextDoc);
		onConsumePending();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingNote]);

	// Cleanup timers on unmount.
	useEffect(() => {
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
			if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
		};
	}, []);

	if (notesLoading && !loaded) {
		return (
			<p className="py-6 text-center text-sm text-ink-400 dark:text-ink-500">
				載入中…
			</p>
		);
	}

	return (
		<div>
			<div className="mb-2 flex items-center justify-between">
				<span className="inline-flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600 dark:bg-ink-700 dark:text-ink-300">
					📄 p.{currentPage + 1} 筆記
				</span>
				<span
					className={
						"text-[11px] text-ink-400 transition-opacity duration-500 dark:text-ink-500 " +
						(status === "idle" ? "opacity-0" : "opacity-100")
					}
				>
					{status === "saving" ? "儲存中…" : status === "saved" ? "已儲存" : ""}
				</span>
			</div>
			<div onBlur={onBlur}>
				<RichEditor
					content={draft}
					onChange={onChange}
					placeholder="直接輸入本頁筆記，可用 @114-001 連結題目"
					autofocus={false}
				/>
			</div>
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
