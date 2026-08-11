import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	GripVertical,
	Plus,
	StickyNote,
	Trash2,
} from "lucide-react";
import { dropIndex, moveItem, sameOrder } from "../lib/reorder";
import { NOTE_TITLE_NARROW, noteTitleFromJson } from "../lib/noteTitle";
import { useNarrow } from "../hooks/useNarrow";

// 個人筆記的切換器 —— 一題可以有多則(見 migration 0036)。
//
// 名字就是內文第一行(noteTitle),所以這裡沒有「重新命名」:要改名就去改
// 那一行字。少一個欄位、少一個會和內文對不起來的狀態。

export type NoteMeta = {
	slot: number;
	content_json: string;
	created_at: number;
	updated_at: number;
};

/** 下拉左右兩側的跳頁鈕。title 帶上目標筆記的名字,不必開選單就知道會去哪。 */
function StepButton({
	dir,
	target,
	busy,
	onClick,
}: {
	dir: "prev" | "next";
	target: NoteMeta;
	busy?: boolean;
	onClick: () => void;
}) {
	const label = dir === "prev" ? "上一則筆記" : "下一則筆記";
	const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={busy}
			aria-label={label}
			title={`${label}:${noteTitleFromJson(target.content_json)}`}
			className="shrink-0 rounded p-1 text-ink-400 dark:text-ink-500 hover:bg-ink-100 hover:text-accent dark:hover:bg-ink-700 transition disabled:opacity-50"
		>
			<Icon size={15} />
		</button>
	);
}

export function NoteSwitcher({
	notes,
	activeSlot,
	busy,
	onSelect,
	onCreate,
	onDelete,
	onReorder,
}: {
	notes: NoteMeta[];
	activeSlot: number;
	busy?: boolean;
	onSelect: (slot: number) => void;
	onCreate: () => void;
	onDelete: (slot: number) => void;
	/** 拖曳放開時給出新的 slot 順序。沒給就不顯示握把。 */
	onReorder?: (slots: number[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	// 窄螢幕把預覽字數縮到 10 字(#137)。CSS `truncate` 不會讓它溢出,但 40 個中文字
	// 會把整列吃光,底下那行日期就看不出層次 —— 這是「產生字串時」的決定,構不到
	// 的東西才來這裡拿布林值(見 useNarrow)。
	const narrow = useNarrow();
	const listRef = useRef<HTMLUListElement>(null);
	// 拖曳中的樂觀順序。`null` = 沒在拖。
	// 存在這裡而不是交給呼叫端:放開之前不該打任何請求,而畫面必須即時跟著手指走。
	const [dragging, setDragging] = useState<{ slot: number; order: number[] } | null>(null);
	const titleOf = (n: NoteMeta) =>
		noteTitleFromJson(n.content_json, undefined, narrow ? NOTE_TITLE_NARROW : undefined);

	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// 畫面上的順序:拖曳中用樂觀順序,否則就是伺服器給的順序。
	const shown = dragging
		? dragging.order
				.map((slot) => notes.find((n) => n.slot === slot))
				.filter((n): n is NoteMeta => !!n)
		: notes;

	/**
	 * 握把上的指標事件。用 pointer 而不是 HTML5 drag-and-drop:後者在觸控裝置上
	 * 根本不會觸發,而這個下拉最擠的時候正是手機(#137)。
	 *
	 * `setPointerCapture` 讓後續事件都送到握把上 —— 少了它,指標移出那一列之後
	 * 就收不到 move,拖到一半會卡住。
	 */
	function startDrag(e: ReactPointerEvent, slot: number) {
		if (!onReorder || notes.length < 2) return;
		e.preventDefault();
		e.stopPropagation();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const order = notes.map((n) => n.slot);
		setDragging({ slot, order });
	}

	function moveDrag(e: ReactPointerEvent) {
		if (!dragging) return;
		const list = listRef.current;
		if (!list) return;
		// 每次都重新量:拖曳中列的順序在變,快取住的中線會指向舊位置。
		const mids = [...list.querySelectorAll("li")].map((li) => {
			const r = li.getBoundingClientRect();
			return r.top + r.height / 2;
		});
		const from = dragging.order.indexOf(dragging.slot);
		const to = dropIndex(mids, e.clientY, from);
		if (to === from) return;
		setDragging({ slot: dragging.slot, order: moveItem(dragging.order, from, to) });
	}

	function endDrag() {
		if (!dragging) return;
		const next = dragging.order;
		setDragging(null);
		// 放回原位不送請求 —— 那只是一次沒改變任何東西的往返。
		if (!sameOrder(next, notes.map((n) => n.slot))) onReorder?.(next);
	}

	const active = notes.find((n) => n.slot === activeSlot) ?? notes[0];
	const at = active ? notes.findIndex((n) => n.slot === active.slot) : -1;
	const idx = at + 1;
	// 左右鍵直接跳上/下一則,省掉「開選單 → 找 → 點」。到頭了就整顆不出現
	// (而不是變灰):兩三則筆記的情境下,一顆永遠按不動的按鈕只是佔位子。
	const prev = at > 0 ? notes[at - 1] : null;
	const next = at >= 0 && at < notes.length - 1 ? notes[at + 1] : null;

	return (
		<div ref={rootRef} className="relative flex min-w-0 items-center">
			{prev && (
				<StepButton
					dir="prev"
					target={prev}
					busy={busy}
					onClick={() => onSelect(prev.slot)}
				/>
			)}
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				disabled={busy}
				aria-haspopup="menu"
				aria-expanded={open}
				title="切換這一題的筆記"
				className="inline-flex max-w-full items-center gap-1.5 rounded px-2 py-1 text-sm text-ink-700 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-700 transition disabled:opacity-50"
			>
				<StickyNote size={14} className="shrink-0 text-ink-400 dark:text-ink-500" />
				<span className="truncate">
					{active ? noteTitleFromJson(active.content_json) : "尚無筆記"}
				</span>
				{notes.length > 1 && (
					<span className="shrink-0 text-xs tabular-nums text-ink-400 dark:text-ink-500">
						{idx}/{notes.length}
					</span>
				)}
				<ChevronDown size={14} className="shrink-0 text-ink-400 dark:text-ink-500" />
			</button>
			{next && (
				<StepButton
					dir="next"
					target={next}
					busy={busy}
					onClick={() => onSelect(next.slot)}
				/>
			)}

			{open && (
				<div
					role="menu"
					className="absolute left-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-xl"
				>
					<ul ref={listRef} className="max-h-72 overflow-y-auto py-1">
							{shown.map((n) => (
								<li
									key={n.slot}
									className={
										"group flex items-stretch " +
										(dragging?.slot === n.slot
											? "bg-ink-100 dark:bg-ink-700 opacity-90"
											: "")
									}
								>
									{/* 握把。只有兩則以上才出現 —— 一則的時候它只是個拖不動的裝飾。
									    `touch-action: none` 是必要的:少了它,手指在握把上往下滑會被
									    瀏覽器判定成捲動清單,拖曳收不到 move 事件。 */}
									{onReorder && notes.length > 1 && (
										<span
											role="button"
											tabIndex={-1}
											aria-label={`拖曳排序:${titleOf(n)}`}
											title="拖曳調整順序"
											onPointerDown={(e) => startDrag(e, n.slot)}
											onPointerMove={moveDrag}
											onPointerUp={endDrag}
											onPointerCancel={endDrag}
											className="flex shrink-0 cursor-grab touch-none items-center pl-2 text-ink-300 hover:text-ink-500 active:cursor-grabbing dark:text-ink-600 dark:hover:text-ink-400"
										>
											<GripVertical size={14} />
										</span>
									)}
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										onSelect(n.slot);
										setOpen(false);
									}}
									className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left hover:bg-ink-50 dark:hover:bg-ink-700/60"
								>
									<Check
										size={14}
										className={
											"mt-0.5 shrink-0 " +
											(n.slot === activeSlot ? "text-accent" : "invisible")
										}
									/>
									<span className="min-w-0">
										<span className="block truncate text-sm text-ink-800 dark:text-ink-100">
											{titleOf(n)}
										</span>
										<span className="block text-xs text-ink-400 dark:text-ink-500">
											{new Date(n.updated_at).toLocaleDateString("zh-TW")}
										</span>
									</span>
								</button>
								{/* 刪除只在該列 hover / focus 時現身 —— 切換筆記是每天做的事,
								    刪除不是,不該和它一樣顯眼。 */}
								<button
									type="button"
									title="刪除這則筆記"
									onClick={() => {
										onDelete(n.slot);
										setOpen(false);
									}}
									className="shrink-0 px-3 text-ink-300 opacity-0 transition hover:text-rose-600 focus:opacity-100 group-hover:opacity-100 dark:text-ink-500"
								>
									<Trash2 size={14} />
								</button>
							</li>
						))}
					</ul>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							onCreate();
							setOpen(false);
						}}
						disabled={busy}
						className="flex w-full items-center gap-2 border-t border-ink-100 dark:border-ink-700 px-3 py-2 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
					>
						<Plus size={14} /> 新增筆記
					</button>
				</div>
			)}
		</div>
	);
}
