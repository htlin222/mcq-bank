import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleEllipsis } from "lucide-react";

/**
 * 個人筆記卡右上角的「更多」(#137)。
 *
 * 為什麼要有它:那一排本來是 全螢幕 / 自動挖空 / 防劇透 / 編輯 四顆帶文字的按鈕,
 * 390px 上必定折成兩行 —— 而第二行是 `justify-end` 的,所以「編輯」會單獨吊在
 * 右下角,看起來像壞掉。收成一顆之後那一排永遠是一行。
 *
 * 全螢幕**不進來**:它是「怎麼讀這則筆記」裡唯一每天都會按的,而且進了選單就
 * 需要先關選單才看得到放大後的樣子。
 *
 * 這裡不做鍵盤 roving focus —— 選單只有三項,原生的 Tab 就夠用;做了反而要處理
 * 「按鈕停用時跳過」之類的邊界。
 */
export function NoteToolsMenu({ children }: { children: ReactNode }) {
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

	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="更多筆記工具"
				title="更多:自動挖空 / 防劇透 / 編輯"
				className={
					"inline-flex items-center gap-1 rounded px-2 py-1 text-sm transition " +
					(open
						? "bg-ink-100 text-accent dark:bg-ink-700"
						: "text-ink-500 hover:bg-ink-100 hover:text-accent dark:text-ink-400 dark:hover:bg-ink-700")
				}
			>
				<CircleEllipsis size={14} /> 更多
			</button>
			{open && (
				// 靠右展開:這顆在那一排的最右邊,`left-0` 會讓選單溢出卡片右緣。
				<div
					role="menu"
					onClick={() => setOpen(false)}
					className="absolute right-0 top-full z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 py-1 shadow-xl"
				>
					{children}
				</div>
			)}
		</div>
	);
}

/**
 * 選單裡的一列。外觀統一在這裡,呼叫端只給圖示與文字 —— 三顆按鈕的 class
 * 各寫一次的話,遲早有一顆的 padding 會跟另外兩顆不一樣。
 */
export function NoteToolsItem({
	icon,
	label,
	onClick,
	disabled,
	active,
	title,
}: {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	active?: boolean;
	title?: string;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-pressed={active}
			className={
				"flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition disabled:opacity-50 " +
				(active
					? "text-accent bg-accent/10"
					: "text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-ink-700/60")
			}
		>
			<span className="shrink-0">{icon}</span>
			<span className="min-w-0 truncate">{label}</span>
		</button>
	);
}
