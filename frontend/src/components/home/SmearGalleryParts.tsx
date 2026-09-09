import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import {
	SMEAR_QTYPE_LABELS,
	SMEAR_TOPIC_LABELS,
	type SmearGalleryItem,
} from "../../lib/smearApi";
import { secondsLeft } from "../../lib/smearGallery";
import { StaticContent } from "../StaticContent";
import { useIsEink } from "../../lib/theme";

// 輪播卡與全螢幕螢幕保護共用的兩塊:圖、說明。
//
// **共用是承重的,不是省行數。** 兩處各寫一份的話,之後加一個欄位(例如
// 「這張圖出自哪一份考卷」)一定會有一邊漏掉,而症狀是「全螢幕看的時候少一
// 行」—— 沒有人會回報得清楚。同 CLAUDE.md「檢討介面只有一套」那節。

/** 圖片本身。**換圖用 WAAPI 淡入,不用 key/remount** —— 同 CLAUDE.md 換題那節
 *  的理由。`prefers-reduced-motion` 與 e-ink 下直接不做動畫。 */
export function GalleryImage({
	item,
	sizeKey,
	previewKey,
	className,
}: {
	item: SmearGalleryItem;
	sizeKey: "image_key_view" | "image_key_full";
	/** 先畫這一個、載好 `sizeKey` 那張再換過去。
	 *
	 *  ⚠️ **這是全螢幕「卡一下」的成因。** 478 張裡有 203 張的 full 跟 view 是
	 *  不同的檔(100–180 KB),而全螢幕的 `<img>` 是一個全新的元素 —— 量出來第
	 *  一幀就是 `complete: false, naturalWidth: 0`,也就是**圖片區整塊是空的**,
	 *  等新檔載完才出現。本機 33ms 看不太出來,手機網路上就是幾百毫秒的黑框。
	 *
	 *  先畫卡片上已經解碼過的 view(同一個 `<img>` 換 src 時,瀏覽器會**繼續
	 *  顯示舊的**直到新的解碼完成),所以全程沒有空白,也沒有多花任何頻寬 ——
	 *  view 本來就已經在快取裡了。 */
	previewKey?: "image_key_view";
	className?: string;
}) {
	const ref = useRef<HTMLImageElement | null>(null);
	const eink = useIsEink();

	// 兩段載入。`previewKey` 沒給、或兩個 key 本來就一樣(275/478 是這種)時
	// 直接用目標尺寸,不多繞一圈。
	const lo = previewKey ? item[previewKey] : null;
	const hi = item[sizeKey];
	const [hiReady, setHiReady] = useState(() => !lo || lo === hi);
	useEffect(() => {
		if (!lo || lo === hi) {
			setHiReady(true);
			return;
		}
		setHiReady(false);
		const img = new Image();
		img.onload = () => setHiReady(true);
		// 載不到就維持在 view —— 那比一塊空白好,而且使用者多半看不出差別。
		img.src = `/img/${hi}`;
		return () => {
			img.onload = null;
		};
	}, [lo, hi]);
	const shownKey = hiReady ? hi : (lo as string);

	useEffect(() => {
		const el = ref.current;
		if (!el || eink) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		el.animate([{ opacity: 0 }, { opacity: 1 }], {
			duration: 220,
			easing: "ease-out",
		});
	}, [item.id, eink]);

	// ⚠️ 底色由呼叫端給,這裡不預設。兩個用法要的不一樣:卡片在首頁上,兩條
	// 黑色留白條在亮色主題下重得像排版壞掉(抹片本身是亮視野、背景近白);
	// 螢幕保護則非黑不可 —— 那是投影機或暗房裡的畫面。**寫死一個再由
	// className 蓋是不行的**:同一層 utility 的勝負由打包後的檔案順序決定,
	// 不是由字串裡誰寫在後面。
	return (
		<div
			className={`flex items-center justify-center overflow-hidden ${className ?? ""}`}
		>
			{/* object-contain,不 cover —— 這是診斷影像,裁掉的可能正好是說明在
			    講的那顆細胞。使用者上傳的醫學圖在 e-ink 下刻意不二值化(見
			    CLAUDE.md 電子紙那節)。 */}
			<img
				ref={ref}
				data-gallery-image={item.id}
				data-hi-res={hiReady ? "1" : "0"}
				src={`/img/${shownKey}`}
				alt={`抹片影像:${item.canonical_long}`}
				className="max-w-full max-h-full w-auto h-auto object-contain"
			/>
		</div>
	);
}

/** 右欄(全螢幕時是側欄／底部長條)的說明。`dark` 是「畫在黑底上」的版本,
 *  不是深色主題 —— 螢幕保護的底永遠是黑的,跟使用者選什麼主題無關。 */
export function GalleryCaption({
	item,
	dark = false,
	clamp = true,
	note = null,
	onOpenDetail,
}: {
	item: SmearGalleryItem;
	dark?: boolean;
	/** 詳解摘要收成三行。卡片上要(那個右欄只有那麼高),**全螢幕不要** ——
	 *  一整欄空著卻把說明截掉,是把版面的限制當成內容的限制。 */
	clamp?: boolean;
	/** 共筆詳解全文(TipTap JSON,已 parse)。給了就畫全文而不是那 220 字的
	 *  摘要;還沒回來或那個診斷沒有詳解就是 null。**永遠有 fallback** ——
	 *  「載入中」在螢幕保護上是一塊空白,而空白比舊摘要糟。 */
	note?: unknown;
	/** 有給就讓「標題 + 說明」整塊可以點,打開細節對話框(不跳頁)。
	 *  ⚠️ **可點的範圍刻意不含底下那一行連結** —— 巢狀的互動元素是無效 HTML,
	 *  瀏覽器解析時會把內層的 `<a>` 拉到 `<button>` 外面,連結就跑到卡片外、
	 *  點了不一定去對的地方,而且沒有任何錯誤訊息(同 CLAUDE.md 那條巢狀
	 *  `<a>` 的教訓)。 */
	onOpenDetail?: () => void;
}) {
	const title = item.canonical_abbrev
		? `${item.canonical_long}(${item.canonical_abbrev})`
		: item.canonical_long;
	// 這一行講的是「這張圖」的事(箭頭指哪、A-B 說明),不是這個診斷的事 ——
	// 沒有 image_note 時退回 prompt,兩者都沒有就整行不畫。
	const noteLine = item.image_note ?? item.prompt;
	const sourceLabel = item.attribution ?? item.source_ref ?? item.source;

	const body = (
		<>
			<h3
				className={`font-serif text-lg leading-snug break-words ${
					dark ? "text-white" : "text-ink-900 dark:text-ink-100"
				}`}
			>
				{title}
			</h3>

			<div className="flex flex-wrap gap-1.5">
				<Badge dark={dark}>
					{SMEAR_TOPIC_LABELS[item.topic] ?? item.topic}
				</Badge>
				<Badge dark={dark}>
					{SMEAR_QTYPE_LABELS[item.qtype] ?? item.qtype}
				</Badge>
			</div>

			{noteLine && (
				<p
					className={`text-xs leading-relaxed break-words ${
						dark ? "text-ink-300" : "text-ink-500 dark:text-ink-400"
					}`}
				>
					{noteLine}
				</p>
			)}

			{/* 共筆詳解。有全文(`note`)就畫全文,否則畫伺服器端截到 220 字的
			    摘要(見 /gallery 的 GALLERY_PREVIEW_MAX)。

			    ⚠️ 全文走 StaticContent 而不是把更長的純文字塞進 <p> —— 摘要是
			    `GROUP_CONCAT` 壓平 TipTap JSON 的結果,220 字還看得下去,整篇
			    壓平之後標題會黏在內文裡,愈長愈難讀。 */}
			{note ? (
				<div
					className={`text-sm leading-relaxed min-w-0 ${
						dark ? "smear-note-dark" : ""
					}`}
				>
					<StaticContent content={note} />
				</div>
			) : (
				item.note_preview && (
					<p
						className={`text-sm leading-relaxed break-words ${
							clamp ? "line-clamp-3" : ""
						} ${dark ? "text-ink-200" : "text-ink-600 dark:text-ink-300"}`}
					>
						{item.note_preview}
					</p>
				)
			)}

		</>
	);

	return (
		<div className="min-w-0 space-y-2">
			{onOpenDetail ? (
				<button
					type="button"
					onClick={onOpenDetail}
					title="看完整詳解"
					className="block w-full text-left space-y-2 rounded cursor-pointer"
				>
					{body}
				</button>
			) : (
				<div className="space-y-2">{body}</div>
			)}

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
				<Link
					to={`/smear/dx/${item.dx_id}`}
					className={`text-sm hover:underline ${
						dark ? "text-accent-light" : "text-accent dark:text-accent-light"
					}`}
				>
					看完整診斷 →
				</Link>
				{item.source_url ? (
					<a
						href={item.source_url}
						target="_blank"
						rel="noreferrer"
						className={`inline-flex items-center gap-1 text-xs hover:underline ${
							dark ? "text-ink-400" : "text-ink-400 dark:text-ink-500"
						}`}
					>
						{sourceLabel}
						<ExternalLink size={12} strokeWidth={1.75} />
					</a>
				) : (
					<span
						className={`text-xs ${dark ? "text-ink-400" : "text-ink-400 dark:text-ink-500"}`}
					>
						{sourceLabel}
					</span>
				)}
			</div>
		</div>
	);
}

function Badge({
	children,
	dark,
}: {
	children: React.ReactNode;
	dark?: boolean;
}) {
	return (
		<span
			className={`text-xs px-2 py-0.5 rounded-full border ${
				dark
					? "border-ink-600 text-ink-300"
					: "border-ink-200 dark:border-ink-600 text-ink-500 dark:text-ink-400"
			}`}
		>
			{children}
		</span>
	);
}

/**
 * 「還有幾秒換下一張」。`deadline` 為 null(自動輪播沒在跑)時整個不畫 ——
 * 停著的倒數是假的資訊。
 *
 * **它自己持有每秒的 state,不是由呼叫端每秒重繪整張卡。** 放在上層的話,圖片、
 * 說明、整條控制列每秒都要跟著 render 一次;隔離在這裡之後,每秒變的只有一個
 * 數字。
 *
 * `aria-hidden` 是刻意的:讀屏軟體每秒念一次數字會把說明整段蓋掉,而這個數字
 * 對「這張圖是什麼」沒有任何貢獻。暫停鈕的 label 已經說明了自動輪播的狀態。
 */
export function GalleryCountdown({
	deadline,
	className,
}: {
	deadline: number | null;
	className?: string;
}) {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (deadline === null) return;
		setNow(Date.now());
		const t = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(t);
	}, [deadline]);

	const left = secondsLeft(deadline, now);
	if (left === null) return null;
	return (
		<span
			aria-hidden
			className={`tabular-nums text-xs text-ink-400 dark:text-ink-500 w-8 text-right ${className ?? ""}`}
		>
			{left}s
		</span>
	);
}
