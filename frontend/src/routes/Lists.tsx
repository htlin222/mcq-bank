import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { X as XIcon } from "lucide-react";
import { api } from "../lib/api";
import { AnswerOptions } from "../components/AnswerOptions";
import { AnswerVerdict } from "../components/AnswerVerdict";
import { type QuestionListRow, rowTitle } from "../lib/questionRow";
import { BookmarkBadge } from "../components/BookmarkBadge";
import { ExplanationPeek } from "../components/ExplanationPeek";
import { QuestionRowActions } from "../components/QuestionRowActions";
import { GROUPS, groupBadgeClass } from "../lib/groups";
import { ExportButton } from "../components/ExportDialog";
import type { ExportScope } from "../lib/export-scope";
import {
	DEFAULT_WRONG_SORT,
	WRONG_SORT_LABELS,
	type WrongSort,
} from "../lib/wrongSort";

type Row = QuestionListRow & {
	times_correct?: number;
};

type Year = { year: number; count: number };
type Tag = { tag: string; count: number };

export function WrongQuestions() {
	const [year, setYear] = useState("");
	const [group, setGroup] = useState("");
	const [tagSet, setTagSet] = useState<Set<string>>(new Set());
	const [sort, setSort] = useState<WrongSort>(DEFAULT_WRONG_SORT);
	const [rows, setRows] = useState<Row[] | null>(null);
	const [years, setYears] = useState<Year[]>([]);
	const [allTags, setAllTags] = useState<Tag[]>([]);
	// 全部展開/收合。切換之後每一題仍然可以單獨開關 —— 這顆只是把所有卡片推到
	// 同一個狀態,不是把個別的開關鎖住(同成績頁)。
	const [expandAll, setExpandAll] = useState(false);
	// 「查看詳解」開起來的那一題。存 id + 稱呼而不是整列 —— 對話框只需要這兩個。
	const [peek, setPeek] = useState<{ id: string; title: string } | null>(null);

	useEffect(() => {
		api.get<Year[]>("/api/questions/_meta/years").then(setYears);
		api.get<Tag[]>("/api/questions/_meta/tags").then(setAllTags);
	}, []);

	const query = useMemo(() => {
		const sp = new URLSearchParams();
		if (year) sp.set("year", year);
		if (group) sp.set("group", group);
		if (tagSet.size > 0) sp.set("tags", [...tagSet].join(","));
		// 預設不寫進 query string —— 少一個參數,分享出去的網址也少一個會過期的東西。
		if (sort !== DEFAULT_WRONG_SORT) sp.set("sort", sort);
		return sp.toString();
	}, [year, group, tagSet, sort]);

	useEffect(() => {
		setRows(null);
		api
			.get<Row[]>(`/api/review/wrong${query ? "?" + query : ""}`)
			.then(setRows);
	}, [query]);

	// 匯出範圍跟著畫面上的 filter 走。
	const wrongScope: ExportScope = useMemo(() => {
		const s: ExportScope = { kind: "wrong" };
		if (year) s.year = Number(year);
		if (group) s.group = group;
		if (tagSet.size > 0) s.tags = [...tagSet];
		return s;
	}, [year, group, tagSet]);

	function toggleTag(t: string) {
		setTagSet((prev) => {
			const next = new Set(prev);
			if (next.has(t)) next.delete(t);
			else next.add(t);
			return next;
		});
	}

	return (
		<div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
			<div className="flex items-center justify-between gap-4 mb-4">
				<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100">
					錯題回顧
				</h1>
				<ExportButton scope={wrongScope} />
			</div>
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-6">
				<p className="text-sm text-ink-500 dark:text-ink-400">
					最近一次作答答錯的題目,{WRONG_SORT_LABELS[sort]}。
				</p>
				{/* 帶著當前 filter 進出卷頁,status 預設勾「最近答錯」—— 判準跟這份清單共用
            同一個定義(worker/lib/wrong-criterion.ts),所以出來的就是畫面上這些。 */}
				<Link
					to={`/exam/new?status=wrong${query ? "&" + query : ""}`}
					className="text-sm text-accent hover:text-accent-dark"
				>
					把這些出成一份測驗 →
				</Link>
			</div>

			<div className="flex flex-wrap gap-2 mb-3 items-center text-sm">
				<select
					value={year}
					onChange={(e) => setYear(e.target.value)}
					className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
				>
					<option value="">所有年度</option>
					{years.map((y) => (
						<option key={y.year} value={y.year}>
							民國 {y.year}
							{y.year === 100 ? " (模擬)" : ""}
						</option>
					))}
				</select>
				<select
					value={group}
					onChange={(e) => setGroup(e.target.value)}
					className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
				>
					<option value="">所有 group</option>
					{GROUPS.map((g) => (
						<option key={g.label} value={g.label}>
							{g.label}
						</option>
					))}
				</select>
				{/* 排序。清單一次最多 200 列,而排序決定的是「哪 200 列」—— 不只是
            順序,所以它跟上面兩個 filter 放在同一列。 */}
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value as WrongSort)}
					aria-label="排序方式"
					className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
				>
					{(Object.keys(WRONG_SORT_LABELS) as WrongSort[]).map((k) => (
						<option key={k} value={k}>
							{WRONG_SORT_LABELS[k]}
						</option>
					))}
				</select>
				{/* 「展開全部選項」推到最右,同成績頁。`flex-wrap` 已經在外層,窄螢幕
            會自己折行。 */}
				<button
					type="button"
					onClick={() => setExpandAll((v) => !v)}
					aria-pressed={expandAll}
					className="ml-auto px-3 py-1.5 rounded border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-ink-400 dark:hover:border-ink-500 transition"
				>
					{expandAll ? "收合全部選項" : "展開全部選項"}
				</button>
				{tagSet.size > 0 && (
					<button
						onClick={() => setTagSet(new Set())}
						className="text-xs text-ink-500 dark:text-ink-400 hover:text-rose-600 dark:hover:text-rose-400 inline-flex items-center gap-1"
					>
						<XIcon size={12} /> 清除 {tagSet.size} 個 tag
					</button>
				)}
			</div>

			{allTags.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mb-6">
					{allTags.slice(0, 40).map((t) => {
						const on = tagSet.has(t.tag);
						return (
							<button
								key={t.tag}
								onClick={() => toggleTag(t.tag)}
								className={
									"text-[11px] px-2 py-0.5 rounded transition " +
									(on
										? "bg-accent text-white"
										: "bg-ink-100 dark:bg-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-200")
								}
							>
								#{t.tag} <span className="opacity-60">{t.count}</span>
							</button>
						);
					})}
				</div>
			)}

			{rows === null ? (
				<div className="text-ink-400 dark:text-ink-500 text-sm">載入中…</div>
			) : rows.length === 0 ? (
				<p className="text-ink-400 dark:text-ink-500 text-sm">
					目前還沒有錯題紀錄 (在這個 filter 下)。
				</p>
			) : (
				<ul className="space-y-2">
					{rows.map((r) => (
						<li key={r.id}>
							{/* `relative group` 是 QuestionRowActions 的前提(理由寫在那個檔)。
                  **只包整列連結,不包 AnswerOptions** —— 否則絕對定位的基準會
                  變成「連同展開的選項」那一整塊,按鈕會飄在很下面。 */}
							<div className="relative group">
								<Link
									to={`/q/${r.id}`}
									// `pr-28` 是替右上角那兩顆浮起來的動作鈕留位子。成績頁不必留
									// (那一列右側本來就空著),這裡的右邊卻放著 group badge 與
									// 「答對/作答」次數 —— 不留位子的話,hover 時它們會被蓋掉,而
									// 那是這份清單上唯二的數字。
									className="flex gap-3 items-start bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 pr-28 hover:border-accent hover:shadow-paper transition"
								>
									<span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0 w-16 text-right">
										{rowTitle(r)}
									</span>
									<BookmarkBadge questionId={r.id} className="mt-1" />
									{/* 題幹 + 「我上次選了什麼」。**這一行原本沒有**,而少了它,
                      「我當初錯在哪」得先展開選項才看得到 —— 成績頁那一列一眼
                      就講完了,這裡卻要多按一下。同一份資訊、同一種說法,
                      判準是 AnswerVerdict。 */}
									<span className="flex-1 min-w-0">
										<span className="block text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed">
											{r.stem}
										</span>
										{r.correct_answer && (
											<span className="block text-xs text-ink-500 dark:text-ink-400 mt-1">
												<AnswerVerdict
													chosen={r.last_chosen ?? null}
													correctAnswer={r.correct_answer}
													correct={false}
													seen={(r.times_seen ?? 0) > 0}
												/>
											</span>
										)}
									</span>
									{r.group && (
										<span
											className={
												"text-[11px] px-2 py-0.5 rounded shrink-0 self-center " +
												groupBadgeClass(r.group)
											}
										>
											{r.group}
										</span>
									)}
									{r.times_seen !== undefined &&
										r.times_correct !== undefined && (
											<span className="text-xs text-ink-500 dark:text-ink-400 shrink-0 self-center">
												{r.times_correct}/{r.times_seen}
											</span>
										)}
								</Link>
								<QuestionRowActions
									questionId={r.id}
									title={rowTitle(r)}
									onPeek={() => setPeek({ id: r.id, title: rowTitle(r) })}
								/>
							</div>
							{/* `correct_answer` 缺席時整塊不畫:少了正解,「✓ 正解」那一維就
                  沒有東西可講,展開只剩五行沒有語意的選項 —— 那比收著更糟。 */}
							{r.correct_answer && (
								<AnswerOptions
									questionId={r.id}
									options={r.options ?? {}}
									chosen={r.last_chosen ?? null}
									correctAnswer={r.correct_answer}
									expandAll={expandAll}
								/>
							)}
						</li>
					))}
				</ul>
			)}

			{peek && (
				<ExplanationPeek
					questionId={peek.id}
					label={peek.title}
					onClose={() => setPeek(null)}
				/>
			)}
		</div>
	);
}
