import { Link } from "react-router-dom";
import { Link as LinkIcon, NotebookPen } from "lucide-react";

// 「你可能想連結」—— 依筆記命中的受控關鍵字(疾病/主題)建議相關去處。
// 最多 5 條(連結密度護欄,見 worker/lib/note-links.ts)。
//
// 題目筆記與自由筆記共用這一個元件。抽出來的原因不是省行數:targetKind
// 現在有三種,而 'free' 的 targetId 是 UUID 不是題號 —— 兩邊各自渲染的話,
// 漏掉一邊就會生出 /q/<uuid> 這種連到不存在題目的死連結。
export type NoteLinkItem = {
	targetKind: "question" | "note" | "free";
	targetId: string;
	sharedTerms: string[];
	year?: number;
	number?: number;
	stem?: string;
	group?: string | null;
	title?: string;
};

const CHIP =
	"rounded-full bg-ink-100 dark:bg-ink-700 text-ink-500 dark:text-ink-300 text-[11px] px-1.5 py-0.5";

export function NoteLinkList({ links }: { links: NoteLinkItem[] }) {
	if (!links.length) return null;
	return (
		<section className="mt-5 pt-4 border-t border-ink-100 dark:border-ink-700">
			<h3 className="flex items-center gap-1.5 text-sm font-medium text-ink-600 dark:text-ink-300 mb-2">
				<LinkIcon size={14} /> 你可能想連結
			</h3>
			<ul className="space-y-1">
				{links.map((l) => (
					<li key={`${l.targetKind}:${l.targetId}`}>
						<Link
							to={l.targetKind === "free" ? `/notes/${l.targetId}` : `/q/${l.targetId}`}
							className="group flex items-start gap-2 rounded p-2 -mx-2 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition"
						>
							<span className="font-mono text-xs text-ink-500 dark:text-ink-400 shrink-0 mt-0.5">
								{l.targetKind === "free" ? (
									<NotebookPen size={13} className="mt-0.5" aria-label="其他筆記" />
								) : (
									`${l.year}-${String(l.number ?? 0).padStart(3, "0")}`
								)}
							</span>
							<span className="min-w-0 flex-1">
								<span className="block text-sm text-ink-700 dark:text-ink-200 line-clamp-1 group-hover:text-accent">
									{l.targetKind === "free" ? l.title || "(未命名筆記)" : l.stem}
								</span>
								<span className="mt-1 flex flex-wrap items-center gap-1">
									{l.targetKind === "note" && (
										<span className="rounded-full bg-accent/10 text-accent text-[11px] px-1.5 py-0.5">
											你的筆記
										</span>
									)}
									{l.targetKind === "free" && (
										<span className="rounded-full bg-accent/10 text-accent text-[11px] px-1.5 py-0.5">
											其他筆記
										</span>
									)}
									{l.sharedTerms.slice(0, 4).map((t) => (
										<span key={t} className={CHIP}>
											{t}
										</span>
									))}
								</span>
							</span>
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
