import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
	ArrowLeft,
	ExternalLink,
	Loader2,
	ThumbsDown,
	ThumbsUp,
	Undo2,
} from "lucide-react";
import { ApiError } from "../lib/api";
import { isEmptyDoc } from "../lib/drafts";
import { useMe } from "../hooks/useMe";
import {
	fetchSmearDx,
	proposeSmearTerm,
	voteSmearTerm,
	retractSmearTermVote,
	SMEAR_TOPIC_LABELS,
	SMEAR_QTYPE_LABELS,
	type SmearDxDetail,
	type SmearProposedTerm,
	type SmearTier,
} from "../lib/smearApi";
import { StaticContent } from "../components/StaticContent";
import { SmearImage } from "../components/smear/SmearImage";
import { TIER_META, TERM_TIER_ORDER } from "../components/smear/GradeReveal";

// /smear/dx/:id —— 診斷詳情頁(D5)。單欄堆疊,同 SmearSession.tsx 的判斷:
// 這一頁的內容(詳解 → 可接受寫法 → 圖片 → 相關診斷 → 提報表單)是循序閱讀,
// 不是需要並排比對的東西,桌機兩欄只會留白。

const TERM_TIER_LABEL: Record<SmearTier, string> = {
	full: "全分",
	half: "半分",
	lay: "俗名(不計分)",
};

const FORM_LABEL: Record<"long" | "abbrev", string> = {
	long: "全稱",
	abbrev: "縮寫",
};

export function SmearDx() {
	const { id } = useParams<{ id: string }>();
	const { me } = useMe();

	const [dx, setDx] = useState<SmearDxDetail | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	// 提報中的詞是純 client state —— GET /dx/:id 只回 status='accepted' 的列,
	// 剛提報成功的詞要靠這裡才看得到自己的提案,見 smearApi.ts 的說明。
	const [proposals, setProposals] = useState<SmearProposedTerm[]>([]);
	// 我對每個提案投的票,server 的投票端點不回這個,自己記(id → agree)。
	const [myVotes, setMyVotes] = useState<Record<string, boolean>>({});
	const [voteBusy, setVoteBusy] = useState<Record<string, boolean>>({});

	useEffect(() => {
		if (!id) return;
		let cancelled = false;
		setDx(null);
		setLoadError(null);
		setProposals([]);
		setMyVotes({});
		fetchSmearDx(id)
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
	}, [id]);

	const doc = useMemo(() => {
		const raw = dx?.note?.content_json;
		if (!raw) return null;
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}, [dx?.note?.content_json]);
	const noteEmpty = !doc || isEmptyDoc(doc);

	const groupedTerms = useMemo(() => {
		const g: Record<SmearTier, SmearDxDetail["terms"]> = { full: [], half: [], lay: [] };
		for (const t of dx?.terms ?? []) g[t.tier]?.push(t);
		return g;
	}, [dx?.terms]);

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

	if (loadError) {
		return (
			<div className="max-w-md mx-auto px-4 py-20 text-center">
				<p className="text-accent break-words">{loadError}</p>
				<Link
					to="/smear?tab=search"
					className="text-accent hover:text-accent-dark text-sm mt-4 inline-block"
				>
					← 回抹片練習
				</Link>
			</div>
		);
	}

	if (!dx) {
		return (
			<div className="max-w-md mx-auto px-4 py-20 text-center text-ink-400 dark:text-ink-500">
				<Loader2 className="animate-spin mx-auto mb-3" size={22} />
				載入中…
			</div>
		);
	}

	return (
		<div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 pb-20">
			<Link
				to="/smear?tab=search"
				className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1 mb-4"
			>
				<ArrowLeft size={14} /> 回抹片練習
			</Link>

			{/* 標題:break-words —— canonical_long 這類病理命名法不保證有天然斷行點
			    (同 GradeReveal「DEK::NUP214」那條)。 */}
			<h1 className="font-serif text-2xl text-ink-900 dark:text-ink-100 break-words">
				{dx.canonical_long}
				{dx.canonical_abbrev && (
					<span className="ml-2 text-lg text-ink-500 dark:text-ink-400 font-sans">
						({dx.canonical_abbrev})
					</span>
				)}
			</h1>
			<div className="flex flex-wrap gap-1.5 mt-2 mb-6">
				<span className="text-xs px-2 py-0.5 rounded-full border border-ink-300 dark:border-ink-600 text-ink-600 dark:text-ink-300">
					{SMEAR_TOPIC_LABELS[dx.topic] ?? dx.topic}
				</span>
				<span className="text-xs px-2 py-0.5 rounded-full border border-ink-300 dark:border-ink-600 text-ink-600 dark:text-ink-300">
					{SMEAR_QTYPE_LABELS[dx.qtype] ?? dx.qtype}
				</span>
			</div>

			{/* 詳解 —— 純閱讀,不需要畫記/自動挖空,走 StaticContent 不建 EditorView
			    (見 lib/staticDoc.ts 的說明與 CLAUDE.md「分頁的載入卡頓」那節)。 */}
			<section className="mb-8">
				{noteEmpty ? (
					<p className="text-sm text-ink-400 dark:text-ink-500">
						詳解尚未建立。
					</p>
				) : (
					<StaticContent content={doc} />
				)}
			</section>

			{/* 可接受的寫法,依 tier 分組 */}
			<section className="mb-8">
				<h2 className="text-xs uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-2">
					可接受的寫法
				</h2>
				<div className="flex flex-wrap gap-1.5">
					{TERM_TIER_ORDER.flatMap((tier) =>
						groupedTerms[tier].map((t) => (
							<span
								key={t.id}
								className={
									"px-2.5 py-1 rounded text-xs max-w-full break-words " +
									TIER_META[tier].chipCls
								}
							>
								<span aria-hidden="true">{TIER_META[tier].icon}</span> {t.text}
								<span className="ml-1 opacity-70">
									({FORM_LABEL[t.form]})
								</span>
							</span>
						)),
					)}
					{dx.terms.length === 0 && (
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
								onVote={(agree) => handleVote(p, agree)}
								onRetract={() => handleRetractVote(p)}
							/>
						))}
					</div>
				)}
			</section>

			{/* 圖片 —— 2 欄起跳(320px 也不會溢出),寬螢幕 3 欄 */}
			{dx.questions.length > 0 && (
				<section className="mb-8">
					<h2 className="text-xs uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-2">
						影像({dx.questions.length})
					</h2>
					<div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
						{dx.questions.map((q) => (
							<div key={q.id}>
								<SmearImage
									viewKey={q.image_key_view}
									fullKey={q.image_key_full}
									alt={dx.canonical_long}
								/>
								{q.source === "ash" && (
									<div className="mt-1 text-[10px] leading-tight text-ink-400 dark:text-ink-500 break-words">
										{q.attribution && <p className="break-words">{q.attribution}</p>}
										{q.source_url && (
											<a
												href={q.source_url}
												target="_blank"
												rel="noopener noreferrer"
												className="inline-flex items-center gap-0.5 text-accent hover:text-accent-dark"
											>
												ASH Image Bank <ExternalLink size={10} />
											</a>
										)}
									</div>
								)}
							</div>
						))}
					</div>
				</section>
			)}

			{/* 容易混淆的診斷 */}
			{dx.related.length > 0 && (
				<section className="mb-8">
					<h2 className="text-xs uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-2">
						容易混淆的診斷
					</h2>
					<div className="flex flex-wrap gap-1.5">
						{dx.related.map((r) => (
							<Link
								key={r.dx_id}
								to={`/smear/dx/${r.dx_id}`}
								className="px-2.5 py-1 rounded-full border border-ink-200 dark:border-ink-700 text-xs text-ink-700 dark:text-ink-200 hover:border-accent hover:text-accent transition max-w-full break-words"
							>
								{r.canonical_long}
							</Link>
						))}
					</div>
				</section>
			)}

			<ProposeTermForm
				dxId={dx.id}
				onProposed={(term) => setProposals((prev) => [...prev, term])}
				existingAccepted={dx.terms}
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
		<div className="flex flex-wrap items-center gap-2 rounded border border-ink-100 dark:border-ink-700 px-2.5 py-2 text-xs">
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
					setError(
						`這個寫法先前已被提報過(${e.data?.error ?? "重複"})。`,
					);
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
								<span className="text-ink-700 dark:text-ink-200">
									{FORM_LABEL[f]}
								</span>
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
