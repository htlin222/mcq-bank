// Right-hand reader panel (desktop) / bottom-sheet (mobile <md). Three tabs:
//   筆記    — page-anchored notebook (RichEditor, supports @114-001 question refs)
//   標註    — highlight list; click a row to jump, delete to remove
//   歷屆考題 — MCQs the offline pipeline linked to the current page (read-only)
//
// Notes/annotations are per-user, so every row here is editable/deletable.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Check, ExternalLink, SquarePen, Trash2, X as XIcon } from "lucide-react";
import { RichEditor } from "../RichEditor";
import { NotesSkeleton } from "../Skeleton";
import {
	buildOpenEvidenceUrlForNote,
	NOTE_OE_PROMPT,
	tiptapDocToText,
} from "../../lib/openevidence";
import { groupBadgeClass } from "../../lib/groups";
import { listPageQuestions } from "../../lib/lectureApi";
import type {
	LectureNote,
	LectureAnnotation,
	LecturePageQuestion,
} from "../../lib/lectureApi";

type Tab = "notes" | "annotations" | "questions";

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
	slug: string;
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

	// 1-based PDF page, aligned with lecture_pages / lecture_notes convention
	// (see NotesTab below). Loaded here (not inside QuestionsTab) so the tab
	// strip's count badge can show it without a second fetch, and reloaded
	// whenever the reader flips to a new page.
	const pdfPage = props.currentPage + 1;
	const [pageQuestions, setPageQuestions] = useState<LecturePageQuestion[] | null>(null);
	useEffect(() => {
		let cancelled = false;
		setPageQuestions(null);
		listPageQuestions(props.slug, pdfPage)
			.then((r) => {
				if (!cancelled) setPageQuestions(r);
			})
			.catch(() => {
				if (!cancelled) setPageQuestions([]);
			});
		return () => {
			cancelled = true;
		};
	}, [props.slug, pdfPage]);

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
						<TabBtn
							active={tab === "questions"}
							onClick={() => setTab("questions")}
						>
							歷屆考題
							{pageQuestions && pageQuestions.length > 0 && (
								<Count n={pageQuestions.length} />
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
					) : tab === "annotations" ? (
						<AnnotationsTab {...props} />
					) : (
						<QuestionsTab pdfPage={pdfPage} items={pageQuestions} />
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
	// currentPage is the viewer's 0-based page index. lecture_notes /
	// lecture_default_notes / lecture_pages are all stored as 1-based PDF page
	// numbers (per the seed-script filenames page_001_note.md, page_002_note.md…
	// and pdfjs's 1-based page numbering). Translate at the API boundary so the
	// note for PDF page 1 lines up with currentPage = 0.
	const pdfPage = currentPage + 1;
	return (
		<div className="p-3">
			<PageNoteEditor
				key={pdfPage}
				pdfPage={pdfPage}
				loaded={props.noteForPage(pdfPage)}
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
	pdfPage,
	loaded,
	notesLoading,
	onSave,
	pendingNote,
	onConsumePending,
}: {
	/** 1-based PDF page number — already translated from the viewer's 0-based currentPage. */
	pdfPage: number;
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
				await onSave(pdfPage, doc);
				setStatus("saved");
				if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
				savedFadeRef.current = setTimeout(() => setStatus("idle"), 1500);
			} catch {
				// hook surfaces the error; allow a retry by clearing the cached state
				savedRef.current = "";
				setStatus("idle");
			}
		},
		[pdfPage, onSave],
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

	// Hand the current note text to OpenEvidence, prefixed with the teaching
	// prompt. Uses the live draft so unsaved edits are included.
	const noteText = tiptapDocToText(draft);
	const [promptOpen, setPromptOpen] = useState(false);
	const sendToOpenEvidence = useCallback(
		(prompt: string) => {
			const text = tiptapDocToText(draft);
			if (!text.trim()) return;
			window.open(
				buildOpenEvidenceUrlForNote(text, prompt),
				"_blank",
				"noopener",
			);
		},
		[draft],
	);
	const openInOpenEvidence = useCallback(() => {
		sendToOpenEvidence(NOTE_OE_PROMPT);
	}, [sendToOpenEvidence]);

	if (notesLoading && !loaded) {
		return <NotesSkeleton />;
	}

	return (
		<div>
			<div className="mb-2 flex items-center justify-between gap-2">
				<span className="inline-flex shrink-0 items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600 dark:bg-ink-700 dark:text-ink-300">
					📄 p.{pdfPage} 筆記
				</span>
				<div className="flex min-w-0 items-center gap-2">
					<span
						className={
							"text-[11px] text-ink-400 transition-opacity duration-500 dark:text-ink-500 " +
							(status === "idle" ? "opacity-0" : "opacity-100")
						}
					>
						{status === "saving" ? "儲存中…" : status === "saved" ? "已儲存" : ""}
					</span>
					<div className="inline-flex shrink-0 items-center rounded border border-ink-200 dark:border-ink-700">
						<button
							type="button"
							onClick={openInOpenEvidence}
							disabled={!noteText.trim()}
							title="用 OpenEvidence 解析本頁筆記"
							className="inline-flex items-center gap-1 rounded-l px-2 py-1 text-[11px] text-ink-600 transition hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 dark:text-ink-300"
						>
							<ExternalLink size={12} />
							OpenEvidence
						</button>
						<button
							type="button"
							onClick={() => setPromptOpen(true)}
							disabled={!noteText.trim()}
							title="調整 prompt 後再送出"
							aria-label="調整 prompt 後再送出"
							className="inline-flex items-center border-l border-ink-200 px-1.5 py-1 text-ink-500 transition hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:text-ink-400"
						>
							<SquarePen size={12} />
						</button>
					</div>
				</div>
			</div>
			{promptOpen && (
				<PromptDialog
					onClose={() => setPromptOpen(false)}
					onSend={(prompt) => {
						sendToOpenEvidence(prompt);
						setPromptOpen(false);
					}}
				/>
			)}
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

// Edit-prompt popup for the OpenEvidence hand-off. Pre-fills the default
// teaching prompt; the note body is appended by the caller on send.
function PromptDialog(props: {
	onClose(): void;
	onSend(prompt: string): void;
}) {
	const [prompt, setPrompt] = useState(NOTE_OE_PROMPT);
	const taRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		taRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") props.onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) props.onClose();
			}}
		>
			<div className="flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-ink-200 bg-white shadow-paper dark:border-ink-700 dark:bg-ink-800">
				<header className="flex shrink-0 items-center justify-between border-b border-ink-100 px-5 py-3 dark:border-ink-700">
					<h2 className="inline-flex items-center gap-2 font-serif text-lg text-ink-900 dark:text-ink-100">
						<SquarePen size={18} className="text-accent" />
						調整 OpenEvidence prompt
					</h2>
					<button
						onClick={props.onClose}
						className="text-ink-400 hover:text-ink-600 dark:text-ink-500 dark:hover:text-ink-300"
						aria-label="關閉"
					>
						<XIcon size={18} />
					</button>
				</header>
				<div className="space-y-3 p-5">
					<p className="text-xs text-ink-500 dark:text-ink-400">
						送出時會把這段 prompt 放在最前面,後面接本頁筆記內容,於新分頁開啟
						OpenEvidence。
					</p>
					<textarea
						ref={taRef}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						rows={5}
						className="w-full resize-y rounded border border-ink-200 px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-accent focus:outline-none dark:border-ink-600 dark:bg-ink-900 dark:text-ink-100 dark:placeholder:text-ink-500"
						placeholder="輸入要交給 OpenEvidence 的指示…"
					/>
					<div className="flex items-center justify-between gap-2">
						<button
							type="button"
							onClick={() => setPrompt(NOTE_OE_PROMPT)}
							className="text-xs text-ink-500 hover:text-accent dark:text-ink-400"
						>
							還原預設
						</button>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={props.onClose}
								className="px-3 py-1.5 text-sm text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100"
							>
								取消
							</button>
							<button
								type="button"
								onClick={() => props.onSend(prompt)}
								disabled={!prompt.trim()}
								className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-sm text-white transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
							>
								<ExternalLink size={14} />
								送出
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>,
		document.body,
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

// ── 歷屆考題 ────────────────────────────────────────────────────────────

// Read-only — no per-user CRUD like notes/annotations. Cards for the current
// page (already fetched by the parent, ranked by lpq.rank); clicking one
// opens a preview dialog with the answer withheld until "顯示答案".
function QuestionsTab({
	pdfPage,
	items,
}: {
	pdfPage: number;
	items: LecturePageQuestion[] | null;
}) {
	const [previewId, setPreviewId] = useState<string | null>(null);

	if (items === null) {
		return (
			<div className="p-3 text-sm text-ink-400 dark:text-ink-500">載入中…</div>
		);
	}

	if (items.length === 0) {
		return (
			<p className="py-6 text-center text-sm text-ink-400 dark:text-ink-500">
				這張投影片沒有對應的歷屆考題。
			</p>
		);
	}

	const previewItem = items.find((q) => q.id === previewId) ?? null;

	return (
		<div className="p-3 space-y-2">
			<div className="mb-1 text-[11px] text-ink-400 dark:text-ink-500">
				p.{pdfPage} 對應的歷屆考題
			</div>
			{items.map((q) => (
				<QuestionCardMini key={q.id} q={q} onClick={() => setPreviewId(q.id)} />
			))}
			{previewItem && (
				<QuestionPreviewDialog q={previewItem} onClose={() => setPreviewId(null)} />
			)}
		</div>
	);
}

function QuestionCardMini({
	q,
	onClick,
}: {
	q: LecturePageQuestion;
	onClick(): void;
}) {
	const excerpt = q.stem.length > 60 ? q.stem.slice(0, 60) + "…" : q.stem;
	const tags = (q.tags ?? "").split(" ").map((t) => t.trim()).filter(Boolean);

	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full rounded-lg border border-ink-200 bg-white p-2.5 text-left transition hover:border-accent dark:border-ink-700 dark:bg-ink-800"
		>
			<div className="mb-1 flex flex-wrap items-center gap-1.5">
				<span className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-mono text-ink-600 dark:bg-ink-700 dark:text-ink-300">
					{q.id}
				</span>
				{q.group && (
					<span
						className={
							"inline-block rounded px-1.5 py-0.5 text-[11px] " +
							groupBadgeClass(q.group)
						}
					>
						{q.group}
					</span>
				)}
			</div>
			<p className="line-clamp-2 text-sm text-ink-700 dark:text-ink-200">{excerpt}</p>
			{tags.length > 0 && (
				<div className="mt-1 flex flex-wrap gap-1">
					{tags.slice(0, 4).map((t) => (
						<span
							key={t}
							className="inline-block rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-500 dark:bg-ink-700 dark:text-ink-400"
						>
							#{t}
						</span>
					))}
				</div>
			)}
		</button>
	);
}

// Full stem + options; answer withheld until "顯示答案" so the panel doubles
// as a quick self-check, not just a lookup. Primary action hands off to the
// full single-question route for the collaborative 詳解 / discussion.
function QuestionPreviewDialog({
	q,
	onClose,
}: {
	q: LecturePageQuestion;
	onClose(): void;
}) {
	const navigate = useNavigate();
	const [revealed, setRevealed] = useState(false);

	let options: { key: string; text: string }[] = [];
	try {
		const parsed = JSON.parse(q.options_json);
		if (Array.isArray(parsed)) options = parsed;
	} catch {
		options = [];
	}
	const tags = (q.tags ?? "").split(" ").map((t) => t.trim()).filter(Boolean);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-ink-200 bg-white shadow-paper dark:border-ink-700 dark:bg-ink-800">
				<header className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-100 px-5 py-3 dark:border-ink-700">
					<div className="flex items-center gap-2">
						<span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs text-ink-600 dark:bg-ink-700 dark:text-ink-300">
							{q.id}
						</span>
						{q.group && (
							<span
								className={
									"inline-block rounded px-2 py-0.5 text-xs " +
									groupBadgeClass(q.group)
								}
							>
								{q.group}
							</span>
						)}
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="關閉"
						className="text-ink-400 hover:text-ink-600 dark:text-ink-500 dark:hover:text-ink-300"
					>
						<XIcon size={18} />
					</button>
				</header>

				<div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
					<p className="whitespace-pre-wrap font-serif text-base leading-relaxed text-ink-900 dark:text-ink-100">
						{q.stem}
					</p>
					<ul className="space-y-2">
						{options.map((o) => {
							const isCorrect = o.key === q.answer;
							return (
								<li
									key={o.key}
									className={
										"flex items-start gap-3 rounded border p-2.5 text-sm transition " +
										(revealed && isCorrect
											? "border-emerald-500 bg-emerald-50 dark:bg-emerald-500/15"
											: "border-ink-200 dark:border-ink-700")
									}
								>
									<span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current text-xs font-semibold">
										{o.key}
									</span>
									<span className="leading-relaxed text-ink-800 dark:text-ink-200">
										{o.text}
									</span>
									{revealed && isCorrect && (
										<span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-700">
											<Check size={14} /> 正解
										</span>
									)}
								</li>
							);
						})}
					</ul>
					{tags.length > 0 && (
						<div className="flex flex-wrap gap-1">
							{tags.map((t) => (
								<span
									key={t}
									className="inline-block rounded bg-ink-100 px-2 py-0.5 text-[11px] text-ink-700 dark:bg-ink-700 dark:text-ink-200"
								>
									#{t}
								</span>
							))}
						</div>
					)}
				</div>

				<footer className="flex shrink-0 items-center justify-between gap-2 border-t border-ink-100 px-5 py-3 dark:border-ink-700">
					{!revealed ? (
						<button
							type="button"
							onClick={() => setRevealed(true)}
							className="text-sm text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-200"
						>
							顯示答案
						</button>
					) : (
						<span className="text-sm text-ink-500 dark:text-ink-400">
							正解 {q.answer}
						</span>
					)}
					<button
						type="button"
						onClick={() => navigate("/q/" + q.id)}
						className="rounded bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-dark"
					>
						去複習
					</button>
				</footer>
			</div>
		</div>,
		document.body,
	);
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
