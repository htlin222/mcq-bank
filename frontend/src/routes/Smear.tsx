import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bookmark, Loader2, Microscope, Search as SearchIcon, Timer } from "lucide-react";
import { ApiError } from "../lib/api";
import { KeepAlive } from "../components/KeepAlive";
import { StartDialog } from "../components/smear/StartDialog";
import { SubmitTab } from "../components/smear/SubmitTab";
import {
	searchSmear,
	fetchSmearSessions,
	fetchSmearWrong,
	fetchSmearBookmarks,
	unbookmarkSmearDx,
	SMEAR_TOPIC_LABELS,
	SMEAR_QTYPE_LABELS,
	SMEAR_MODE_LABELS,
	type SmearMode,
	type SmearSearchHit,
	type SmearHistoryItem,
	type SmearWrongItem,
	type SmearBookmarkItem,
} from "../lib/smearApi";

// /smear —— 6 個分頁,同 /lectures 的 `?tab=` 慣例(可分享、可加書籤、返回時
// 回到原本的分頁)。分頁內容一律 KeepAlive 包住(同 /q/:id),切分頁不重掛、不
// 丟失捲動位置或表單狀態。
//
// 「已收藏」獨立成第五個分頁,不是折進既有四個裡 —— 它跟練習/作答記錄/錯題本
// 是四個不同的問題(「我想再看哪些診斷」vs.「怎麼開始一場練習」/「我考得
// 怎樣」/「我哪裡不熟」),折進任何一個都會讓那個分頁同時回答兩個問題。
//
// 第六個分頁「投稿」同理獨立:它跟「已收藏」一樣是一個新的問題(「我能不能
// 把新的抹片加進題庫」),而且內含一個只有 admin 看得到的審核子分頁 ——
// 詳見 components/smear/SubmitTab.tsx。

type SmearTab = "practice" | "history" | "wrong" | "search" | "bookmark" | "submit";

const TABS: SmearTab[] = [
	"practice",
	"history",
	"wrong",
	"search",
	"bookmark",
	"submit",
];

const TAB_TITLE: Record<SmearTab, string> = {
	practice: "練習",
	history: "作答記錄",
	wrong: "錯題本",
	search: "搜尋",
	bookmark: "已收藏",
	submit: "投稿",
};

function isSmearTab(v: string | null): v is SmearTab {
	return !!v && (TABS as string[]).includes(v);
}

export function Smear() {
	const [searchParams, setSearchParams] = useSearchParams();
	const tabParam = searchParams.get("tab");
	const tab: SmearTab = isSmearTab(tabParam) ? tabParam : "practice";

	const setTab = (t: SmearTab) =>
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				if (t === "practice") next.delete("tab");
				else next.set("tab", t);
				return next;
			},
			{ replace: true },
		);

	return (
		<div className="max-w-3xl md:max-w-4xl mx-auto px-4 sm:px-6 py-8">
			<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-2">
				抹片練習
			</h1>
			<p className="text-ink-500 dark:text-ink-400 text-sm mb-6">
				看一張血液抹片,寫出診斷 —— 練習病理名詞的拼寫與寫法。
			</p>

			<TabBar tab={tab} onTab={setTab} />

			<div className="mt-6">
				<KeepAlive active={tab === "practice"}>
					<PracticeTab onGotoWrong={() => setTab("wrong")} />
				</KeepAlive>
				<KeepAlive active={tab === "history"}>
					<HistoryTab />
				</KeepAlive>
				<KeepAlive active={tab === "wrong"}>
					<WrongTab />
				</KeepAlive>
				<KeepAlive active={tab === "search"}>
					<SearchTab />
				</KeepAlive>
				<KeepAlive active={tab === "bookmark"}>
					<BookmarkTab />
				</KeepAlive>
				<KeepAlive active={tab === "submit"}>
					<SubmitTab />
				</KeepAlive>
			</div>
		</div>
	);
}

function TabBar({
	tab,
	onTab,
}: {
	tab: SmearTab;
	onTab: (t: SmearTab) => void;
}) {
	return (
		<div
			className="inline-flex rounded border border-ink-200 dark:border-ink-700 overflow-hidden"
			role="tablist"
			aria-label="抹片練習分頁"
		>
			{TABS.map((t) => (
				<button
					key={t}
					type="button"
					role="tab"
					onClick={() => onTab(t)}
					aria-selected={tab === t}
					className={
						"px-3 py-1.5 text-sm transition " +
						(tab === t
							? "bg-accent text-white"
							: "bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700")
					}
				>
					{TAB_TITLE[t]}
				</button>
			))}
		</div>
	);
}

// ── 練習分頁:兩張大卡,各自帶著預選的模式打開設定對話框 ─────────────────
//
// 刻意全寬堆疊(不是 sm/md 才變兩欄的 grid)—— 手機是這個功能的主要使用情境
// (CLAUDE.md「MOBILE IS THE PRIORITY」),卡片本身就是大按鈕,不需要為了桌機
// 擠成兩欄後反而在手機上變窄。
function PracticeTab({ onGotoWrong }: { onGotoWrong: () => void }) {
	const [searchParams, setSearchParams] = useSearchParams();
	// `?start=review|exam` 讓首頁抹片 dashboard / 手機底部導覽的「複習」「全真」
	// 兩顆能一鍵直接開對話框,不用先落地再點一次卡片。只在**初次掛載**讀一次
	// (lazy initializer),讀完立刻把參數清掉 —— 不然使用者用瀏覽器上一頁/
	// 下一頁在分頁間切換時,這顆對話框會無緣無故又跳出來一次。
	const [dialogMode, setDialogMode] = useState<SmearMode | null>(() => {
		const start = searchParams.get("start");
		return start === "review" || start === "exam" ? start : null;
	});
	useEffect(() => {
		if (!searchParams.get("start")) return;
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("start");
				return next;
			},
			{ replace: true },
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// 只用來決定「要不要顯示弱點提要」這一行 —— 錯題本分頁自己會再抓一次
	// 完整清單,這裡刻意不共用 state,兩個分頁各自獨立才不會因為誰先掛載
	// 而互相卡住彼此的載入時機。
	const [wrongCount, setWrongCount] = useState<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchSmearWrong()
			.then((r) => {
				if (!cancelled) setWrongCount(r.items.length);
			})
			.catch(() => {
				if (!cancelled) setWrongCount(null);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div className="space-y-4">
			{wrongCount !== null && wrongCount > 0 && (
				// 累積動線的起點:練習分頁本身不會告訴你哪裡不熟,所以在這裡先
				// 提一句,讓「去錯題本看看」成為一個隨手可以按的念頭,而不是要
				// 使用者自己想到要去點分頁列。
				<button
					type="button"
					onClick={onGotoWrong}
					className="w-full flex items-center justify-between gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm text-amber-800 dark:text-amber-300 hover:border-amber-400 transition text-left"
				>
					<span>還有 {wrongCount} 個診斷答錯過,尚未抓穩</span>
					<span className="text-xs underline underline-offset-2 shrink-0">
						去錯題本看看
					</span>
				</button>
			)}
			<ModeCard
				icon={<Microscope size={18} aria-hidden="true" />}
				title="複習模式"
				desc="看一張抹片,寫出診斷。每題作答後立刻看判定、可接受寫法與詳解 —— 適合平常累積。"
				onClick={() => setDialogMode("review")}
			/>
			<ModeCard
				icon={<Timer size={18} aria-hidden="true" />}
				title="全真模式"
				desc="連續作答,全程不揭曉正解;交卷後才看整體成績與逐題檢討 —— 適合考前自我測驗。"
				onClick={() => setDialogMode("exam")}
			/>
			{dialogMode && (
				<StartDialog
					initialMode={dialogMode}
					onClose={() => setDialogMode(null)}
				/>
			)}
		</div>
	);
}

export function ModeCard({
	icon,
	title,
	desc,
	onClick,
}: {
	icon: ReactNode;
	title: string;
	desc: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full text-left bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 sm:p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
		>
			<div className="flex items-center gap-2">
				<span className="text-accent">{icon}</span>
				<h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
					{title}
				</h2>
			</div>
			<p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
				{desc}
			</p>
		</button>
	);
}

// ── 作答記錄分頁(D4)───────────────────────────────────────────────────
function HistoryTab() {
	const [items, setItems] = useState<SmearHistoryItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchSmearSessions()
			.then((r) => {
				if (!cancelled) setItems(r.items);
			})
			.catch((e) => {
				if (cancelled) return;
				setItems([]);
				setError(e instanceof ApiError ? `讀取失敗 (${e.status})` : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (error) {
		return <p className="text-accent text-sm text-center py-10">讀取失敗:{error}</p>;
	}
	if (items === null) {
		return (
			<p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500 py-10">
				<Loader2 size={15} className="animate-spin" /> 載入中…
			</p>
		);
	}
	if (items.length === 0) {
		return (
			<p className="text-sm text-ink-400 dark:text-ink-500 text-center py-10">
				還沒有作答紀錄,先去練習分頁開始第一場吧。
			</p>
		);
	}

	return (
		<ul className="space-y-2">
			{items.map((it) => (
				<HistoryRow key={it.id} item={it} />
			))}
		</ul>
	);
}

// ⚠️ 未完成的全真模式一律不顯示分數 —— 即使是 0 分或看起來中性的進度也不行。
// 判準是 `finished_at == null`,不是 `score == null`:0 分是合法的已完成成績,
// 拿它當「未完成」的判準會反過來把已交卷但考差的那場誤判成還在作答中。這是
// worker/routes/smear.ts 的安全模型延伸到這一頁的地方 —— 未交卷的全真模式,
// 判定要到 /finish 才揭曉,這裡不能替它先洩漏出一個分數(哪怕是 0)。
function HistoryRow({ item }: { item: SmearHistoryItem }) {
	const finished = item.finished_at != null;
	const pct =
		finished && item.max_score && item.max_score > 0
			? Math.round(((item.score ?? 0) / item.max_score) * 100)
			: null;

	return (
		<li>
			<Link
				to={finished ? `/smear/s/${item.id}/result` : `/smear/s/${item.id}`}
				className="flex items-center justify-between gap-3 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-3 hover:border-accent transition"
			>
				<div className="min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<span
							className={
								"px-2 py-0.5 rounded-full text-[11px] border " +
								(item.mode === "review"
									? "border-accent text-accent"
									: "border-ink-400 dark:border-ink-500 text-ink-600 dark:text-ink-300")
							}
						>
							{SMEAR_MODE_LABELS[item.mode]}
						</span>
						<span className="text-xs text-ink-400 dark:text-ink-500">
							{new Date(item.started_at).toLocaleString("zh-TW")}
						</span>
					</div>
					<p className="text-sm text-ink-600 dark:text-ink-300 mt-1">
						{item.question_count} 題
						{!finished && (
							<span className="ml-2 text-accent">未完成 · 點擊繼續作答</span>
						)}
					</p>
				</div>
				{finished && (
					<div className="shrink-0 text-right">
						<div className="font-mono text-lg text-ink-900 dark:text-ink-100 tabular-nums">
							{item.score}
							<span className="text-ink-400 dark:text-ink-500 text-sm">
								/{item.max_score}
							</span>
						</div>
						{pct !== null && (
							<div className="text-xs text-ink-400 dark:text-ink-500">{pct}%</div>
						)}
					</div>
				)}
			</Link>
		</li>
	);
}

// ── 錯題本分頁(D4)─────────────────────────────────────────────────────
function WrongTab() {
	const [items, setItems] = useState<SmearWrongItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetchSmearWrong()
			.then((r) => {
				if (!cancelled) setItems(r.items);
			})
			.catch((e) => {
				if (cancelled) return;
				setItems([]);
				setError(e instanceof ApiError ? `讀取失敗 (${e.status})` : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const weakTopics = useMemo(() => [...new Set((items ?? []).map((it) => it.topic))], [items]);

	if (error) {
		return <p className="text-accent text-sm text-center py-10">讀取失敗:{error}</p>;
	}
	if (items === null) {
		return (
			<p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500 py-10">
				<Loader2 size={15} className="animate-spin" /> 載入中…
			</p>
		);
	}
	if (items.length === 0) {
		return (
			<p className="text-sm text-ink-400 dark:text-ink-500 text-center py-10">
				目前沒有需要加強的診斷,繼續保持!
			</p>
		);
	}

	return (
		<>
			{/* 錯題本只讓你看到「哪裡不熟」,這顆鈕把它接回一場真的能練的
			    練習 —— 只勾這幾個主題,不必回練習分頁重新手動勾選。 */}
			<button
				type="button"
				onClick={() => setDialogOpen(true)}
				className="w-full mb-4 px-4 py-2.5 text-sm rounded-lg border border-dashed border-accent text-accent hover:bg-accent/5 transition"
			>
				針對這 {weakTopics.length} 個主題再練一次
			</button>
			<ul className="space-y-2">
				{items.map((it) => (
					<li key={it.dx_id}>
						<Link
							to={`/smear/dx/${it.dx_id}`}
							className="flex items-center justify-between gap-3 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-3 hover:border-accent transition"
						>
							<div className="min-w-0">
								<p className="text-ink-900 dark:text-ink-100 break-words">
									{it.canonical_long}
								</p>
								<div className="flex flex-wrap items-center gap-1.5 mt-1.5">
									<span className="text-[11px] px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300">
										{SMEAR_TOPIC_LABELS[it.topic] ?? it.topic}
									</span>
									{it.last_wrong_at && (
										<span className="text-[11px] text-ink-400 dark:text-ink-500">
											最近一次:
											{new Date(it.last_wrong_at).toLocaleDateString("zh-TW")}
										</span>
									)}
								</div>
							</div>
							<div className="shrink-0 text-right">
								<div className="font-mono text-base text-ink-900 dark:text-ink-100 tabular-nums">
									{it.wrong_count}
								</div>
								<div className="text-[11px] text-ink-400 dark:text-ink-500">
									次答錯
								</div>
							</div>
						</Link>
					</li>
				))}
			</ul>
			{dialogOpen && (
				<StartDialog
					initialMode="review"
					initialTopics={weakTopics}
					onClose={() => setDialogOpen(false)}
				/>
			)}
		</>
	);
}

const SEARCH_DEBOUNCE_MS = 250;

// D6:獨立索引,**不**打 /api/search(MCQ 那支)——見 worker/routes/smear.ts
// 的 GET /search 與 CLAUDE.md「搜尋完全獨立,不跟 MCQ 共用端點」的設計判斷。
// debounce 節奏抄 LectureSearchBox.tsx:同一支元件已經解決過「race-safe」
// (查詢/scope 變了就丟棄舊 fetch 的結果)這個問題,這裡是同一個形狀。
function SearchTab() {
	const [q, setQ] = useState("");
	const [hits, setHits] = useState<SmearSearchHit[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const trimmed = q.trim();

	useEffect(() => {
		if (!trimmed) {
			setHits(null);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		setError(null);
		let alive = true;
		const t = window.setTimeout(async () => {
			try {
				const r = await searchSmear(trimmed);
				if (alive) setHits(r.items);
			} catch (e: any) {
				if (alive) {
					setHits([]);
					setError(e?.message || "搜尋失敗");
				}
			} finally {
				if (alive) setLoading(false);
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			alive = false;
			window.clearTimeout(t);
		};
	}, [trimmed]);

	return (
		<div>
			<div className="relative">
				<SearchIcon
					size={15}
					className={
						"absolute left-3 top-1/2 -translate-y-1/2 " +
						(loading ? "text-accent animate-pulse" : "text-ink-400 dark:text-ink-500")
					}
					aria-hidden="true"
				/>
				<input
					type="search"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="搜尋診斷名稱、細胞名稱…"
					aria-label="搜尋抹片診斷"
					className="w-full pl-9 pr-3 py-2.5 border border-ink-200 dark:border-ink-700 rounded text-base focus:outline-none focus:border-accent bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100"
				/>
			</div>

			<div className="mt-4">
				{!trimmed ? (
					<p className="text-sm text-ink-400 dark:text-ink-500 text-center py-10">
						輸入關鍵字開始搜尋診斷。
					</p>
				) : error ? (
					<p className="text-sm text-accent text-center py-10">
						搜尋失敗:{error}
					</p>
				) : loading && hits === null ? (
					<p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500 py-10">
						<Loader2 size={15} className="animate-spin" /> 搜尋中…
					</p>
				) : hits && hits.length === 0 ? (
					<p className="text-sm text-ink-400 dark:text-ink-500 text-center py-10">
						沒有符合的診斷。
					</p>
				) : (
					<ul className="space-y-2">
						{(hits ?? []).map((h) => (
							<li key={h.dx_id}>
								<Link
									to={`/smear/dx/${h.dx_id}`}
									className="block bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-3 hover:border-accent transition"
								>
									<p className="text-ink-900 dark:text-ink-100 break-words">
										{h.canonical_long}
									</p>
									<div className="flex flex-wrap gap-1.5 mt-1.5">
										<span className="text-[11px] px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300">
											{SMEAR_TOPIC_LABELS[h.topic] ?? h.topic}
										</span>
										<span className="text-[11px] px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300">
											{SMEAR_QTYPE_LABELS[h.qtype] ?? h.qtype}
										</span>
									</div>
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

// ── 已收藏分頁 ── GET /api/smear/bookmarks，worst-first 沒有意義（這裡沒有
// 「答錯次數」這種排序依據），沿用後端本來就給的 created_at DESC（最近收藏
// 的排前面）。
function BookmarkTab() {
	const [items, setItems] = useState<SmearBookmarkItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 移除中的 dx_id 集合 —— 樂觀從清單拿掉，失敗放回去。
	const [removing, setRemoving] = useState<Record<string, boolean>>({});

	useEffect(() => {
		let cancelled = false;
		fetchSmearBookmarks()
			.then((r) => {
				if (!cancelled) setItems(r.items);
			})
			.catch((e) => {
				if (cancelled) return;
				setItems([]);
				setError(e instanceof ApiError ? `讀取失敗 (${e.status})` : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function remove(dxId: string) {
		setRemoving((r) => ({ ...r, [dxId]: true }));
		const prev = items;
		setItems((cur) => (cur ?? []).filter((it) => it.dx_id !== dxId));
		try {
			await unbookmarkSmearDx(dxId);
		} catch {
			setItems(prev);
		} finally {
			setRemoving((r) => {
				const next = { ...r };
				delete next[dxId];
				return next;
			});
		}
	}

	if (error) {
		return <p className="text-accent text-sm text-center py-10">讀取失敗：{error}</p>;
	}
	if (items === null) {
		return (
			<p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500 py-10">
				<Loader2 size={15} className="animate-spin" /> 載入中…
			</p>
		);
	}
	if (items.length === 0) {
		return (
			<p className="text-sm text-ink-400 dark:text-ink-500 text-center py-10">
				還沒有收藏任何診斷 —— 在診斷詳情頁點右上角的書籤圖示就能收藏。
			</p>
		);
	}

	return (
		<ul className="space-y-2">
			{items.map((it) => (
				<li
					key={it.dx_id}
					className="relative flex items-center gap-3 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg pl-4 pr-2 py-3 hover:border-accent transition"
				>
					<Link to={`/smear/dx/${it.dx_id}`} className="min-w-0 flex-1">
						<p className="text-ink-900 dark:text-ink-100 break-words">
							{it.canonical_long}
							{it.canonical_abbrev && (
								<span className="ml-1.5 text-ink-500 dark:text-ink-400">
									({it.canonical_abbrev})
								</span>
							)}
						</p>
						<div className="flex flex-wrap gap-1.5 mt-1.5">
							<span className="text-[11px] px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300">
								{SMEAR_TOPIC_LABELS[it.topic] ?? it.topic}
							</span>
							<span className="text-[11px] px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-700 text-ink-600 dark:text-ink-300">
								{SMEAR_QTYPE_LABELS[it.qtype] ?? it.qtype}
							</span>
						</div>
					</Link>
					<button
						type="button"
						onClick={() => remove(it.dx_id)}
						disabled={!!removing[it.dx_id]}
						aria-label={`取消收藏 ${it.canonical_long}`}
						title="取消收藏"
						className="shrink-0 p-2 rounded text-accent hover:bg-ink-100 dark:hover:bg-ink-700 disabled:opacity-40 transition"
					>
						<Bookmark size={18} fill="currentColor" />
					</button>
				</li>
			))}
		</ul>
	);
}
