import { useEffect, useState } from "react";
import { ChevronDown, ListChecks } from "lucide-react";

const STORAGE_KEY = "smear-reading-framework-open";

function loadOpen(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

function saveOpen(v: boolean) {
	try {
		localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
	} catch {
		// localStorage 不可用(隱私模式等)—— 不影響功能,只是不記住開關狀態。
	}
}

interface Framework {
	title: string;
	steps: string[];
}

// 三種骨架,逐字對齊 CLAUDE.md「詳解:寫『怎麼判讀』,不是寫『答案是什麼』」
// 那節定義的骨架 —— 詳解共筆與這裡刻意用同一套語彙,使用者在作答當下看到的
// 框架,跟答完之後在 SmearDxPanel 詳解裡讀到的「怎麼認」段落是同一件事,不是
// 另外發明一套。
function frameworkFor(qtype: string, topic: string): Framework {
	if (qtype === "disease") {
		return {
			title: "疾病診斷:三步驟",
			steps: [
				"哪一群細胞異常?(紅血球系 / 白血球系 / 血小板系)",
				"異常在哪一個成熟階段?(原始 / 前驅 / 成熟)",
				"背景有沒有伴隨變化?(其他細胞系是否也受影響)",
			],
		};
	}
	if (topic === "rbc") {
		return {
			title: "紅血球形態:五個觀察點",
			steps: ["形狀", "大小", "中央淡染區", "內含物", "分佈(單一或成群)"],
		};
	}
	return {
		title: "細胞辨識:五個觀察點",
		steps: ["大小", "核質比", "核形與染色質", "核仁", "胞質顆粒與嗜鹼性"],
	};
}

/**
 * 作答當下的通用判讀骨架 —— **不含任何診斷專屬資訊**,純粹是「看這張圖時
 * 依序該注意什麼」,所以複習/全真兩種模式都能安全顯示,不會觸犯「全真模式
 * 全程不揭曉」那條規則(CLAUDE.md、worker/routes/smear.ts 的 revealGrade)。
 *
 * 預設收合、狀態存 localStorage —— 熟手不需要每題都看到一塊佔位的框,但一旦
 * 打開過,大概率整場都想留著用,不必每題重新展開一次。
 */
export function ReadingFramework({ qtype, topic }: { qtype: string; topic: string }) {
	const [open, setOpen] = useState(loadOpen);
	const fw = frameworkFor(qtype, topic);

	useEffect(() => {
		saveOpen(open);
	}, [open]);

	return (
		<div className="mt-3 border border-ink-100 dark:border-ink-700 rounded-lg overflow-hidden">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition"
			>
				<span className="inline-flex items-center gap-1.5">
					<ListChecks size={14} className="text-accent" aria-hidden="true" />
					怎麼判讀?
				</span>
				<ChevronDown
					size={15}
					className={"transition-transform " + (open ? "rotate-180" : "")}
					aria-hidden="true"
				/>
			</button>
			{open && (
				<div className="animate-fade-in px-4 pb-3 pt-1">
					<p className="text-xs text-ink-400 dark:text-ink-500 mb-1.5">{fw.title}</p>
					<ol className="space-y-1 text-sm text-ink-600 dark:text-ink-300 list-decimal list-inside">
						{fw.steps.map((s, i) => (
							<li key={i}>{s}</li>
						))}
					</ol>
				</div>
			)}
		</div>
	);
}
