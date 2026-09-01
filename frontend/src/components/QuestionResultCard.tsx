import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AnswerOptions } from "./AnswerOptions";
import { AnswerVerdict } from "./AnswerVerdict";
import { BookmarkBadge } from "./BookmarkBadge";
import { QuestionRowActions } from "./QuestionRowActions";
import { groupBadgeClass } from "../lib/groups";
import { markTerms } from "../lib/markTerms";
import { optionHits, stemHasHit } from "../lib/optionHits";
import { type QuestionListRow, rowTitle } from "../lib/questionRow";

/**
 * 清單頁上的一張題目卡:題號 · 收藏 · 分類 · **完整題幹** · 我上次答的 ·
 * 兩顆浮動動作鈕 · 可展開的選項。
 *
 * 搜尋、收藏、錯題回顧、弱點地圖用的是同一張 —— 一張卡改一次,四頁一起變。
 * (成績頁沒有用它:那一列的左緣是對錯狀態的圓形題號、還帶「用時」,結構不同,
 * 硬套進來只會讓這裡多兩個只有一頁在用的 prop。)
 *
 * ## 題幹**不截斷**
 *
 * 舊版是 `line-clamp-2`,而清單上那一列常常剛好停在關鍵的那一句之前 ——
 * 使用者得逐題點進去才知道是不是要找的。搜尋頁原本更麻煩:顯示的是 FTS5 的
 * `snippet()`(預設 16 個 token 的片段),連題目在問什麼都看不到。現在整段都畫,
 * 命中的字由 `lib/markTerms.ts` 在 client 標出來。
 *
 * ## `relative group` 與 `pr-28`
 *
 * `QuestionRowActions` 是絕對定位的,而且**必須是整列連結的兄弟**(巢狀 `<a>`
 * 是無效 HTML)——理由寫在那個檔。`pr-28` 是替它們留位子:不留的話,右緣的
 * 分類 badge 與 `aside` 在 hover 時會被蓋掉。
 */
export function QuestionResultCard({
	row,
	onPeek,
	expandAll,
	linkState,
	highlight,
	aside,
	trailing,
	showBookmark = true,
}: {
	row: QuestionListRow;
	onPeek(): void;
	expandAll: boolean;
	/** 帶進 `/q/:id` 的 router state(搜尋的 `{ fromSearch }`)。 */
	linkState?: unknown;
	/** 要在題幹裡標起來的字(搜尋才有)。 */
	highlight?: string[];
	/** 題幹右邊的附加資訊(錯題回顧的「答對/作答」次數)。 */
	aside?: ReactNode;
	/** 整列連結**之外**的東西(收藏頁的移動/移除選單)。 */
	trailing?: ReactNode;
	/** 收藏頁的「個人筆記」分頁不畫收藏徽章 —— 那一頁的每一題不一定被收藏。 */
	showBookmark?: boolean;
}) {
	const title = rowTitle(row);
	const parts = highlight?.length ? markTerms(row.stem, highlight) : null;
	// 搜尋索引涵蓋題幹 + **選項** + 標籤,所以一題完全可以因為某個選項裡的字被
	// 找出來 —— 而題幹上一個標記都沒有,那一列看起來就莫名其妙。舊版顯示 FTS5 的
	// snippet() 時這件事會自己解釋(它標的是命中的位置,不限於題幹);換成整段
	// 題幹之後那個解釋沒了,所以在這裡補回來。
	//
	// **只在題幹沒有命中時才畫** —— 題幹已經標起來的話,再多一行只是重複說一次。
	const inOptions =
		highlight?.length && !stemHasHit(row.stem, highlight)
			? optionHits(row.options, highlight)
			: [];

	return (
		<>
			<div className="relative group">
				<Link
					to={`/q/${row.id}`}
					state={linkState}
					className="flex gap-3 items-start bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 pr-28 hover:border-accent hover:shadow-paper transition"
				>
					<span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0 w-16 text-right">
						{title}
					</span>
					{showBookmark && <BookmarkBadge questionId={row.id} className="mt-1" />}
					<span className="flex-1 min-w-0">
						<span
							data-stem
							className="block text-ink-800 dark:text-ink-200 leading-relaxed break-words"
						>
							{parts
								? parts.map((p, i) =>
										p.hit ? (
											// eslint-disable-next-line react/no-array-index-key
											<mark
												key={i}
												className="bg-amber-200 dark:bg-amber-700 text-inherit rounded px-0.5"
											>
												{p.text}
											</mark>
										) : (
											// eslint-disable-next-line react/no-array-index-key
											<span key={i}>{p.text}</span>
										),
									)
								: row.stem}
						</span>
						{inOptions.length > 0 && (
							<span className="mt-1 block text-xs text-ink-500 dark:text-ink-400">
								{inOptions.map((o) => (
									<span key={o.key} className="block truncate">
										符合選項 {o.key}:
										{markTerms(o.text, highlight ?? []).map((p, i) =>
											p.hit ? (
												// eslint-disable-next-line react/no-array-index-key
												<mark
													key={i}
													className="bg-amber-200 dark:bg-amber-700 text-inherit rounded px-0.5"
												>
													{p.text}
												</mark>
											) : (
												// eslint-disable-next-line react/no-array-index-key
												<span key={i}>{p.text}</span>
											),
										)}
									</span>
								))}
							</span>
						)}
						{row.correct_answer && (
							<span className="block text-xs text-ink-500 dark:text-ink-400 mt-1">
								<AnswerVerdict
									chosen={row.last_chosen ?? null}
									correctAnswer={row.correct_answer}
									correct={row.last_correct === 1}
									seen={(row.times_seen ?? 0) > 0}
								/>
							</span>
						)}
					</span>
					{row.group && (
						<span
							className={
								"text-[11px] px-2 py-0.5 rounded shrink-0 self-center " +
								groupBadgeClass(row.group)
							}
						>
							{row.group}
						</span>
					)}
					{aside}
				</Link>
				<QuestionRowActions questionId={row.id} title={title} onPeek={onPeek} />
				{trailing}
			</div>
			{/* `correct_answer` 缺席時整塊不畫:少了正解,「✓ 正解」那一維就沒有東西
			    可講,展開只剩幾行沒有語意的選項 —— 那比收著更糟。 */}
			{row.correct_answer && (
				<AnswerOptions
					questionId={row.id}
					options={row.options ?? {}}
					chosen={row.last_chosen ?? null}
					correctAnswer={row.correct_answer}
					expandAll={expandAll}
				/>
			)}
		</>
	);
}
