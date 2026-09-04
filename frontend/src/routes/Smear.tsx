import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { KeepAlive } from "../components/KeepAlive";
import { StartDialog } from "../components/smear/StartDialog";
import type { SmearMode } from "../lib/smearApi";

// /smear —— 4 個分頁,同 /lectures 的 `?tab=` 慣例(可分享、可加書籤、返回時
// 回到原本的分頁)。這一支只有「練習」分頁有真內容,其餘三個是最小佔位,留給
// 之後的任務填。分頁內容一律 KeepAlive 包住(同 /q/:id),切分頁不重掛、不
// 丟失捲動位置或表單狀態 —— 即使目前佔位分頁還沒有值得保留的狀態,先接上這個
// 慣例,之後補內容時不必回頭改接線方式。

type SmearTab = "practice" | "history" | "wrong" | "search";

const TABS: SmearTab[] = ["practice", "history", "wrong", "search"];

const TAB_TITLE: Record<SmearTab, string> = {
	practice: "練習",
	history: "作答記錄",
	wrong: "錯題本",
	search: "搜尋",
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
					<PracticeTab />
				</KeepAlive>
				<KeepAlive active={tab === "history"}>
					<Placeholder text="作答記錄即將推出。" />
				</KeepAlive>
				<KeepAlive active={tab === "wrong"}>
					<Placeholder text="錯題本即將推出。" />
				</KeepAlive>
				<KeepAlive active={tab === "search"}>
					<Placeholder text="搜尋即將推出。" />
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
function PracticeTab() {
	const [dialogMode, setDialogMode] = useState<SmearMode | null>(null);

	return (
		<div className="space-y-4">
			<ModeCard
				title="複習模式"
				desc="看一張抹片,寫出診斷。每題作答後立刻看判定、可接受寫法與詳解 —— 適合平常累積。"
				onClick={() => setDialogMode("review")}
			/>
			<ModeCard
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

function ModeCard({
	title,
	desc,
	onClick,
}: {
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
			<h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
				{title}
			</h2>
			<p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
				{desc}
			</p>
		</button>
	);
}

function Placeholder({ text }: { text: string }) {
	return (
		<div className="text-center py-16 text-ink-400 dark:text-ink-500 text-sm">
			{text}
		</div>
	);
}
