import { useEffect, useState } from "react";
import { pickActiveSection, type SectionTop } from "../../lib/tocSpy";

// 設定頁左側的區塊導覽。卡片一路加到五張之後,整頁要捲很久才找得到「帳號」
// 或「AI 助手」,這條側欄就是為了省掉那段捲動。
//
// 只在 lg 以上出現:手機上一條常駐側欄會吃掉本來就不多的垂直空間,而窄螢幕
// 直接往下捲反而更快。

export type TocItem = { id: string; label: string };

// 站台 header 是 sticky 且高 h-14(56px)。錨點捲動要多留一點,標題才不會
// 貼在 header 底下 —— 對應各卡片上的 scroll-mt-20。
const HEADER_OFFSET = 80;

export function ProfileToc({ items }: { items: TocItem[] }) {
	const active = useActiveSection(items);

	return (
		<nav
			aria-label="設定區塊"
			className="hidden lg:block sticky top-20 self-start w-48 shrink-0"
		>
			<p className="px-3 pb-2 text-[11px] font-medium uppercase tracking-wide text-ink-400 dark:text-ink-500">
				本頁
			</p>
			<ul className="space-y-0.5 border-l border-ink-200 dark:border-ink-700">
				{items.map((item) => {
					const on = item.id === active;
					return (
						<li key={item.id}>
							<a
								href={`#${item.id}`}
								aria-current={on ? "true" : undefined}
								onClick={(e) => {
									// 自己捲而不是交給瀏覽器:原生錨點跳轉會把標題塞到
									// sticky header 底下,而且會在網址列留下 hash。
									e.preventDefault();
									scrollToSection(item.id);
								}}
								className={[
									"block -ml-px border-l-2 px-3 py-1.5 text-sm transition",
									on
										? "border-accent text-accent font-medium"
										: "border-transparent text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-200 hover:border-ink-300 dark:hover:border-ink-600",
								].join(" ")}
							>
								{item.label}
							</a>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

function scrollToSection(id: string) {
	const el = document.getElementById(id);
	if (!el) return;
	const top = el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET;
	window.scrollTo({ top, behavior: "smooth" });
}

/**
 * 目前捲到哪一區。這裡只負責量 DOM 與節流;要選誰是
 * `lib/tocSpy.ts` 的 pickActiveSection(純函式,有單元測試)。
 */
function useActiveSection(items: TocItem[]): string {
	const [active, setActive] = useState(items[0]?.id ?? "");

	useEffect(() => {
		let raf = 0;

		function measure() {
			raf = 0;
			const sections: SectionTop[] = [];
			for (const item of items) {
				const el = document.getElementById(item.id);
				if (el) sections.push({ id: item.id, top: el.getBoundingClientRect().top });
			}
			const picked = pickActiveSection({
				sections,
				line: HEADER_OFFSET + 8,
				atBottom:
					window.innerHeight + window.scrollY >=
					document.documentElement.scrollHeight - 2,
			});
			if (picked) setActive(picked);
		}

		function onScroll() {
			if (raf) return;
			raf = requestAnimationFrame(measure);
		}

		measure();
		window.addEventListener("scroll", onScroll, { passive: true });
		window.addEventListener("resize", onScroll);
		return () => {
			if (raf) cancelAnimationFrame(raf);
			window.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onScroll);
		};
	}, [items]);

	return active;
}
