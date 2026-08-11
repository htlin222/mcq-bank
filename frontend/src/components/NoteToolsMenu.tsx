import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleEllipsis } from "lucide-react";

/**
 * 個人筆記卡右上角的工具(#137)。
 *
 * **兩種形態,同一份定義。** 寬螢幕直接把每一項畫成按鈕(原本的樣子);窄螢幕收進
 * 一顆「更多」。呼叫端只給一個 `NoteTool[]`,兩邊不會漂移 —— 各寫一次的話,遲早
 * 有一顆按鈕只加在其中一邊,而那在另一種寬度下是看不見的。
 *
 * 為什麼窄螢幕要收:那一排原本是 全螢幕 / 自動挖空 / 防劇透 / 編輯 四顆帶文字的
 * 按鈕,390px 上必定折成兩行,而那一列是 `justify-end` 的 —— 折行之後「編輯」單獨
 * 吊在右下角,看起來像壞掉。
 *
 * 全螢幕**不在這組裡**:它是「怎麼讀這則筆記」裡唯一每天都會按的,而且進了選單
 * 就得先關掉選單才看得到放大後的樣子。
 */
export type NoteTool = {
	key: string;
	icon: ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	/** 目前是開著的狀態(自動挖空有結果、防劇透開著)。 */
	active?: boolean;
	/** 用 accent 色畫(「編輯」是這一排唯一會改動內容的動作)。 */
	accent?: boolean;
	title?: string;
};

/** 寬螢幕:直接畫成一排按鈕。class 由呼叫端給,跟同一列的其他按鈕共用一個來源。 */
export function NoteToolButtons({
	tools,
	className,
}: {
	tools: NoteTool[];
	/** `(active) => class`,通常是 Question.tsx 的 TOOL_BTN。 */
	className: (active: boolean) => string;
}) {
	return (
		<>
			{tools.map((t) => (
				<button
					key={t.key}
					type="button"
					onClick={t.onClick}
					disabled={t.disabled}
					title={t.title}
					aria-pressed={t.active}
					className={
						t.accent && !t.active
							? "inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
							: className(!!t.active)
					}
				>
					{t.icon} {t.label}
				</button>
			))}
		</>
	);
}

/**
 * 窄螢幕:收成一顆「更多」。
 *
 * 這裡不做鍵盤 roving focus —— 選單只有三項,原生的 Tab 就夠用;做了反而要處理
 * 「按鈕停用時跳過」之類的邊界。
 */
export function NoteToolsMenu({ tools }: { tools: NoteTool[] }) {
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
					{tools.map((t) => (
						<button
							key={t.key}
							type="button"
							role="menuitem"
							onClick={t.onClick}
							disabled={t.disabled}
							title={t.title}
							aria-pressed={t.active}
							className={
								"flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition disabled:opacity-50 " +
								(t.active
									? "text-accent bg-accent/10"
									: "text-ink-700 hover:bg-ink-50 dark:text-ink-200 dark:hover:bg-ink-700/60")
							}
						>
							<span className="shrink-0">{t.icon}</span>
							<span className="min-w-0 truncate">{t.label}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
