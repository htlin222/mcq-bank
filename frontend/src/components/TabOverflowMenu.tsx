import { useRef, useState, type ReactNode } from "react";
import { EllipsisVertical } from "lucide-react";
import { useDismiss } from "../hooks/useDismiss";

/**
 * 分頁列尾端的溢出選單。跟 header 的「更多」是同一個作法(見 CLAUDE.md 的導覽
 * 階梯):塞不下的項目摺進來,而不是折行。
 *
 * 折行為什麼不行:那條 strip 是 sticky 的,而且底下就是內容 —— 折成兩行等於每次
 * 換題都少一行可讀高度,而在 390px 上六個分頁必定折。
 *
 * ⚠️ **目前這一頁一定要留在列上**,即使它屬於被摺起來的那幾個。少了這條,從選單
 * 挑「影片」之後,列上完全看不出自己在哪 —— 六個分頁裡沒有一個是亮的。
 */
export function TabOverflowMenu({
	children,
	count,
}: {
	children: ReactNode;
	/** 摺起來幾項。0 時整顆不出現 —— 一顆點開是空的按鈕比沒有更糟。 */
	count: number;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	useDismiss(open, rootRef, () => setOpen(false));

	if (count === 0) return null;

	return (
		<div ref={rootRef} className="relative flex items-center">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`更多分頁(${count})`}
				title="更多分頁"
				className={
					"px-2 py-2 -mb-px border-b-2 transition " +
					(open
						? "border-accent text-accent"
						: "border-transparent text-ink-400 hover:text-accent dark:text-ink-500")
				}
			>
				<EllipsisVertical size={16} />
			</button>
			{open && (
				// 靠右:這顆在列的最右邊,`left-0` 會讓選單溢出閱讀寬度。
				<div
					role="menu"
					onClick={() => setOpen(false)}
					className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 py-1 shadow-xl"
				>
					{children}
				</div>
			)}
		</div>
	);
}

/** 溢出選單裡的一列。外觀集中在這裡,呼叫端只給標籤與計數。 */
export function TabOverflowItem({
	onClick,
	children,
}: {
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-ink-700/60"
		>
			{children}
		</button>
	);
}
