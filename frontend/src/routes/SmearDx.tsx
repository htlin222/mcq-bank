import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Bookmark, BookmarkPlus, ExternalLink, Loader2 } from "lucide-react";
import { ApiError } from "../lib/api";
import {
	fetchSmearDx,
	fetchSmearBookmarks,
	bookmarkSmearDx,
	unbookmarkSmearDx,
	SMEAR_TOPIC_LABELS,
	SMEAR_QTYPE_LABELS,
	type SmearDxDetail,
} from "../lib/smearApi";
import { SmearImage } from "../components/smear/SmearImage";
import { SmearDxPanel } from "../components/smear/SmearDxPanel";

// /smear/dx/:id —— 診斷詳情頁(D5)。這一支現在只管「這個診斷是什麼」的頭部
// (標題/badge/收藏鈕/圖片格線),詳解/個人筆記/討論/相似四塊全部交給
// SmearDxPanel(components/smear/SmearDxPanel.tsx)—— 那個面板同時也嵌在
// /smear/s/:id 的複習模式作答後,兩邊共用同一份邏輯,不要在這裡重寫一份。
//
// ≥sm 是兩欄(左:這一支自己畫的頭部;右:SmearDxPanel),<sm 疊成一欄 ——
// 純版面差異一律用 Tailwind 的 `sm:` 前綴,不在這裡用 `useNarrow()` 分支
// JSX(該 hook 檔頭本來就這樣要求;SmearDxPanel 內部另有一個真的需要 JS
// 才能做的決定,見那支檔案的說明)。

export function SmearDx() {
	const { id } = useParams<{ id: string }>();

	const [dx, setDx] = useState<SmearDxDetail | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	// null = 還不知道(收藏清單還沒回來),true/false = 已知狀態。GET
	// /api/smear/dx/:id 不回 bookmarked 欄位,所以用 GET /bookmarks 的清單反查
	// —— 見 smearApi.ts 的說明。這支請求失敗不擋頁面:收藏鈕就先當作「未收藏」,
	// 使用者頂多按一次才發現狀態不對,好過整頁因為這個非關鍵資訊而讀取失敗。
	const [bookmarked, setBookmarked] = useState<boolean | null>(null);
	const [bookmarkBusy, setBookmarkBusy] = useState(false);

	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		setDx(null);
		setLoadError(null);
		fetchSmearDx(id)
			.then((d) => {
				if (!cancelled) setDx(d);
			})
			.catch((e) => {
				if (cancelled) return;
				setLoadError(
					e instanceof ApiError && e.status === 404
						? "找不到這個診斷。"
						: e instanceof ApiError
							? `讀取失敗 (${e.status})`
							: String(e),
				);
			});
		return () => {
			cancelled = true;
		};
	}, [id]);

	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		setBookmarked(null);
		fetchSmearBookmarks()
			.then((r) => {
				if (!cancelled) setBookmarked(r.items.some((it) => it.dx_id === id));
			})
			.catch(() => {
				if (!cancelled) setBookmarked(false);
			});
		return () => {
			cancelled = true;
		};
	}, [id]);

	async function toggleBookmark() {
		if (!dx || bookmarked === null || bookmarkBusy) return;
		const next = !bookmarked;
		setBookmarkBusy(true);
		setBookmarked(next); // 樂觀更新
		try {
			if (next) await bookmarkSmearDx(dx.id);
			else await unbookmarkSmearDx(dx.id);
		} catch (e) {
			setBookmarked(!next); // 失敗回滾
			alert(e instanceof ApiError ? `操作失敗 (${e.status})` : String(e));
		} finally {
			setBookmarkBusy(false);
		}
	}

	if (loadError) {
		return (
			<div className="max-w-md mx-auto px-4 py-20 text-center">
				<p className="text-accent break-words">{loadError}</p>
				<Link
					to="/smear?tab=search"
					className="text-accent hover:text-accent-dark text-sm mt-4 inline-block"
				>
					← 回抹片練習
				</Link>
			</div>
		);
	}

	if (!dx || !id) {
		return (
			<div className="max-w-md mx-auto px-4 py-20 text-center text-ink-400 dark:text-ink-500">
				<Loader2 className="animate-spin mx-auto mb-3" size={22} />
				載入中…
			</div>
		);
	}

	return (
		<div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 pb-20">
			<Link
				to="/smear?tab=search"
				className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1 mb-4"
			>
				<ArrowLeft size={14} /> 回抹片練習
			</Link>

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-8 items-start">
				<div>
					<div className="flex items-start gap-2 mb-2">
						{/* 標題:break-words —— canonical_long 這類病理命名法不保證有天然斷行點
						    (同 GradeReveal「DEK::NUP214」那條)。 */}
						<h1 className="font-serif text-2xl text-ink-900 dark:text-ink-100 break-words min-w-0 flex-1">
							{dx.canonical_long}
							{dx.canonical_abbrev && (
								<span className="ml-2 text-lg text-ink-500 dark:text-ink-400 font-sans">
									({dx.canonical_abbrev})
								</span>
							)}
						</h1>
						<button
							type="button"
							onClick={toggleBookmark}
							disabled={bookmarked === null || bookmarkBusy}
							aria-pressed={!!bookmarked}
							aria-label={bookmarked ? "取消收藏" : "收藏這個診斷"}
							title={bookmarked ? "取消收藏" : "收藏這個診斷"}
							className={
								"shrink-0 p-1.5 rounded transition disabled:opacity-40 " +
								(bookmarked
									? "text-accent"
									: "text-ink-400 dark:text-ink-500 hover:text-accent")
							}
						>
							{bookmarked ? (
								<Bookmark size={22} fill="currentColor" />
							) : (
								<BookmarkPlus size={22} />
							)}
						</button>
					</div>
					<div className="flex flex-wrap gap-1.5 mb-6">
						<span className="text-xs px-2 py-0.5 rounded-full border border-ink-300 dark:border-ink-600 text-ink-600 dark:text-ink-300">
							{SMEAR_TOPIC_LABELS[dx.topic] ?? dx.topic}
						</span>
						<span className="text-xs px-2 py-0.5 rounded-full border border-ink-300 dark:border-ink-600 text-ink-600 dark:text-ink-300">
							{SMEAR_QTYPE_LABELS[dx.qtype] ?? dx.qtype}
						</span>
					</div>

					{/* 圖片 —— 2 欄起跳(320px 也不會溢出) */}
					{dx.questions.length > 0 && (
						<section>
							<h2 className="text-xs uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-2">
								影像({dx.questions.length})
							</h2>
							<div className="grid grid-cols-2 gap-3">
								{dx.questions.map((q) => (
									<div key={q.id}>
										<SmearImage
											viewKey={q.image_key_view}
											fullKey={q.image_key_full}
											alt={dx.canonical_long}
										/>
										{q.source === "ash" && (
											<div className="mt-1 text-[10px] leading-tight text-ink-400 dark:text-ink-500 break-words">
												{q.attribution && <p className="break-words">{q.attribution}</p>}
												{q.source_url && (
													<a
														href={q.source_url}
														target="_blank"
														rel="noopener noreferrer"
														className="inline-flex items-center gap-0.5 text-accent hover:text-accent-dark"
													>
														ASH Image Bank <ExternalLink size={10} />
													</a>
												)}
											</div>
										)}
									</div>
								))}
							</div>
						</section>
					)}
				</div>

				<SmearDxPanel dxId={id} />
			</div>
		</div>
	);
}
