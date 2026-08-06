import { useEffect, useRef, useState } from "react";
import { Gamepad2, TriangleAlert, X } from "lucide-react";
import { useGamepadConnected } from "../hooks/useGamepad";
import {
	claimConnectionAnnouncement,
	rumble,
	rumbleEnabled,
	setRumbleEnabled,
} from "../lib/gamepad";

export type GamepadHint = { btn: string; label: string };

// 手把按鍵說明浮鈕。
//
// 只在偵測到手把時出現 —— 這同時解決了發現性與干擾:沒接手把的人不會看到一顆
// 意義不明的按鈕,接了手把的人第一眼就知道能按什麼。位置在左下角,跟
// BackToTopFab 同側,所以 <md 時往上讓一個鈕的高度;右下角是番茄鐘的地盤。
//
// 按鍵標記用位置而非廠商字母(FACE ▼ 而不是 A):8BitDo 在 X 模式下底鍵印的是
// A,DualSense 印的是 ✕,位置卻是同一顆。
export function GamepadFab({ hints }: { hints: GamepadHint[] }) {
	const { connected, badMapping, name } = useGamepadConnected();
	const [open, setOpen] = useState(false);
	const [rumbleOn, setRumbleOn] = useState(rumbleEnabled);
	const [justConnected, setJustConnected] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);

	// 手把拔掉時把面板收起來,免得留下一片講不到的說明。
	useEffect(() => {
		if (!connected) setOpen(false);
	}, [connected]);

	// 連上的那一刻跳一則短提示。這一步不是裝飾:瀏覽器為了防指紋追蹤,手把用
	// 藍牙配對好之後仍然「看不見」,要等使用者在手把上按下第一顆按鈕才會現身。
	// 所以「什麼時候算連上」對使用者是模糊的 —— 這則提示就是那個答案,而且它
	// 出現的時機正好是第一次按鍵被收到的瞬間,順帶證明按鍵有通。
	//
	// 「講過了沒」記在 lib/gamepad.ts 的模組層,不記在這裡的 state:這顆 FAB 掛在
	// 三條路由上,換頁就重掛,記在元件裡等於每次換頁都重講一次。claim 在沒有手把
	// 時會自己歸零,所以拔掉再插仍然會宣告。
	useEffect(() => {
		if (!claimConnectionAnnouncement()) return;
		setJustConnected(true);
		const t = window.setTimeout(() => setJustConnected(false), 5000);
		return () => window.clearTimeout(t);
	}, [connected]);

	useEffect(() => {
		if (!open) return;
		function onDown(e: PointerEvent) {
			if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (!connected) return null;

	function toggleRumble() {
		const next = !rumbleOn;
		setRumbleEnabled(next);
		setRumbleOn(next);
		// 開啟時立刻震一下 —— 這是唯一能證明它真的會動的方式(Safari 沒有
		// vibrationActuator,按下去不會有反應,而那正是使用者該知道的事)。
		if (next) void rumble("tap");
	}

	return (
		<div
			ref={panelRef}
			className="fixed left-4 bottom-[calc(var(--bottom-nav-h)+4.5rem)] md:bottom-[calc(var(--bottom-nav-h)+1rem)] z-30"
		>
			{justConnected && !open && (
				<button
					type="button"
					onClick={() => setOpen(true)}
					className="mb-2 flex items-center gap-2 rounded-full border border-accent bg-white dark:bg-ink-800 pl-3 pr-4 py-2 text-sm text-ink-700 dark:text-ink-200 shadow-paper animate-fade-in"
				>
					<Gamepad2 size={15} className="shrink-0 text-accent" />
					<span className="whitespace-nowrap">
						{name ? `${name} 已連線` : "手把已連線"} · 看操作說明
					</span>
				</button>
			)}

			{open && (
				<div className="mb-2 w-72 max-h-[60dvh] overflow-y-auto rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 shadow-paper animate-fade-in">
					<div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-ink-100 dark:border-ink-700">
						<h2 className="text-sm font-medium text-ink-800 dark:text-ink-100">
							手把操作
							{name && (
								<span className="ml-2 font-normal text-[11px] text-ink-400 dark:text-ink-500">
									{name}
								</span>
							)}
						</h2>
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="關閉"
							className="text-ink-400 hover:text-accent"
						>
							<X size={15} />
						</button>
					</div>

					{badMapping && (
						<p className="flex gap-2 px-4 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-500 border-b border-ink-100 dark:border-ink-700">
							<TriangleAlert size={14} className="shrink-0 mt-0.5" />
							<span>
								這支手把回報的不是標準配置,按鍵可能對不上。8BitDo 請切到{" "}
								<b>X 模式</b>(按住 X + START)。
							</span>
						</p>
					)}

					<dl className="px-4 py-3 space-y-1.5">
						{hints.map((h) => (
							<div key={h.btn} className="flex gap-3 text-sm">
								<dt className="w-24 shrink-0 font-mono text-[11px] leading-5 text-ink-500 dark:text-ink-400">
									{h.btn}
								</dt>
								<dd className="text-ink-700 dark:text-ink-200 leading-5">
									{h.label}
								</dd>
							</div>
						))}
					</dl>

					<div className="px-4 py-3 border-t border-ink-100 dark:border-ink-700">
						<label className="flex items-center gap-2 text-sm text-ink-700 dark:text-ink-200 cursor-pointer">
							<input
								type="checkbox"
								checked={rumbleOn}
								onChange={toggleRumble}
								className="accent-accent"
							/>
							送出答案時震動
						</label>
					</div>
				</div>
			)}

			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				aria-label="手把操作說明"
				title="手把操作說明"
				className={
					"h-12 w-12 grid place-items-center rounded-full border shadow-paper transition animate-fade-in " +
					(open
						? "bg-accent border-accent text-white"
						: "border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-500 dark:text-ink-400 hover:text-accent hover:border-accent")
				}
			>
				<Gamepad2 size={20} />
			</button>
		</div>
	);
}
