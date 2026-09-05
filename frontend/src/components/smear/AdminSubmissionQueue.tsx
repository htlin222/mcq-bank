import { useEffect, useState } from "react";
import { Loader2, Search as SearchIcon, X } from "lucide-react";
import { ApiError } from "../../lib/api";
import {
	approveSmearSubmission,
	fetchPendingSmearSubmissions,
	rejectSmearSubmission,
	searchSmear,
	type SmearSearchHit,
	type SmearSubmissionPendingItem,
} from "../../lib/smearApi";
import { SmearImage } from "./SmearImage";

// 待審核佇列 —— 只在 SubmitTab.tsx 確認 `me?.is_admin === true` 之後才會被
// 掛載(render-level gate,不是 CSS 藏起來)。這支元件自己不重複檢查
// is_admin:GET /submissions/pending 本身已經是 admin-only(403),即使有人
// 繞過前端把這個元件硬掛出來,清單也只會是一片空白 + 讀取失敗訊息。
//
// 排序沿用伺服器的 `ORDER BY created_at ASC`(oldest-first),不在前端重排。

const SEARCH_DEBOUNCE_MS = 250;

export function AdminSubmissionQueue() {
	const [items, setItems] = useState<SmearSubmissionPendingItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	function load() {
		fetchPendingSmearSubmissions()
			.then((r) => setItems(r.items))
			.catch((e) => {
				setItems([]);
				setError(
					e instanceof ApiError ? `讀取失敗 (${e.status})` : String(e),
				);
			});
	}

	useEffect(load, []);

	function removeFromQueue(id: string) {
		setItems((cur) => (cur ?? []).filter((it) => it.id !== id));
	}

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
				目前沒有待審核的投稿。
			</p>
		);
	}

	return (
		<div>
			<p className="text-xs text-ink-500 dark:text-ink-400 mb-3">
				{items.length} 則待審核 · 最舊的排最前面
			</p>
			<ul className="space-y-4">
				{items.map((it) => (
					<li key={it.id}>
						<PendingSubmissionCard
							item={it}
							onResolved={() => removeFromQueue(it.id)}
						/>
					</li>
				))}
			</ul>
		</div>
	);
}

function PendingSubmissionCard({
	item,
	onResolved,
}: {
	item: SmearSubmissionPendingItem;
	onResolved: () => void;
}) {
	const [selectedDxId, setSelectedDxId] = useState<string | null>(null);
	const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
	const [showPicker, setShowPicker] = useState(!item.suggestedDxId);

	const [rejecting, setRejecting] = useState(false);
	const [reviewNote, setReviewNote] = useState("");

	const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
	const [error, setError] = useState<string | null>(null);

	function acceptSuggestion() {
		if (!item.suggestedDxId) return;
		setSelectedDxId(item.suggestedDxId);
		setSelectedLabel(item.suggestedCanonical ?? item.suggestedDxId);
		setShowPicker(false);
	}

	function pickDx(hit: SmearSearchHit) {
		setSelectedDxId(hit.dx_id);
		setSelectedLabel(hit.canonical_long);
		setShowPicker(false);
	}

	function clearSelection() {
		setSelectedDxId(null);
		setSelectedLabel(null);
		setShowPicker(true);
	}

	async function approve() {
		if (!selectedDxId) return;
		setBusy("approve");
		setError(null);
		try {
			await approveSmearSubmission(item.id, selectedDxId);
			onResolved();
		} catch (e) {
			setError(
				e instanceof ApiError ? `核准失敗 (${e.status})` : String(e),
			);
			setBusy(null);
		}
	}

	async function reject() {
		setBusy("reject");
		setError(null);
		try {
			await rejectSmearSubmission(item.id, reviewNote.trim() || undefined);
			onResolved();
		} catch (e) {
			setError(
				e instanceof ApiError ? `退件失敗 (${e.status})` : String(e),
			);
			setBusy(null);
		}
	}

	return (
		<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 space-y-3">
			<div className="max-w-sm mx-auto sm:mx-0">
				<SmearImage
					viewKey={item.image_key}
					fullKey={item.image_key}
					alt={`來自 ${item.user_email} 的投稿影像`}
				/>
			</div>

			<div className="text-sm space-y-1.5">
				<p className="text-ink-900 dark:text-ink-100 break-words">
					<span className="text-ink-400 dark:text-ink-500 text-xs uppercase tracking-wide mr-1.5">
						投稿答案
					</span>
					{item.proposed_answer}
				</p>
				{item.explanation_text && (
					<p className="text-ink-600 dark:text-ink-300 break-words whitespace-pre-wrap text-sm border-l-2 border-ink-200 dark:border-ink-600 pl-2.5">
						{item.explanation_text}
					</p>
				)}
				<p className="text-[11px] text-ink-400 dark:text-ink-500 break-words">
					{item.user_email} · {new Date(item.created_at).toLocaleString("zh-TW")}
				</p>
			</div>

			{/* dx 選擇區 —— approve 需要一個明確的 dxId,建議只是預填,不會自動送出。 */}
			<div className="border-t border-ink-100 dark:border-ink-700 pt-3 space-y-2">
				{selectedDxId ? (
					<div className="flex items-center justify-between gap-2 flex-wrap bg-accent/5 border border-accent rounded px-3 py-2">
						<p className="text-sm text-ink-900 dark:text-ink-100 break-words min-w-0">
							<span className="text-accent">已選擇:</span> {selectedLabel}
						</p>
						<button
							type="button"
							onClick={clearSelection}
							className="shrink-0 text-xs text-ink-500 dark:text-ink-400 hover:text-accent underline"
						>
							改選
						</button>
					</div>
				) : (
					<>
						{item.suggestedDxId && (
							<div className="flex items-center justify-between gap-2 flex-wrap border-2 border-dashed border-accent text-accent rounded px-3 py-2">
								<p className="text-sm break-words min-w-0">
									系統猜測:{item.suggestedCanonical ?? item.suggestedDxId} ——
									確認嗎?
								</p>
								<button
									type="button"
									onClick={acceptSuggestion}
									className="shrink-0 px-2.5 py-1 rounded bg-accent text-white text-xs hover:bg-accent-dark"
								>
									採用建議
								</button>
							</div>
						)}
						{!showPicker && item.suggestedDxId && (
							<button
								type="button"
								onClick={() => setShowPicker(true)}
								className="text-xs text-ink-500 dark:text-ink-400 hover:text-accent underline"
							>
								或搜尋別的診斷…
							</button>
						)}
						{showPicker && <DxPicker onPick={pickDx} />}
					</>
				)}
			</div>

			{error && (
				<p className="text-sm border-2 border-rose-600 dark:border-rose-400 text-rose-700 dark:text-rose-400 rounded px-3 py-2 break-words">
					{error}
				</p>
			)}

			{rejecting ? (
				<div className="space-y-2 border-t border-ink-100 dark:border-ink-700 pt-3">
					<label className="block text-xs uppercase tracking-wide text-ink-400">
						退件原因(選填)
					</label>
					<textarea
						value={reviewNote}
						onChange={(e) => setReviewNote(e.target.value)}
						rows={2}
						placeholder="讓投稿者知道為什麼被退件…"
						className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded px-3 py-2 text-sm text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent resize-y"
					/>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => {
								setRejecting(false);
								setReviewNote("");
							}}
							disabled={busy !== null}
							className="flex-1 sm:flex-none px-3 py-2 rounded text-sm text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-700"
						>
							取消
						</button>
						<button
							type="button"
							onClick={reject}
							disabled={busy !== null}
							className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded border-2 border-rose-600 dark:border-rose-400 text-rose-700 dark:text-rose-400 text-sm font-medium hover:bg-rose-50 dark:hover:bg-rose-900/20 disabled:opacity-40"
						>
							{busy === "reject" && <Loader2 size={14} className="animate-spin" />}
							確認退件
						</button>
					</div>
				</div>
			) : (
				<div className="flex gap-2 border-t border-ink-100 dark:border-ink-700 pt-3">
					<button
						type="button"
						onClick={() => setRejecting(true)}
						disabled={busy !== null}
						className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded border-2 border-rose-600 dark:border-rose-400 text-rose-700 dark:text-rose-400 text-sm font-medium hover:bg-rose-50 dark:hover:bg-rose-900/20 disabled:opacity-40 transition"
					>
						<span aria-hidden="true">✗</span> 退件
					</button>
					<button
						type="button"
						onClick={approve}
						disabled={!selectedDxId || busy !== null}
						title={selectedDxId ? undefined : "請先選擇對應的診斷"}
						className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed transition"
					>
						{busy === "approve" ? (
							<Loader2 size={14} className="animate-spin" />
						) : (
							<span aria-hidden="true">✓</span>
						)}
						核准
					</button>
				</div>
			)}
		</div>
	);
}

// 小型 dx 搜尋器,沿用 Smear.tsx SearchTab 的 debounce 節奏與 /api/smear/search
// 端點 —— 不重新發明搜尋邏輯,只是換一種呈現(結果是可點選的按鈕,不是連結)。
function DxPicker({ onPick }: { onPick: (hit: SmearSearchHit) => void }) {
	const [q, setQ] = useState("");
	const [hits, setHits] = useState<SmearSearchHit[] | null>(null);
	const [loading, setLoading] = useState(false);
	const trimmed = q.trim();

	useEffect(() => {
		if (!trimmed) {
			setHits(null);
			setLoading(false);
			return;
		}
		setLoading(true);
		let alive = true;
		const t = window.setTimeout(async () => {
			try {
				const r = await searchSmear(trimmed);
				if (alive) setHits(r.items);
			} catch {
				if (alive) setHits([]);
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
					size={14}
					className={
						"absolute left-2.5 top-1/2 -translate-y-1/2 " +
						(loading ? "text-accent animate-pulse" : "text-ink-400 dark:text-ink-500")
					}
					aria-hidden="true"
				/>
				{q && (
					<button
						type="button"
						onClick={() => setQ("")}
						aria-label="清除搜尋"
						className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
					>
						<X size={14} />
					</button>
				)}
				<input
					type="search"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="搜尋診斷名稱以指定對應…"
					aria-label="搜尋診斷"
					className="w-full pl-8 pr-8 py-2 border border-ink-200 dark:border-ink-700 rounded text-sm focus:outline-none focus:border-accent bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100"
				/>
			</div>
			{trimmed && (
				<ul className="mt-1.5 space-y-1 max-h-48 overflow-y-auto">
					{hits === null ? (
						<li className="text-xs text-ink-400 dark:text-ink-500 py-1.5">
							搜尋中…
						</li>
					) : hits.length === 0 ? (
						<li className="text-xs text-ink-400 dark:text-ink-500 py-1.5">
							沒有符合的診斷。
						</li>
					) : (
						hits.map((h) => (
							<li key={h.dx_id}>
								<button
									type="button"
									onClick={() => onPick(h)}
									className="w-full text-left px-2.5 py-1.5 rounded border border-ink-100 dark:border-ink-700 hover:border-accent text-sm text-ink-800 dark:text-ink-200 break-words"
								>
									{h.canonical_long}
								</button>
							</li>
						))
					)}
				</ul>
			)}
		</div>
	);
}
