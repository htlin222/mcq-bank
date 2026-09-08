import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import {
	SMEAR_QTYPE_LABELS,
	SMEAR_TOPIC_LABELS,
	type SmearGalleryItem,
} from "../../lib/smearApi";
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
	className,
}: {
	item: SmearGalleryItem;
	sizeKey: "image_key_view" | "image_key_full";
	className?: string;
}) {
	const ref = useRef<HTMLImageElement | null>(null);
	const eink = useIsEink();

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
				src={`/img/${item[sizeKey]}`}
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
}: {
	item: SmearGalleryItem;
	dark?: boolean;
	/** 詳解摘要收成三行。卡片上要(那個右欄只有那麼高),**全螢幕不要** ——
	 *  一整欄空著卻把說明截掉,是把版面的限制當成內容的限制。 */
	clamp?: boolean;
}) {
	const title = item.canonical_abbrev
		? `${item.canonical_long}(${item.canonical_abbrev})`
		: item.canonical_long;
	// 這一行講的是「這張圖」的事(箭頭指哪、A-B 說明),不是這個診斷的事 ——
	// 沒有 image_note 時退回 prompt,兩者都沒有就整行不畫。
	const noteLine = item.image_note ?? item.prompt;
	const sourceLabel = item.attribution ?? item.source_ref ?? item.source;

	return (
		<div className="min-w-0 space-y-2">
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

			{/* 共筆詳解摘要。伺服器端已經截到 220 字(見 /gallery 的
			    GALLERY_PREVIEW_MAX),卡片上再收成三行。 */}
			{item.note_preview && (
				<p
					className={`text-sm leading-relaxed break-words ${
						clamp ? "line-clamp-3" : ""
					} ${dark ? "text-ink-200" : "text-ink-600 dark:text-ink-300"}`}
				>
					{item.note_preview}
				</p>
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
