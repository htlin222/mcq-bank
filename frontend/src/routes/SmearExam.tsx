import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Timer } from "lucide-react";
import { StartDialog } from "../components/smear/StartDialog";

// /smear/exam —— 全真模式的獨立落地頁。跟 /smear/review 是同一套心智模型
// (路由 landing → 點按鈕開既有的 StartDialog),只是這裡沒有主題卡片 ——
// 全真模式照題庫實際比例抽樣、模擬真考卷,主題式挑選跟它的用途矛盾(見
// CLAUDE.md「抹片練習」設計:分層抽樣、PO 不進全真)。這一頁存在的理由
// 純粹是入口對稱:底部導覽/首頁抹片卡/練習分頁的「全真」都導來這裡,
// 跟「複習」一樣有一個可以分享、可以加書籤的網址,而不是直接彈一個
// 沒有網址的對話框(見 docs/plans/2026-09-05-smear-exam-parity-design.md
// 的 Layer 1)。
export function SmearExam() {
	const [dialogOpen, setDialogOpen] = useState(false);

	return (
		<div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 pb-20">
			<Link
				to="/smear"
				className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1 mb-4"
			>
				<ArrowLeft size={14} /> 回抹片練習
			</Link>

			<h1 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-1">
				全真模式
			</h1>
			<p className="text-ink-500 dark:text-ink-400 text-sm mb-6">
				連續作答,全程不揭曉正解;交卷後才看整體成績與逐題檢討 ——
				適合考前自我測驗,照題庫實際比例抽樣,不能挑主題。
			</p>

			<button
				type="button"
				onClick={() => setDialogOpen(true)}
				className="w-full text-left bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 shadow-paper hover:shadow-md hover:border-accent transition"
			>
				<div className="flex items-center gap-2">
					<Timer size={16} className="text-accent" aria-hidden="true" />
					<span className="font-medium text-ink-900 dark:text-ink-100">
						開始全真模式
					</span>
				</div>
				<p className="text-xs text-ink-500 dark:text-ink-400 mt-1">
					可調整題數與作答寫法
				</p>
			</button>

			{dialogOpen && (
				<StartDialog
					initialMode="exam"
					onClose={() => setDialogOpen(false)}
				/>
			)}
		</div>
	);
}
