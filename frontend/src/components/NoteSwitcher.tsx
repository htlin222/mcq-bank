import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, StickyNote, Trash2 } from "lucide-react";
import { noteTitleFromJson } from "../lib/noteTitle";

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

export function NoteSwitcher({
	notes,
	activeSlot,
	busy,
	onSelect,
	onCreate,
	onDelete,
}: {
	notes: NoteMeta[];
	activeSlot: number;
	busy?: boolean;
	onSelect: (slot: number) => void;
	onCreate: () => void;
	onDelete: (slot: number) => void;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

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

	const active = notes.find((n) => n.slot === activeSlot) ?? notes[0];
	const idx = active ? notes.findIndex((n) => n.slot === active.slot) + 1 : 0;

	return (
		<div ref={rootRef} className="relative min-w-0">
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

			{open && (
				<div
					role="menu"
					className="absolute left-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-xl"
				>
					<ul className="max-h-72 overflow-y-auto py-1">
						{notes.map((n) => (
							<li key={n.slot} className="group flex items-stretch">
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
											{noteTitleFromJson(n.content_json)}
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
