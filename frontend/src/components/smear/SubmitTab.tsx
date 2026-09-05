import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, UploadCloud, X } from "lucide-react";
import { useMe } from "../../hooks/useMe";
import { ApiError } from "../../lib/api";
import {
	fetchMySmearSubmissions,
	submitSmearSubmission,
	type SmearSubmissionMineItem,
	type SmearSubmissionStatus,
} from "../../lib/smearApi";
import { AdminSubmissionQueue } from "./AdminSubmissionQueue";

// 投稿分頁 —— 所有人可見的表單 + 個人投稿紀錄,加上只有 admin 看得到的
// 審核佇列子分頁。子分頁用元件內部 state(不進 `?tab=` querystring):跟頂層
// 五個分頁不同,這裡的兩個子分頁一個是「我的東西」一個是「別人交來待我審」,
// 沒有分享/加書籤這條路由的需求,不需要跟著搬進 URL。
//
// admin 子分頁的顯隱判準是 `me?.is_admin`,同 ReviewIndex.tsx「＋ 加入新
// 年份」的既有慣例(入口顯隱,真正的門在後端 GET /submissions/pending 的
// isAdminEmail 檢查)——這裡是 render-level 的條件式(整個 <AdminSubmissionQueue>
// 連掛都不掛),不是用 CSS 藏起來,同 CLAUDE.md 反覆強調的「render-level gate,
// 不是 CSS-hide」。
type SubTab = "mine" | "pending";

export function SubmitTab() {
	const { me } = useMe();
	const isAdmin = me?.is_admin === true;
	const [subTab, setSubTab] = useState<SubTab>("mine");

	// 非 admin 永遠停在 'mine'——理論上 UI 上也點不到「待審核」那顆分頁鈕
	// (根本沒渲染),但這裡再保險一次:is_admin 從 true 變 false(例如帳號被
	// 移出白名單、useMe 快取被別的分頁更新)時,不要讓使用者卡在一個現在已經
	// 進不去的子分頁上。
	useEffect(() => {
		if (!isAdmin && subTab === "pending") setSubTab("mine");
	}, [isAdmin, subTab]);

	return (
		<div className="space-y-4">
			{isAdmin && (
				<div
					className="inline-flex rounded border border-ink-200 dark:border-ink-700 overflow-hidden"
					role="tablist"
					aria-label="投稿子分頁"
				>
					{(
						[
							["mine", "我的投稿"],
							["pending", "待審核"],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							role="tab"
							onClick={() => setSubTab(id)}
							aria-selected={subTab === id}
							className={
								"px-3 py-1.5 text-sm transition " +
								(subTab === id
									? "bg-accent text-white"
									: "bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700")
							}
						>
							{label}
						</button>
					))}
				</div>
			)}

			{subTab === "mine" || !isAdmin ? (
				<MineSubTab />
			) : (
				<AdminSubmissionQueue />
			)}
		</div>
	);
}

// ── 「我的投稿」子分頁:表單 + 歷史 ──────────────────────────────────────
function MineSubTab() {
	const [refreshKey, setRefreshKey] = useState(0);
	return (
		<div className="space-y-6">
			<SubmissionForm onSubmitted={() => setRefreshKey((k) => k + 1)} />
			<SubmissionHistoryList refreshKey={refreshKey} />
		</div>
	);
}

// 同 worker/lib/upload-validate.ts 的 ALLOWED_IMAGE_TYPES / MAX_IMAGE_SIZE ——
// 這裡只是提前給使用者一次性的回饋,伺服器的檢查才是真正的邊界。改動任一邊
// 的限制時記得跟著改另一邊,否則使用者會在這裡通過、卻在伺服器那關失敗,
// 體驗比完全沒有客戶端檢查更差(先讓他們白等一趟上傳)。
const ALLOWED_IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
]);
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

function validateImageClientSide(file: File): string | null {
	if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
		return `不支援的檔案格式(${file.type || "未知"})—— 請用 JPEG / PNG / WebP / GIF。`;
	}
	if (file.size > MAX_IMAGE_SIZE) {
		return `檔案太大(${(file.size / 1024 / 1024).toFixed(1)}MB)—— 上限 10MB。`;
	}
	return null;
}

function SubmissionForm({ onSubmitted }: { onSubmitted: () => void }) {
	const [file, setFile] = useState<File | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [proposedAnswer, setProposedAnswer] = useState("");
	const [explanationText, setExplanationText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	// 換掉預覽圖時釋放上一個 object URL,不然每次挑圖都洩漏一個。
	useEffect(() => {
		return () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		};
	}, [previewUrl]);

	function pickFile(f: File | null) {
		setSuccess(false);
		setError(null);
		if (!f) {
			setFile(null);
			setPreviewUrl((prev) => {
				if (prev) URL.revokeObjectURL(prev);
				return null;
			});
			return;
		}
		const clientError = validateImageClientSide(f);
		if (clientError) {
			setError(clientError);
			setFile(null);
			if (fileInputRef.current) fileInputRef.current.value = "";
			return;
		}
		setFile(f);
		setPreviewUrl((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return URL.createObjectURL(f);
		});
	}

	function reset() {
		pickFile(null);
		setProposedAnswer("");
		setExplanationText("");
		if (fileInputRef.current) fileInputRef.current.value = "";
	}

	const trimmedAnswer = proposedAnswer.trim();
	const canSubmit = !busy && !!file && trimmedAnswer.length > 0;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!canSubmit || !file) return;
		setBusy(true);
		setError(null);
		setSuccess(false);
		try {
			await submitSmearSubmission({
				image: file,
				proposedAnswer: trimmedAnswer,
				explanationText: explanationText.trim() || undefined,
			});
			reset();
			setSuccess(true);
			onSubmitted();
		} catch (e2) {
			setError(
				e2 instanceof ApiError
					? `送出失敗 (${e2.status})：${typeof e2.data?.error === "string" ? e2.data.error : "請稍後再試"}`
					: String(e2),
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 sm:p-5 space-y-4"
		>
			<div>
				<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100">
					投稿一張抹片
				</h2>
				<p className="text-xs text-ink-500 dark:text-ink-400 mt-1 leading-relaxed">
					上傳一張血液抹片影像與你認為的正確答案,送出後由管理員審核 ——
					核准後會成為練習題庫的一部分。
				</p>
			</div>

			{success && (
				<p
					role="status"
					className="text-sm border-2 border-accent text-accent dark:border-accent-light dark:text-accent-light rounded px-3 py-2 flex items-center gap-1.5"
				>
					<span aria-hidden="true">✓</span> 已送出,等待審核。
				</p>
			)}
			{error && (
				<p className="text-sm border-2 border-rose-600 dark:border-rose-400 text-rose-700 dark:text-rose-400 rounded px-3 py-2 break-words">
					{error}
				</p>
			)}

			{/* 圖片挑選 + 預覽 —— 純 <input type=file accept=image/*>,行動裝置的
			    瀏覽器本來就會原生提供「拍照 / 從相簿選」兩個選項,不需要另外做
			    capture 屬性的猜測性 UI(那會少給一個選項,不是多給)。 */}
			<div>
				<label className="block text-xs uppercase tracking-wide text-ink-400 mb-1.5">
					抹片影像
				</label>
				{previewUrl ? (
					<div className="relative inline-block max-w-full">
						<img
							src={previewUrl}
							alt="預覽"
							className="max-h-64 max-w-full rounded border border-ink-200 dark:border-ink-700 object-contain"
						/>
						<button
							type="button"
							onClick={() => pickFile(null)}
							aria-label="移除圖片"
							className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-ink-900 text-white flex items-center justify-center shadow hover:bg-black"
						>
							<X size={14} />
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						className="w-full flex flex-col items-center justify-center gap-2 border-2 border-dashed border-ink-300 dark:border-ink-600 rounded-lg py-8 text-ink-500 dark:text-ink-400 hover:border-accent hover:text-accent transition"
					>
						<ImagePlus size={28} aria-hidden="true" />
						<span className="text-sm">點擊選擇圖片(相機或相簿)</span>
						<span className="text-[11px] text-ink-400 dark:text-ink-500">
							JPEG / PNG / WebP / GIF,10MB 以內
						</span>
					</button>
				)}
				<input
					ref={fileInputRef}
					type="file"
					accept="image/jpeg,image/png,image/webp,image/gif"
					className="sr-only"
					onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
				/>
			</div>

			<div>
				<label
					htmlFor="submission-answer"
					className="block text-xs uppercase tracking-wide text-ink-400 mb-1.5"
				>
					正確答案 <span className="text-accent">*</span>
				</label>
				<input
					id="submission-answer"
					type="text"
					required
					value={proposedAnswer}
					onChange={(e) => setProposedAnswer(e.target.value)}
					placeholder="例如:dacrocyte / acute promyelocytic leukemia"
					className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded px-3 py-2.5 text-base text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent"
				/>
			</div>

			<div>
				<label
					htmlFor="submission-explanation"
					className="block text-xs uppercase tracking-wide text-ink-400 mb-1.5"
				>
					文字說明(選填)
				</label>
				<textarea
					id="submission-explanation"
					value={explanationText}
					onChange={(e) => setExplanationText(e.target.value)}
					rows={3}
					placeholder="怎麼認出這個診斷、有什麼值得注意的特徵…"
					className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded px-3 py-2.5 text-sm text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent resize-y"
				/>
			</div>

			<button
				type="submit"
				disabled={!canSubmit}
				className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed transition"
			>
				{busy ? (
					<>
						<Loader2 size={15} className="animate-spin" /> 上傳中…
					</>
				) : (
					<>
						<UploadCloud size={15} /> 送出投稿
					</>
				)}
			</button>
		</form>
	);
}

// ── 個人投稿歷史 ─────────────────────────────────────────────────────────
export const SUBMISSION_STATUS_META: Record<
	SmearSubmissionStatus,
	{ icon: string; label: string; cls: string }
> = {
	// 三種狀態的視覺語彙沿用 GradeReveal.TIER_META 的同一套規則(icon 承載語意,
	// 顏色只是加強):pending 用虛線(進行中,同「lay」)、approved 用 accent
	// 實心填色(成功,同「full」)、rejected 用玫瑰色實線外框(同「miss」)。
	pending: {
		icon: "○",
		label: "審核中",
		cls: "bg-white dark:bg-ink-800 border-2 border-dashed border-ink-400 dark:border-ink-500 text-ink-600 dark:text-ink-300",
	},
	approved: {
		icon: "✓",
		label: "已核准",
		cls: "bg-accent text-white border border-accent",
	},
	rejected: {
		icon: "✗",
		label: "已退件",
		cls: "bg-white dark:bg-ink-800 border-2 border-rose-600 dark:border-rose-400 text-rose-700 dark:text-rose-400",
	},
};

export function StatusBadge({ status }: { status: SmearSubmissionStatus }) {
	const meta = SUBMISSION_STATUS_META[status];
	return (
		<span
			className={
				"inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium shrink-0 " +
				meta.cls
			}
		>
			<span aria-hidden="true">{meta.icon}</span>
			{meta.label}
		</span>
	);
}

function SubmissionHistoryList({ refreshKey }: { refreshKey: number }) {
	const [items, setItems] = useState<SmearSubmissionMineItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(() => {
		let cancelled = false;
		fetchMySmearSubmissions()
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

	useEffect(() => load(), [load, refreshKey]);

	return (
		<div>
			<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 mb-3">
				我的投稿紀錄
			</h2>
			{error ? (
				<p className="text-accent text-sm text-center py-8">讀取失敗:{error}</p>
			) : items === null ? (
				<p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500 py-8">
					<Loader2 size={15} className="animate-spin" /> 載入中…
				</p>
			) : items.length === 0 ? (
				<p className="text-sm text-ink-400 dark:text-ink-500 text-center py-8">
					還沒有投稿紀錄 —— 上面的表單送出後會出現在這裡。
				</p>
			) : (
				<ul className="space-y-2">
					{items.map((it) => (
						<li
							key={it.id}
							className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-3"
						>
							<div className="flex items-start justify-between gap-3">
								<p className="text-ink-900 dark:text-ink-100 break-words min-w-0 flex-1">
									{it.proposed_answer}
								</p>
								<StatusBadge status={it.status} />
							</div>
							<p className="text-[11px] text-ink-400 dark:text-ink-500 mt-1.5">
								投稿於 {new Date(it.created_at).toLocaleString("zh-TW")}
								{it.reviewed_at &&
									` · 審核於 ${new Date(it.reviewed_at).toLocaleString("zh-TW")}`}
							</p>
							{it.status === "rejected" && it.review_note && (
								<p className="text-xs text-rose-700 dark:text-rose-400 mt-2 break-words border-l-2 border-rose-300 dark:border-rose-700 pl-2">
									審核意見:{it.review_note}
								</p>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
