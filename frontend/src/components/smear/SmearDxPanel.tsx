import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
	ChevronLeft,
	ChevronRight,
	Loader2,
	Plus,
	ThumbsDown,
	ThumbsUp,
	Undo2,
} from "lucide-react";
import { ApiError } from "../../lib/api";
import { isEmptyDoc } from "../../lib/drafts";
import { useMe, type Me } from "../../hooks/useMe";
import { useNarrow } from "../../hooks/useNarrow";
import { noteTitleFromJson, NOTE_TITLE_NARROW } from "../../lib/noteTitle";
import { useDismiss } from "../../hooks/useDismiss";
import { KeepAlive } from "../KeepAlive";
import { StaticContent } from "../StaticContent";
import { RichEditor } from "../RichEditor";
import { SmearCommentThread } from "./SmearCommentThread";
import { TIER_META, TERM_TIER_ORDER } from "./GradeReveal";
import {
	fetchSmearDx,
	proposeSmearTerm,
	voteSmearTerm,
	retractSmearTermVote,
	fetchSmearNotes,
	createSmearNote,
	updateSmearNote,
	deleteSmearNote,
	type SmearDxDetail,
	type SmearNote,
	type SmearProposedTerm,
	type SmearTier,
} from "../../lib/smearApi";

// 抹片診斷的「詳解 / 個人筆記 / 討論 / 相似」共用面板 —— /smear/dx/:id
// (獨立頁)與 /smear/s/:id(複習模式作答後,GradeReveal 底下)共用同一份。
//
// **自己抓自己的資料,不吃呼叫端傳進來的 dx。** 兩個呼叫端的處境不一樣:
// SmearDx.tsx 本來就要另外抓一次 dx(標題/badge/圖片走在這個面板之外),
// SmearSession.tsx 完全沒有 dx 詳情(session 只回 dx_id)。與其定義兩種呼叫
// 方式(「有 dx 就傳,沒有就自己抓」),不如統一成「這個面板永遠自己抓」——
// 多一次 GET /api/smear/dx/:id 是幾 KB 的 JSON,換到的是零耦合:呼叫端只要
// 給一個 dxId 字串,不需要先跑完一次 fetchSmearDx 才能組出 props。
//
// 響應式版面同 Question.tsx 的分頁/兩欄機制,但這裡的「兩欄」只發生在呼叫端
// (SmearDx.tsx 在 ≥sm 把這個面板放在圖片旁邊的第二欄)——面板本身**永遠**是
// 「一條分頁列 + 一個可見的分頁」,不會因為寬螢幕就同時攤開四塊內容:四塊裡
// 討論串/多則筆記都可能很長,並排只會變成到處都要捲。`useNarrow()` 因此只用在
// 這裡唯一真的需要 JS 才能做的決定 —— 切分頁時要不要捲回頂端(同 Question.tsx
// 的 pickTab):純版面差異(哪個斷點兩欄/一欄)交給呼叫端的 Tailwind class,
// 不在這裡用它分支 JSX(useNarrow.ts 檔頭本來就寫著這條界線)。

export type SmearDxPanelTab = "explanation" | "note" | "discussion" | "similar";

const PANEL_TABS: SmearDxPanelTab[] = ["explanation", "note", "discussion", "similar"];

const PANEL_TAB_LABEL: Record<SmearDxPanelTab, string> = {
	explanation: "詳解",
	note: "個人筆記",
	discussion: "討論",
	similar: "相似",
};

const TERM_TIER_LABEL: Record<SmearTier, string> = {
	full: "全分",
	half: "半分",
	lay: "俗名(不計分)",
};

const FORM_LABEL: Record<"long" | "abbrev", string> = {
	long: "全稱",
	abbrev: "縮寫",
};

export function SmearDxPanel({
	dxId,
	className = "",
}: {
	dxId: string;
	className?: string;
}) {
	const { me } = useMe();
	const narrow = useNarrow();
	const panelRef = useRef<HTMLDivElement>(null);

	const [dx, setDx] = useState<SmearDxDetail | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [tab, setTab] = useState<SmearDxPanelTab>("explanation");

	// 提報中的詞 + 我投的票 —— 同 SmearDx.tsx 舊版的理由:GET /dx/:id 只回
	// status='accepted' 的列,剛提報成功的詞要靠這裡才看得到自己的提案。
	const [proposals, setProposals] = useState<SmearProposedTerm[]>([]);
	const [myVotes, setMyVotes] = useState<Record<string, boolean>>({});
	const [voteBusy, setVoteBusy] = useState<Record<string, boolean>>({});

	useEffect(() => {
		let cancelled = false;
		setDx(null);
		setLoadError(null);
		setProposals([]);
		setMyVotes({});
		setTab("explanation");
		fetchSmearDx(dxId)
			.then((d) => {
				if (!cancelled) setDx(d);
			})
			.catch((e) => {
				if (cancelled) return;
				setLoadError(
					e instanceof ApiError && e.status === 404
						? "找不到這個診斷。"
						: e instanceof ApiError
							? `讀取失敗 (${e.status})`
							: String(e),
				);
			});
		return () => {
			cancelled = true;
		};
	}, [dxId]);

	function pickTab(t: SmearDxPanelTab) {
		setTab(t);
		// 窄螢幕下這個面板常常比視窗高(討論串、好幾則筆記),切分頁不歸零的話
		// 會停在上一個分頁捲到一半的位置,看起來像切壞了 —— 同 Question.tsx 的
		// pickTab。寬螢幕是兩欄並排,面板旁邊還有圖片/標題,不需要這個介入。
		if (narrow) panelRef.current?.scrollIntoView({ block: "nearest" });
	}

	async function handleVote(term: SmearProposedTerm, agree: boolean) {
		setVoteBusy((b) => ({ ...b, [term.id]: true }));
		try {
			const res = await voteSmearTerm(term.id, agree);
			setProposals((prev) => prev.map((p) => (p.id === term.id ? res.term : p)));
			setMyVotes((v) => ({ ...v, [term.id]: agree }));
		} catch (e) {
			alert(
				e instanceof ApiError
					? e.data?.error === "proposer cannot vote on their own proposal"
						? "不能對自己的提報投票。"
						: `投票失敗 (${e.status})`
					: String(e),
			);
		} finally {
			setVoteBusy((b) => ({ ...b, [term.id]: false }));
		}
	}

	async function handleRetractVote(term: SmearProposedTerm) {
		setVoteBusy((b) => ({ ...b, [term.id]: true }));
		try {
			const res = await retractSmearTermVote(term.id);
			setProposals((prev) => prev.map((p) => (p.id === term.id ? res.term : p)));
			setMyVotes((v) => {
				const next = { ...v };
				delete next[term.id];
				return next;
			});
		} catch (e) {
			alert(e instanceof ApiError ? `收回失敗 (${e.status})` : String(e));
		} finally {
			setVoteBusy((b) => ({ ...b, [term.id]: false }));
		}
	}

	return (
		<div ref={panelRef} className={className}>
			<div
				className="inline-flex max-w-full rounded border border-ink-200 dark:border-ink-700 overflow-x-auto mb-4"
				role="tablist"
				aria-label="診斷詳情分頁"
			>
				{PANEL_TABS.map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						onClick={() => pickTab(t)}
						className={
							"shrink-0 px-3 py-1.5 text-sm transition " +
							(tab === t
								? "bg-accent text-white"
								: "bg-white dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700")
						}
					>
						{PANEL_TAB_LABEL[t]}
					</button>
				))}
			</div>

			{loadError && <p className="text-accent text-sm break-words">{loadError}</p>}
			{!dx && !loadError && (
				<p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500 py-6">
					<Loader2 size={15} className="animate-spin" /> 載入中…
				</p>
			)}

			{dx && (
				<>
					<KeepAlive active={tab === "explanation"}>
						<ExplanationPane
							dx={dx}
							me={me}
							proposals={proposals}
							myVotes={myVotes}
							voteBusy={voteBusy}
							onProposed={(t) => setProposals((prev) => [...prev, t])}
							onVote={handleVote}
							onRetractVote={handleRetractVote}
						/>
					</KeepAlive>
					<KeepAlive active={tab === "note"}>
						<NotesPane dxId={dxId} />
					</KeepAlive>
					<KeepAlive active={tab === "discussion"}>
						<SmearCommentThread
							dxId={dxId}
							currentEmail={me?.email}
							isAdmin={!!me?.is_admin}
						/>
					</KeepAlive>
					<KeepAlive active={tab === "similar"}>
						<SimilarPane related={dx.related ?? []} />
					</KeepAlive>
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 詳解 —— 唯讀內文 + 已接受寫法(分 tier)+ 提報中的詞 + 提報表單。
// 這一塊原封不動搬自 SmearDx.tsx 舊版,單獨拉出來只是換了容器。
// ---------------------------------------------------------------------------
function ExplanationPane({
	dx,
	me,
	proposals,
	myVotes,
	voteBusy,
	onProposed,
	onVote,
	onRetractVote,
}: {
	dx: SmearDxDetail;
	me: Me | null;
	proposals: SmearProposedTerm[];
	myVotes: Record<string, boolean>;
	voteBusy: Record<string, boolean>;
	onProposed: (term: SmearProposedTerm) => void;
	onVote: (term: SmearProposedTerm, agree: boolean) => void;
	onRetractVote: (term: SmearProposedTerm) => void;
}) {
	const doc = useMemo(() => {
		const raw = dx.note?.content_json;
		if (!raw) return null;
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}, [dx.note?.content_json]);
	const noteEmpty = !doc || isEmptyDoc(doc);

	const groupedTerms = useMemo(() => {
		const g: Record<SmearTier, SmearDxDetail["terms"]> = { full: [], half: [], lay: [] };
		for (const t of dx.terms ?? []) g[t.tier]?.push(t);
		return g;
	}, [dx.terms]);

	return (
		<div className="space-y-8">
			<section>
				{noteEmpty ? (
					<p className="text-sm text-ink-400 dark:text-ink-500">詳解尚未建立。</p>
				) : (
					<StaticContent content={doc} />
				)}
			</section>

			<section>
				<h2 className="text-xs uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-2">
					可接受的寫法
				</h2>
				<div className="flex flex-wrap gap-1.5">
					{TERM_TIER_ORDER.flatMap((tier) =>
						(groupedTerms[tier] ?? []).map((t) => (
							<span
								key={t.id}
								className={
									"px-2.5 py-1 rounded text-xs max-w-full break-words " +
									TIER_META[tier].chipCls
								}
							>
								<span aria-hidden="true">{TIER_META[tier].icon}</span> {t.text}
								<span className="ml-1 opacity-70">({FORM_LABEL[t.form]})</span>
							</span>
						)),
					)}
					{(dx.terms ?? []).length === 0 && (
						<p className="text-sm text-ink-400 dark:text-ink-500">
							目前還沒有已接受的寫法。
						</p>
					)}
				</div>

				{proposals.length > 0 && (
					<div className="mt-3 space-y-2">
						{proposals.map((p) => (
							<ProposalRow
								key={p.id}
								term={p}
								myVote={myVotes[p.id]}
								busy={!!voteBusy[p.id]}
								isMine={!!me && p.proposed_by === me.email}
								onVote={(agree) => onVote(p, agree)}
								onRetract={() => onRetractVote(p)}
							/>
						))}
					</div>
				)}
			</section>

			<ProposeTermForm
				dxId={dx.id}
				onProposed={onProposed}
				existingAccepted={dx.terms ?? []}
				existingProposals={proposals}
			/>
		</div>
	);
}

function ProposalRow({
	term,
	myVote,
	busy,
	isMine,
	onVote,
	onRetract,
}: {
	term: SmearProposedTerm;
	myVote: boolean | undefined;
	busy: boolean;
	isMine: boolean;
	onVote: (agree: boolean) => void;
	onRetract: () => void;
}) {
	const statusMeta =
		term.status === "accepted"
			? { label: "已通過", cls: TIER_META[term.tier].chipCls }
			: term.status === "rejected"
				? {
						label: "未通過",
						cls: "bg-white dark:bg-ink-800 border border-ink-300 dark:border-ink-600 text-ink-400 dark:text-ink-500 line-through",
					}
				: { label: "投票中", cls: "border border-dashed border-accent text-accent" };

	return (
		<div className="rounded border border-ink-100 dark:border-ink-700 px-2.5 py-2 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<span className={"px-2 py-0.5 rounded max-w-full break-words " + statusMeta.cls}>
					{term.text} <span className="opacity-70">({FORM_LABEL[term.form]})</span>
				</span>
				<span className="text-ink-400 dark:text-ink-500">{statusMeta.label}</span>
				{term.status === "open" && !isMine && (
					<div className="flex items-center gap-1.5 ml-auto">
						<button
							type="button"
							disabled={busy}
							onClick={() => onVote(true)}
							aria-pressed={myVote === true}
							className={
								"inline-flex items-center gap-1 px-2 py-1 rounded border disabled:opacity-40 " +
								(myVote === true
									? "border-accent bg-accent text-white"
									: "border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-accent hover:text-accent")
							}
						>
							<ThumbsUp size={12} /> 同意
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => onVote(false)}
							aria-pressed={myVote === false}
							className={
								"inline-flex items-center gap-1 px-2 py-1 rounded border disabled:opacity-40 " +
								(myVote === false
									? "border-rose-600 bg-rose-600 text-white dark:border-rose-400 dark:bg-rose-500"
									: "border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-rose-600 hover:text-rose-600")
							}
						>
							<ThumbsDown size={12} /> 反對
						</button>
						{myVote !== undefined && (
							<button
								type="button"
								disabled={busy}
								onClick={onRetract}
								title="收回我的票"
								className="inline-flex items-center gap-1 px-1.5 py-1 rounded text-ink-400 hover:text-ink-700 dark:hover:text-ink-200 disabled:opacity-40"
							>
								<Undo2 size={12} />
							</button>
						)}
					</div>
				)}
				{term.status === "open" && isMine && (
					<span className="text-ink-400 dark:text-ink-500 ml-auto">
						這是你的提報,等其他人投票
					</span>
				)}
			</div>
			{term.rationale && (
				<p className="mt-1.5 text-ink-500 dark:text-ink-400 break-words">
					{term.rationale}
				</p>
			)}
		</div>
	);
}

function ProposeTermForm({
	dxId,
	onProposed,
	existingAccepted,
	existingProposals,
}: {
	dxId: string;
	onProposed: (term: SmearProposedTerm) => void;
	existingAccepted: SmearDxDetail["terms"];
	existingProposals: SmearProposedTerm[];
}) {
	const [text, setText] = useState("");
	const [tier, setTier] = useState<SmearTier>("half");
	const [form, setForm] = useState<"long" | "abbrev">("long");
	const [rationale, setRationale] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const canSubmit = !busy && text.trim().length > 0;

	async function submit() {
		if (!canSubmit) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const res = await proposeSmearTerm(dxId, {
				text: text.trim(),
				tier,
				form,
				rationale: rationale.trim() || undefined,
			});
			onProposed(res.term);
			setText("");
			setRationale("");
			setNotice("提報成功,已加進下面的投票清單。");
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				const existingId = e.data?.existingTermId as string | undefined;
				const foundAccepted = existingAccepted.find((t) => t.id === existingId);
				const foundOpen = existingProposals.find((t) => t.id === existingId);
				if (foundAccepted) {
					setError(`「${foundAccepted.text}」已經是可接受的寫法了,不用重複提報。`);
				} else if (foundOpen) {
					setError(`「${foundOpen.text}」正在投票中,幫它投一票就好,不用重新提報。`);
				} else {
					setError(`這個寫法先前已被提報過(${e.data?.error ?? "重複"})。`);
				}
			} else if (e instanceof ApiError) {
				setError(e.data?.error ?? `提報失敗 (${e.status})`);
			} else {
				setError(String(e));
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="border-t border-ink-100 dark:border-ink-700 pt-6">
			<h2 className="font-serif text-lg text-ink-900 dark:text-ink-100 mb-1">
				這個寫法也該算對?
			</h2>
			<p className="text-xs text-ink-500 dark:text-ink-400 mb-4">
				提報後由大家投票決定是否收錄,累積 3 票且同意多於反對才會通過。
			</p>

			<div className="space-y-4 text-sm">
				<div>
					<label className="block text-xs uppercase tracking-wide text-ink-400 mb-1.5">
						寫法
					</label>
					<input
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder="輸入診斷或細胞名稱的另一種寫法…"
						className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded px-3 py-2 text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent"
					/>
				</div>

				<fieldset>
					<legend className="text-xs uppercase tracking-wide text-ink-400 mb-1.5">
						該算幾分
					</legend>
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
						{TERM_TIER_ORDER.map((t) => (
							<label
								key={t}
								className="flex items-center gap-2 p-2.5 rounded border border-ink-100 dark:border-ink-700 cursor-pointer hover:border-ink-300 dark:hover:border-ink-600"
							>
								<input
									type="radio"
									name="propose-tier"
									className="accent-[#a8442a]"
									checked={tier === t}
									onChange={() => setTier(t)}
								/>
								<span className="text-ink-700 dark:text-ink-200">
									{TERM_TIER_LABEL[t]}
								</span>
							</label>
						))}
					</div>
				</fieldset>

				<fieldset>
					<legend className="text-xs uppercase tracking-wide text-ink-400 mb-1.5">
						全稱還是縮寫
					</legend>
					<div className="grid grid-cols-2 gap-2">
						{(["long", "abbrev"] as const).map((f) => (
							<label
								key={f}
								className="flex items-center gap-2 p-2.5 rounded border border-ink-100 dark:border-ink-700 cursor-pointer hover:border-ink-300 dark:hover:border-ink-600"
							>
								<input
									type="radio"
									name="propose-form"
									className="accent-[#a8442a]"
									checked={form === f}
									onChange={() => setForm(f)}
								/>
								<span className="text-ink-700 dark:text-ink-200">{FORM_LABEL[f]}</span>
							</label>
						))}
					</div>
				</fieldset>

				<div>
					<label className="block text-xs uppercase tracking-wide text-ink-400 mb-1.5">
						理由(選填)
					</label>
					<textarea
						value={rationale}
						onChange={(e) => setRationale(e.target.value)}
						rows={2}
						placeholder="為什麼這個寫法也該算對?"
						className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded px-3 py-2 text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent resize-y"
					/>
				</div>

				{error && <p className="text-accent text-xs break-words">{error}</p>}
				{notice && (
					<p className="text-emerald-700 dark:text-emerald-400 text-xs">{notice}</p>
				)}

				<button
					type="button"
					onClick={submit}
					disabled={!canSubmit}
					className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-accent hover:bg-accent-dark text-white text-sm font-medium disabled:opacity-40"
				>
					{busy && <Loader2 size={14} className="animate-spin" />}
					送出提報
				</button>
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// 個人筆記 —— 一個診斷可以有多則,私有(僅自己看得到)。介面同 NoteSwitcher.tsx
// 的視覺慣例(切換 + 下拉 + 新增),但沒有拖曳排序 —— 後端沒有排序 API
// (worker/routes/smear-community.ts 的檔頭已經說明:v1 純附加順序),
// 這裡也就沒有理由做一個後端接不住的手勢。
// ---------------------------------------------------------------------------
function parseNoteDoc(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

function NotesPane({ dxId }: { dxId: string }) {
	const [notes, setNotes] = useState<SmearNote[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [edit, setEdit] = useState<{ noteId: string; content: any } | null>(null);
	const [busy, setBusy] = useState(false);
	const switcherRef = useRef<HTMLDivElement>(null);
	useDismiss(switcherOpen, switcherRef, () => setSwitcherOpen(false));

	useEffect(() => {
		let cancelled = false;
		setNotes(null);
		setError(null);
		setActiveId(null);
		setEdit(null);
		fetchSmearNotes(dxId)
			.then((r) => {
				if (cancelled) return;
				const items = r.items ?? [];
				setNotes(items);
				setActiveId(items[0]?.id ?? null);
			})
			.catch((e) => {
				if (cancelled) return;
				setNotes([]);
				setError(e instanceof ApiError ? `讀取失敗 (${e.status})` : String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [dxId]);

	const list = notes ?? [];
	const activeIdx = list.findIndex((n) => n.id === activeId);
	const active = activeIdx >= 0 ? list[activeIdx] : null;

	function step(dir: -1 | 1) {
		if (list.length === 0) return;
		const i = activeIdx < 0 ? 0 : (activeIdx + dir + list.length) % list.length;
		setActiveId(list[i].id);
		setEdit(null);
	}

	async function addNote() {
		setBusy(true);
		try {
			const created = await createSmearNote(dxId, { type: "doc", content: [] });
			setNotes((prev) => [...(prev ?? []), created]);
			setActiveId(created.id);
			setEdit({ noteId: created.id, content: { type: "doc", content: [] } });
		} catch {
			alert("新增筆記失敗,請稍後再試。");
		} finally {
			setBusy(false);
		}
	}

	function startEdit(n: SmearNote) {
		setEdit({ noteId: n.id, content: parseNoteDoc(n.content_json) ?? { type: "doc", content: [] } });
	}

	async function saveEdit() {
		if (!edit) return;
		setBusy(true);
		try {
			await updateSmearNote(edit.noteId, edit.content);
			const now = Date.now();
			setNotes((prev) =>
				(prev ?? []).map((n) =>
					n.id === edit.noteId
						? { ...n, content_json: JSON.stringify(edit.content), updated_at: now }
						: n,
				),
			);
			setEdit(null);
		} catch {
			alert("儲存失敗,請稍後再試。");
		} finally {
			setBusy(false);
		}
	}

	async function removeNote(n: SmearNote) {
		if (!confirm("刪除這則筆記?此動作無法復原。")) return;
		setBusy(true);
		try {
			await deleteSmearNote(n.id);
			setNotes((prev) => {
				const next = (prev ?? []).filter((x) => x.id !== n.id);
				if (activeId === n.id) setActiveId(next[0]?.id ?? null);
				return next;
			});
			if (edit?.noteId === n.id) setEdit(null);
		} catch {
			alert("刪除失敗,請稍後再試。");
		} finally {
			setBusy(false);
		}
	}

	if (notes === null) {
		return (
			<p className="inline-flex items-center gap-2 text-sm text-ink-400 dark:text-ink-500 py-6">
				<Loader2 size={15} className="animate-spin" /> 載入中…
			</p>
		);
	}
	if (error) {
		return <p className="text-accent text-sm py-6">讀取失敗:{error}</p>;
	}

	return (
		<div className="space-y-3">
			<p className="text-xs text-ink-400 dark:text-ink-500">僅你可見,不會出現在討論串。</p>

			{list.length === 0 ? (
				<p className="text-sm text-ink-400 dark:text-ink-500">
					還沒有筆記,寫第一則吧。
				</p>
			) : (
				<div className="flex items-center gap-1" ref={switcherRef}>
					{list.length > 1 && (
						<button
							type="button"
							onClick={() => step(-1)}
							aria-label="上一則筆記"
							className="shrink-0 rounded p-1.5 text-ink-400 dark:text-ink-500 hover:bg-ink-100 hover:text-accent dark:hover:bg-ink-700 transition"
						>
							<ChevronLeft size={16} />
						</button>
					)}
					<div className="relative flex-1 min-w-0">
						<button
							type="button"
							onClick={() => setSwitcherOpen((v) => !v)}
							aria-haspopup="listbox"
							aria-expanded={switcherOpen}
							className="w-full min-w-0 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border border-ink-200 dark:border-ink-700 text-sm text-ink-800 dark:text-ink-100 hover:border-accent transition"
						>
							<span className="truncate">
								{active
									? noteTitleFromJson(active.content_json, "未命名筆記", NOTE_TITLE_NARROW)
									: "未命名筆記"}
							</span>
							{list.length > 1 && (
								<span className="shrink-0 text-xs text-ink-400 dark:text-ink-500 tabular-nums">
									{activeIdx + 1}/{list.length}
								</span>
							)}
						</button>
						{switcherOpen && (
							<ul
								role="listbox"
								className="absolute z-20 mt-1 w-full bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded shadow-lg max-h-60 overflow-y-auto text-sm"
							>
								{list.map((n, i) => (
									<li key={n.id}>
										<button
											type="button"
											role="option"
											aria-selected={n.id === activeId}
											onClick={() => {
												setActiveId(n.id);
												setEdit(null);
												setSwitcherOpen(false);
											}}
											className={
												"w-full text-left px-3 py-2 truncate transition " +
												(n.id === activeId
													? "bg-accent text-white"
													: "text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700")
											}
										>
											{i + 1}. {noteTitleFromJson(n.content_json)}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					{list.length > 1 && (
						<button
							type="button"
							onClick={() => step(1)}
							aria-label="下一則筆記"
							className="shrink-0 rounded p-1.5 text-ink-400 dark:text-ink-500 hover:bg-ink-100 hover:text-accent dark:hover:bg-ink-700 transition"
						>
							<ChevronRight size={16} />
						</button>
					)}
				</div>
			)}

			<button
				type="button"
				onClick={addNote}
				disabled={busy}
				className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-dark disabled:opacity-50"
			>
				<Plus size={14} /> 新增筆記
			</button>

			{active &&
				(edit?.noteId === active.id ? (
					<div className="space-y-2">
						<RichEditor
							content={edit.content}
							autofocus
							onChange={(j) => setEdit((e) => (e ? { ...e, content: j } : e))}
							placeholder="寫下你對這個診斷的筆記…"
						/>
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => setEdit(null)}
								className="px-3 py-1.5 text-sm text-ink-600 dark:text-ink-300 hover:text-ink-800 dark:hover:text-ink-100"
							>
								取消
							</button>
							<button
								type="button"
								onClick={saveEdit}
								disabled={busy}
								className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent-dark disabled:opacity-50"
							>
								{busy ? "儲存中…" : "儲存"}
							</button>
						</div>
					</div>
				) : (
					<div className="border border-ink-100 dark:border-ink-700 rounded-lg p-3">
						<div className="prose prose-sm break-words">
							<StaticContent content={parseNoteDoc(active.content_json)} />
						</div>
						<div className="flex gap-3 mt-2 text-xs text-ink-500 dark:text-ink-400">
							<button
								type="button"
								onClick={() => startEdit(active)}
								className="hover:text-accent"
							>
								編輯
							</button>
							<button
								type="button"
								onClick={() => removeNote(active)}
								disabled={busy}
								className="hover:text-accent disabled:opacity-50"
							>
								刪除
							</button>
						</div>
					</div>
				))}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 相似 —— 容易混淆的診斷。這一塊資料早就在 GET /api/smear/dx/:id 的
// `related[]` 裡(見 worker/routes/smear.ts),零新後端需求,原封不動搬過來。
// ---------------------------------------------------------------------------
function SimilarPane({ related }: { related: SmearDxDetail["related"] }) {
	if (related.length === 0) {
		return (
			<p className="text-sm text-ink-400 dark:text-ink-500">
				目前還沒有標記容易混淆的診斷。
			</p>
		);
	}
	return (
		<div className="flex flex-wrap gap-1.5">
			{related.map((r) => (
				<Link
					key={r.dx_id}
					to={`/smear/dx/${r.dx_id}`}
					className="px-2.5 py-1 rounded-full border border-ink-200 dark:border-ink-700 text-xs text-ink-700 dark:text-ink-200 hover:border-accent hover:text-accent transition max-w-full break-words"
				>
					{r.canonical_long}
				</Link>
			))}
		</div>
	);
}
