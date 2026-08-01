import { useEffect, useState } from "react";
import { ArrowUpToLine } from "lucide-react";

// 手機上一題詳解可以捲得很長。捲下去之後給一顆浮鈕直接回到最頂(題幹、
// 年度/上下題那一列都在那裡),省掉一路往回刷。
//
// 只在 <md 出現:≥md 的雙欄模式頁面本身不捲動(各欄自己捲),浮鈕會是死按鈕。
// 位置在左下角 —— 右下角讓給番茄鐘 FAB(PomodoroFab),兩顆才不會疊在一起。
const SHOW_AFTER = 400; // px,大約捲過題幹之後才出現

export function BackToTopFab() {
	const [show, setShow] = useState(false);

	useEffect(() => {
		let raf = 0;
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				setShow(window.scrollY > SHOW_AFTER);
			});
		};
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			window.removeEventListener("scroll", onScroll);
			if (raf) cancelAnimationFrame(raf);
		};
	}, []);

	if (!show) return null;

	return (
		<button
			type="button"
			onClick={() =>
				window.scrollTo({
					top: 0,
					behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
						.matches
						? "auto"
						: "smooth",
				})
			}
			aria-label="回到最頂"
			title="回到最頂"
			className="md:hidden fixed left-4 bottom-[calc(var(--bottom-nav-h)+1rem)] z-30 h-12 w-12 grid place-items-center rounded-full border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-500 dark:text-ink-400 shadow-paper transition hover:text-accent hover:border-accent animate-fade-in"
		>
			<ArrowUpToLine size={18} />
		</button>
	);
}
