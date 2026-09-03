import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchYears } from "../lib/yearsApi";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { GROUPS } from "../lib/groups";

// 自訂測驗產生器 — 對標 UWorld / AMBOSS 的 "create test"。
// 產生的是一場貨真價實的 exam session(POST /api/exam/custom),之後全部
// 走既有的 /exam/:sid 作答流程,這一頁只負責組條件。

type YearMeta = { year: number; count: number };
type TagMeta = { tag: string; count: number };

type Status = "unseen" | "wrong" | "correct" | "bookmarked";

const STATUS_OPTIONS: { key: Status; label: string; hint: string }[] = [
	{ key: "unseen", label: "未做過", hint: "沒有任何作答紀錄" },
	{ key: "wrong", label: "最近答錯", hint: "最近一次作答答錯的題目" },
	{ key: "bookmarked", label: "已收藏", hint: "加進收藏夾的題目" },
	{ key: "correct", label: "曾答對", hint: "至少答對過一次" },
];

type Preview = { available: number; requested: number; will_use: number };

// POST /api/exam/custom 的回傳與 /start 同形(多帶 kind/tutor/timed 與
// requested/actual),整包直接塞進 sessionStorage 給 /exam/:sid 當首屏快取。
type BuildResult = {
	session_id: string;
	started_at: number;
	elapsed_ms: number;
	running_since: number | null;
	cap_ms: number;
	kind: "custom";
	tutor: 0 | 1;
	timed: 0 | 1;
	requested: number;
	actual: number;
	questions: {
		id: string;
		year: number;
		number: number;
		stem: string;
		options: Record<string, string>;
	}[];
};

const TAGS_COLLAPSED = 30;

export function CustomTest() {
	const navigate = useNavigate();
	const [sp] = useSearchParams();

	// 從錯題頁等入口帶進來的預填條件(?status=&year=&group=&tags=)。
	const [status, setStatus] = useState<Set<Status>>(() => {
		const raw = sp.get("status");
		const wanted = raw ? raw.split(",") : [];
		const valid = wanted.filter((s): s is Status =>
			STATUS_OPTIONS.some((o) => o.key === s),
		);
		return new Set(valid);
	});
	const [years, setYears] = useState<Set<number>>(() => {
		const y = Number(sp.get("year"));
		return Number.isFinite(y) && y > 0 ? new Set([y]) : new Set();
	});
	const [groups, setGroups] = useState<Set<string>>(() => {
		const g = sp.get("group");
		return g ? new Set([g]) : new Set();
	});
	const [tags, setTags] = useState<Set<string>>(() => {
		const t = sp.get("tags");
		return t ? new Set(t.split(",").filter(Boolean)) : new Set();
	});
	// 明確題號清單。搜尋結果「把這些出成一份測驗」帶進來的 —— 那一頁的條件是
	// 全文檢索,沒有辦法用 status/year/group/tag 表達,只能把結果本身送過來。
	//
	// **它跟畫面上那些條件是 AND**(伺服器那側也是),所以「從這批搜尋結果裡,
	// 只出我答錯的那些」直接勾一下就有 —— 不需要為它另外做一個模式。
	const [ids, setIds] = useState<string[]>(() => {
		const raw = sp.get("ids");
		return raw
			? raw
					.split(",")
					.map((x) => x.trim())
					.filter(Boolean)
			: [];
	});
	const [count, setCount] = useState(20);
	const [timed, setTimed] = useState(true);
	const [tutor, setTutor] = useState(false);

	const [yearMeta, setYearMeta] = useState<YearMeta[]>([]);
	const [tagMeta, setTagMeta] = useState<TagMeta[]>([]);
	const [showAllTags, setShowAllTags] = useState(false);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetchYears()
			.then(setYearMeta)
			.catch(() => {});
		api
			.get<TagMeta[]>("/api/questions/_meta/tags")
			.then(setTagMeta)
			.catch(() => {});
	}, []);

	const filters = useMemo(
		() => ({
			status: [...status],
			years: [...years],
			groups: [...groups],
			tags: [...tags],
			ids,
			count,
		}),
		[status, years, groups, tags, ids, count],
	);

	// 即時題數:條件變動後 debounce 300ms 打一次 preview。用 AbortController
	// 取消過期請求,避免慢的舊回應蓋掉新的數字。
	useEffect(() => {
		const ctrl = new AbortController();
		const t = window.setTimeout(async () => {
			setPreviewing(true);
			try {
				const res = await fetch("/api/exam/custom/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					credentials: "include",
					body: JSON.stringify(filters),
					signal: ctrl.signal,
				});
				if (!res.ok) throw new Error(String(res.status));
				setPreview((await res.json()) as Preview);
			} catch (e) {
				if ((e as Error).name !== "AbortError") setPreview(null);
			} finally {
				if (!ctrl.signal.aborted) setPreviewing(false);
			}
		}, 300);
		return () => {
			window.clearTimeout(t);
			ctrl.abort();
		};
	}, [filters]);

	const toggle = useCallback(function <T>(set: Set<T>, v: T): Set<T> {
		const next = new Set(set);
		if (next.has(v)) next.delete(v);
		else next.add(v);
		return next;
	}, []);

	const available = preview?.available ?? null;
	const canStart = available !== null && available > 0 && !starting;

	async function start() {
		if (!canStart) return;
		setStarting(true);
		setError(null);
		try {
			const s = await api.post<BuildResult>("/api/exam/custom", {
				...filters,
				tutor,
				timed,
			});
			sessionStorage.setItem(`exam-${s.session_id}`, JSON.stringify(s));
			navigate(`/exam/${s.session_id}`);
		} catch {
			setError("建立測驗失敗,請稍後再試或放寬條件。");
			setStarting(false);
		}
	}

	const visibleTags = showAllTags ? tagMeta : tagMeta.slice(0, TAGS_COLLAPSED);

	return (
		<div className="max-w-3xl md:max-w-4xl mx-auto px-4 sm:px-6 py-8 pb-40">
			<h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-2">
				自訂測驗
			</h1>
			<p className="text-ink-500 dark:text-ink-400 text-sm mb-8">
				挑狀態、範圍與題數,自己出一份卷 · 完成後一樣進作答紀錄
			</p>

			{/* 帶著明確題號進來(搜尋結果)時要講清楚,否則畫面上的條件看起來像全題庫,
          而算出來的題數卻只有幾十題 —— 那個落差沒有任何地方解釋得了。
          給一顆「改用全題庫」而不是把它做成唯讀:使用者可能只是想借用這一頁的
          其他條件。 */}
			{ids.length > 0 && (
				<div className="mb-7 flex flex-wrap items-center gap-3 rounded border border-accent/40 bg-accent/5 px-4 py-3 text-sm">
					<span className="text-ink-700 dark:text-ink-200">
						只從
						<strong className="text-ink-900 dark:text-ink-100">
							{" "}
							搜尋結果的 {ids.length} 題{" "}
						</strong>
						裡出卷,底下的條件會再篩一次。
					</span>
					<button
						type="button"
						onClick={() => setIds([])}
						className="ml-auto text-xs text-ink-500 dark:text-ink-400 hover:text-accent underline"
					>
						改用全題庫
					</button>
				</div>
			)}

			{/* 1 — 題目狀態 */}
			<Section title="題目狀態" hint="可複選,多選是「聯集」;全不選 = 不限">
				<div className="flex flex-wrap gap-2">
					{STATUS_OPTIONS.map((o) => (
						<Chip
							key={o.key}
							active={status.has(o.key)}
							onClick={() => setStatus((s) => toggle(s, o.key))}
							title={o.hint}
						>
							{o.label}
						</Chip>
					))}
				</div>
			</Section>

			{/* 2 — 範圍 */}
			<Section title="年度" hint="不選 = 所有年度">
				<div className="flex flex-wrap gap-2">
					{yearMeta.map((y) => (
						<Chip
							key={y.year}
							active={years.has(y.year)}
							onClick={() => setYears((s) => toggle(s, y.year))}
						>
							{y.year}
							{y.year === 100 && (
								<span className="opacity-60 ml-1">(模擬)</span>
							)}
						</Chip>
					))}
				</div>
			</Section>

			<Section title="科別" hint="不選 = 所有科別">
				<div className="flex flex-wrap gap-2">
					{GROUPS.map((g) => (
						<Chip
							key={g.label}
							active={groups.has(g.label)}
							onClick={() => setGroups((s) => toggle(s, g.label))}
						>
							{g.label}
						</Chip>
					))}
				</div>
			</Section>

			{tagMeta.length > 0 && (
				<Section title="主題 tag" hint="多選是「或」,只要命中任一個 tag 就算">
					<div className="flex flex-wrap gap-1.5">
						{visibleTags.map((t) => {
							const on = tags.has(t.tag);
							return (
								<button
									key={t.tag}
									type="button"
									onClick={() => setTags((s) => toggle(s, t.tag))}
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
						{tagMeta.length > TAGS_COLLAPSED && (
							<button
								type="button"
								onClick={() => setShowAllTags((v) => !v)}
								className="text-[11px] px-2 py-0.5 text-accent hover:text-accent-dark"
							>
								{showAllTags
									? "收合"
									: `更多 (${tagMeta.length - TAGS_COLLAPSED})`}
							</button>
						)}
					</div>
				</Section>
			)}

			{/* 3 — 題數 */}
			<Section title="題數">
				<div className="flex items-center gap-4">
					<input
						type="range"
						min={1}
						max={100}
						value={count}
						onChange={(e) => setCount(Number(e.target.value))}
						className="flex-1 accent-accent"
						aria-label="題數"
					/>
					<span className="font-mono text-lg text-ink-900 dark:text-ink-100 w-12 text-right">
						{count}
					</span>
				</div>
			</Section>

			{/* 4 — 模式 */}
			<Section title="模式">
				<div className="grid sm:grid-cols-2 gap-3">
					<ModeCard
						active={timed}
						onClick={() => setTimed(true)}
						label="計時"
						desc="每題 1 分鐘,倒數歸零自動交卷"
					/>
					<ModeCard
						active={!timed}
						onClick={() => setTimed(false)}
						label="不計時"
						desc="碼表往上跑,不會自動交卷"
					/>
					<ModeCard
						active={!tutor}
						onClick={() => setTutor(false)}
						label="考試模式"
						desc="全程不揭曉,交卷後才看答案"
					/>
					<ModeCard
						active={tutor}
						onClick={() => setTutor(true)}
						label="教學模式"
						desc="每題作答後立刻看答案與詳解,不可改答"
					/>
				</div>
			</Section>

			{error && (
				<p className="text-rose-700 dark:text-rose-300 text-sm mb-4">{error}</p>
			)}

			{/* 即時題數 + 開始 */}
			<div className="fixed bottom-0 inset-x-0 bg-white dark:bg-ink-800 border-t border-ink-200 dark:border-ink-700 px-4 sm:px-6 py-3">
				<div className="max-w-3xl md:max-w-4xl mx-auto flex items-center justify-between gap-4">
					<div className="text-sm text-ink-600 dark:text-ink-300 min-w-0">
						{available === null ? (
							<span className="text-ink-400 dark:text-ink-500">
								{previewing ? "計算中…" : "無法取得符合題數"}
							</span>
						) : available === 0 ? (
							<span className="text-rose-700 dark:text-rose-300">
								沒有題目符合這組條件,請放寬篩選。
							</span>
						) : available < count ? (
							<>
								只找到{" "}
								<strong className="font-mono text-ink-900 dark:text-ink-100">
									{available}
								</strong>{" "}
								題符合,將出 {available} 題
							</>
						) : (
							<>
								符合{" "}
								<strong className="font-mono text-ink-900 dark:text-ink-100">
									{available}
								</strong>{" "}
								題 · 本次出 {count} 題
							</>
						)}
					</div>
					<button
						onClick={start}
						disabled={!canStart}
						className="bg-accent hover:bg-accent-dark text-white px-6 py-2 rounded font-medium disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
					>
						{starting ? "產生中…" : "開始測驗"}
					</button>
				</div>
			</div>

			<div className="mt-4">
				<Link to="/exam" className="text-sm text-accent hover:text-accent-dark">
					← 回到全真作答
				</Link>
			</div>
		</div>
	);
}

function Section({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="mb-7">
			<div className="flex items-baseline gap-3 mb-2.5 flex-wrap">
				<h2 className="text-xs uppercase tracking-wider text-ink-400 dark:text-ink-500">
					{title}
				</h2>
				{hint && (
					<span className="text-[11px] text-ink-400 dark:text-ink-500">
						{hint}
					</span>
				)}
			</div>
			{children}
		</section>
	);
}

function Chip({
	active,
	onClick,
	title,
	children,
}: {
	active: boolean;
	onClick: () => void;
	title?: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			title={title}
			className={
				"inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition " +
				(active
					? "bg-accent/10 border-accent text-accent-dark dark:text-accent font-medium"
					: "bg-white dark:bg-ink-800 border-ink-200 dark:border-ink-700 text-ink-500 dark:text-ink-400 hover:border-ink-400")
			}
		>
			<span
				className={
					"inline-block w-2 h-2 rounded-full " +
					(active ? "bg-accent" : "bg-ink-300 dark:bg-ink-600")
				}
			/>
			{children}
		</button>
	);
}

function ModeCard({
	active,
	onClick,
	label,
	desc,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
	desc: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={
				"text-left rounded-lg border p-3 transition " +
				(active
					? "border-accent bg-accent/5"
					: "bg-white dark:bg-ink-800 border-ink-200 dark:border-ink-700 hover:border-ink-400")
			}
		>
			<div className="text-sm font-medium text-ink-900 dark:text-ink-100">
				{label}
			</div>
			<div className="text-xs text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">
				{desc}
			</div>
		</button>
	);
}
