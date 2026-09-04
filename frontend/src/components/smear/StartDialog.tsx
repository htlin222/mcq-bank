import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { X, Loader2, Microscope } from "lucide-react";
import { ApiError } from "../../lib/api";
import {
	fetchSmearMeta,
	createSmearSession,
	type SmearMeta,
	type SmearMode,
	type SmearForm,
} from "../../lib/smearApi";

// 開始抹片練習/全真的設定對話框 —— 同 ExportDialog 的「置中型」對話框結構
// (`.dialog-scrim` + `max-h-full` 的內層卡片,不是 `.dialog-sheet-*` 那組滿版
// sheet;見 CLAUDE.md「對話框的安全區」那節的分類)。不要用 vh 單位,原因同上。

const TOPIC_LABELS: Record<string, string> = {
	myeloid: "骨髓性",
	lymphoid: "淋巴性",
	normal_reactive: "正常 / 反應性",
	rbc: "紅血球系",
	platelet: "血小板 / 巨核系",
	infection: "感染相關",
	other: "其他",
};

const SOURCE_LABELS: Record<string, string> = {
	exam: "歷屆考題",
	ash: "ASH 影像庫",
};

const FORM_OPTIONS: { id: SmearForm; label: string; hint: string }[] = [
	{ id: "any", label: "任意寫法", hint: "全稱、縮寫皆可接受,適合平常練習" },
	{ id: "long", label: "只收全稱", hint: "縮寫不算對" },
	{ id: "abbrev", label: "只收縮寫", hint: "全稱不算對" },
];

const MIN_N = 5;
const MAX_N = 200;

export function StartDialog({
	initialMode,
	onClose,
}: {
	initialMode: SmearMode;
	onClose: () => void;
}) {
	const navigate = useNavigate();
	const [mode, setMode] = useState<SmearMode>(initialMode);
	const [n, setN] = useState(50);
	const [form, setForm] = useState<SmearForm>("any");

	const [meta, setMeta] = useState<SmearMeta | null>(null);
	const [metaError, setMetaError] = useState<string | null>(null);
	const [topics, setTopics] = useState<Set<string>>(new Set());
	const [sources, setSources] = useState<Set<string>>(
		() => new Set(["exam", "ash"]),
	);

	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	// 主題清單 + 當下比例一律來自 /meta,不寫死 —— 題庫的診斷分布會隨匯入變動。
	useEffect(() => {
		let cancelled = false;
		fetchSmearMeta()
			.then((m) => {
				if (cancelled) return;
				setMeta(m);
				setTopics(new Set(m.topics)); // 預設全選
			})
			.catch((e) => {
				if (!cancelled) {
					setMetaError(
						e instanceof ApiError ? `讀取主題失敗 (${e.status})` : String(e),
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	function toggleTopic(t: string) {
		setTopics((s) => {
			const next = new Set(s);
			if (next.has(t)) next.delete(t);
			else next.add(t);
			return next;
		});
	}
	function toggleSource(s0: string) {
		setSources((s) => {
			const next = new Set(s);
			if (next.has(s0)) next.delete(s0);
			else next.add(s0);
			return next;
		});
	}

	const noTopics = topics.size === 0;
	const noSources = sources.size === 0;
	const canStart = !busy && !noTopics && !noSources && n >= MIN_N && n <= MAX_N;

	async function start() {
		if (!canStart) return;
		setBusy(true);
		setError(null);
		try {
			const res = await createSmearSession({
				mode,
				n,
				form,
				topics: [...topics],
				sources: [...sources],
			});
			onClose();
			navigate(`/smear/s/${res.id}`);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) {
				setError("這個組合沒有符合的題目,請放寬篩選再試一次。");
			} else if (e instanceof ApiError) {
				setError(`建立失敗 (${e.status})`);
			} else {
				setError(String(e));
			}
			setBusy(false);
		}
	}

	return createPortal(
		<div
			className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm flex items-center justify-center dialog-scrim"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-paper w-full max-w-lg overflow-hidden flex flex-col max-h-full">
				<header className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-ink-100 dark:border-ink-700">
					<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 inline-flex items-center gap-2">
						<Microscope size={17} className="text-accent" />
						開始抹片練習
					</h2>
					<button
						onClick={onClose}
						className="p-1 rounded text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
						aria-label="關閉"
					>
						<X size={18} />
					</button>
				</header>

				<div className="overflow-y-auto px-5 py-4 space-y-5 text-sm">
					{/* 模式 */}
					<fieldset>
						<legend className="text-xs uppercase tracking-wide text-ink-400 mb-2">
							模式
						</legend>
						<div className="grid grid-cols-2 gap-2">
							<ModeButton
								active={mode === "review"}
								onClick={() => setMode("review")}
								label="複習模式"
								desc="作答後立刻看判定與正解"
							/>
							<ModeButton
								active={mode === "exam"}
								onClick={() => setMode("exam")}
								label="全真模式"
								desc="全程不揭曉,交卷才看結果"
							/>
						</div>
					</fieldset>

					{/* 題數 */}
					<fieldset>
						<legend className="text-xs uppercase tracking-wide text-ink-400 mb-2">
							題數
						</legend>
						<div className="flex items-center gap-3">
							<input
								type="number"
								inputMode="numeric"
								min={MIN_N}
								max={MAX_N}
								value={n}
								onChange={(e) => setN(Number(e.target.value) || 0)}
								onBlur={() =>
									setN((v) => Math.min(MAX_N, Math.max(MIN_N, v || MIN_N)))
								}
								className="w-24 border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded px-3 py-2 text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent"
								aria-label="題數"
							/>
							<span className="text-ink-500 dark:text-ink-400">
								題({MIN_N}–{MAX_N})
							</span>
						</div>
					</fieldset>

					{/* 作答寫法 */}
					<fieldset>
						<legend className="text-xs uppercase tracking-wide text-ink-400 mb-2">
							作答寫法
						</legend>
						<div className="space-y-2">
							{FORM_OPTIONS.map((f) => (
								<label
									key={f.id}
									className="flex gap-2 items-start p-2.5 rounded border border-ink-100 dark:border-ink-700 cursor-pointer hover:border-ink-300 dark:hover:border-ink-600"
								>
									<input
										type="radio"
										name="smear-form"
										className="mt-1 accent-[#a8442a]"
										checked={form === f.id}
										onChange={() => setForm(f.id)}
									/>
									<span>
										<span className="text-ink-900 dark:text-ink-100">
											{f.label}
										</span>
										<span className="block text-xs text-ink-500 dark:text-ink-400">
											{f.hint}
										</span>
									</span>
								</label>
							))}
						</div>
					</fieldset>

					{/* 主題篩選 */}
					<fieldset>
						<legend className="text-xs uppercase tracking-wide text-ink-400 mb-2">
							主題篩選
						</legend>
						{metaError ? (
							<p className="text-accent text-xs">{metaError}</p>
						) : meta === null ? (
							<p className="text-ink-400 dark:text-ink-500 text-xs">
								載入中…
							</p>
						) : (
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
								{meta.topics.map((t) => {
									const pct = Math.round((meta.topicWeights[t] ?? 0) * 100);
									return (
										<label
											key={t}
											className="flex items-center gap-2 p-2.5 rounded border border-ink-100 dark:border-ink-700 cursor-pointer hover:border-ink-300 dark:hover:border-ink-600"
										>
											<input
												type="checkbox"
												className="accent-[#a8442a]"
												checked={topics.has(t)}
												onChange={() => toggleTopic(t)}
											/>
											<span className="text-ink-700 dark:text-ink-200">
												{TOPIC_LABELS[t] ?? t}{" "}
												<span className="text-ink-400 dark:text-ink-500 text-xs">
													{pct}%
												</span>
											</span>
										</label>
									);
								})}
							</div>
						)}
						{noTopics && (
							<p className="text-accent text-xs mt-1.5">至少選一個主題</p>
						)}
					</fieldset>

					{/* 題源 */}
					<fieldset>
						<legend className="text-xs uppercase tracking-wide text-ink-400 mb-2">
							題源
						</legend>
						<div className="flex flex-wrap gap-2">
							{(["exam", "ash"] as const).map((s0) => (
								<label
									key={s0}
									className="flex items-center gap-2 p-2.5 rounded border border-ink-100 dark:border-ink-700 cursor-pointer hover:border-ink-300 dark:hover:border-ink-600"
								>
									<input
										type="checkbox"
										className="accent-[#a8442a]"
										checked={sources.has(s0)}
										onChange={() => toggleSource(s0)}
									/>
									<span className="text-ink-700 dark:text-ink-200">
										{SOURCE_LABELS[s0]}
										{meta?.sourceCounts?.[s0] != null && (
											<span className="text-ink-400 dark:text-ink-500 text-xs">
												{" "}
												({meta.sourceCounts[s0]})
											</span>
										)}
									</span>
								</label>
							))}
						</div>
						{noSources && (
							<p className="text-accent text-xs mt-1.5">至少選一個題源</p>
						)}
					</fieldset>

					{error && <p className="text-accent text-xs">{error}</p>}
				</div>

				<footer className="shrink-0 flex justify-end gap-2 px-5 py-3 border-t border-ink-100 dark:border-ink-700">
					<button
						onClick={onClose}
						className="px-3 py-1.5 text-sm rounded text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-700"
					>
						取消
					</button>
					<button
						onClick={start}
						disabled={!canStart}
						className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
					>
						{busy && <Loader2 size={14} className="animate-spin" />}
						開始練習
					</button>
				</footer>
			</div>
		</div>,
		document.body,
	);
}

function ModeButton({
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
