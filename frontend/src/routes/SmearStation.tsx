import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Microscope, CheckCircle2, Circle } from "lucide-react";
import {
	listStationCases,
	SMEAR_MODALITY_LABELS,
	type SmearStationCaseRow,
} from "../lib/smearApi";

/**
 * 跑台清單。設計:docs/plans/2026-09-09-smear-station-design.md
 *
 * ⚠️ 卡片上顯示的是**病史第一行**,不是投影片標題。原始標題是
 * 'Case 3: ALL vs. FL?' —— 它含答案,所以資料庫裡根本沒有那個欄位。
 */
export function SmearStation() {
	const [rows, setRows] = useState<SmearStationCaseRow[] | null>(null);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		listStationCases()
			.then((r) => setRows(r.cases ?? []))
			.catch((e) => setErr(String(e)));
	}, []);

	return (
		<div className="max-w-3xl mx-auto px-4 py-6">
			<header className="mb-5">
				<h1 className="text-xl font-semibold flex items-center gap-2">
					<Microscope size={20} className="text-accent dark:text-accent-light" />
					跑台
				</h1>
				<p className="mt-2 text-sm text-ink-600 dark:text-ink-300 leading-relaxed">
					一個病人、一組片子。先讀臨床病史,再一張一張看下去,每一張都寫下你看到什麼。
					<strong className="font-semibold"> 中途不會告訴你對不對</strong> —— 下完診斷才一次
					攤開全部說明,跟你當初寫的並排。
				</p>
			</header>

			{err && <p className="text-sm text-accent dark:text-accent-light">載入失敗:{err}</p>}
			{rows === null && !err && <p className="text-sm text-ink-500">載入中…</p>}
			{rows?.length === 0 && (
				<p className="text-sm text-ink-500">還沒有案例。跑 `scripts/smear/import_cases.ts` 匯入。</p>
			)}

			<ul className="grid gap-3 sm:grid-cols-2">
				{(rows ?? []).map((r) => (
					<li key={r.id}>
						<Link
							to={`/smear/station/${encodeURIComponent(r.id)}`}
							className="block h-full rounded-lg border border-ink-200 dark:border-ink-700 p-4
                         hover:border-accent dark:hover:border-accent-light transition-colors
                         eink:border-2"
						>
							<div className="flex items-start justify-between gap-2">
								<span className="text-xs uppercase tracking-wide text-ink-500">
									{r.source === "kfs" ? "和信教學片" : "ASH"}
								</span>
								{r.my_attempts > 0 ? (
									<CheckCircle2 size={16} className="shrink-0 text-accent dark:text-accent-light" />
								) : (
									<Circle size={16} className="shrink-0 text-ink-300" />
								)}
							</div>
							<p className="mt-1 text-sm text-ink-800 dark:text-ink-100 line-clamp-3 min-w-0 break-words">
								{r.teaser ?? "（沒有病史摘要）"}
							</p>
							<p className="mt-2 text-xs text-ink-500">
								{r.steps} 張
								{r.modalities.length > 0 && (
									<>
										{" · "}
										{r.modalities
											.map((m) => SMEAR_MODALITY_LABELS[m] ?? m)
											.join(" / ")}
									</>
								)}
								{r.my_attempts > 0 && ` · 跑過 ${r.my_attempts} 次`}
							</p>
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}
