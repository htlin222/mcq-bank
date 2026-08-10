import { useSyncExternalStore } from "react";

/**
 * 「現在是不是窄螢幕」。
 *
 * 存在的理由是 **CSS 構不到的那一類決定** —— 例如「標題砍到幾個字」:那是在
 * 產生字串的時候決定的,不是排版。純排版的差異一律用 Tailwind 的 `sm:` 前綴,
 * 不要來這裡拿布林值再去分支渲染(那會讓同一件事有兩個真相來源,而且 SSR/
 * 首次 render 的瞬間會閃一下)。
 *
 * 斷點跟 Tailwind 的 `sm`(640px)對齊。
 */
const QUERY = "(max-width: 639px)";

function subscribe(onChange: () => void) {
	const mq = window.matchMedia(QUERY);
	mq.addEventListener("change", onChange);
	return () => mq.removeEventListener("change", onChange);
}

export function useNarrow(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => window.matchMedia(QUERY).matches,
		() => false, // 這個 app 不做 SSR;只是型別上的完整
	);
}
