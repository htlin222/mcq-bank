import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
	AlertTriangle,
	Check,
	X,
	MessageSquare,
	Pencil,
	Loader2,
} from "lucide-react";
import { ApiError } from "../lib/api";
import {
	useChallenge,
	type ActiveChallenge,
	type ResolvedChallenge,
} from "../hooks/useChallenge";
import { RichEditor } from "./RichEditor";
import { StaticContent } from "./StaticContent";

type Props = {
	questionId: string;
	/** Letters the proposer may pick from (excludes the current canonical answer). */
	currentAnswer: string;
	availableLetters: string[];
	/** Current user email — proposer cannot vote on own challenge. */
	meEmail: string | null;
};

export function ChallengePanel({
	questionId,
	currentAnswer,
	availableLetters,
	meEmail,
}: Props) {
	const {
		active,
		recent,
		file,
		vote,
		retract,
		withdraw,
		editRationale,
		refresh,
	} = useChallenge(questionId);
	const [filing, setFiling] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Most recent promoted challenge — shown permanently so the community
	// correction (and its rationale) stays visible on the question.
	const recentPromotion = useMemo<ResolvedChallenge | null>(
		() => recent.find((c) => c.status === "promoted") ?? null,
		[recent],
	);

	if (active === undefined) {
		// Loading — render nothing to avoid layout flicker. Reviewed below the
		// answer-reveal block; a momentary blank is preferable to a flashy skeleton.
		return null;
	}

	// Letters already under an active challenge — can't be re-proposed.
	const challengedLetters = active.map((c) => c.proposed_answer);

	return (
		<div className="mt-4 space-y-3">
			{active.map((ch) => (
				<ActiveBanner
					key={ch.id}
					challenge={ch}
					meEmail={meEmail}
					onVote={(v) => doWith(() => vote(ch.id, v))}
					onRetract={() => doWith(() => retract(ch.id))}
					onWithdraw={() => doWith(() => withdraw(ch.id))}
					onEditRationale={(doc) => editRationale(ch.id, doc)}
				/>
			))}

			{active.length === 0 && recentPromotion && (
				<RecentPromotionPill challenge={recentPromotion} />
			)}

			{/* Vote/withdraw failures used to set `error` and then render nowhere —
          the modal is the only thing that ever displayed it. On a slow link
          that reads exactly like the request still being in flight. */}
			{error && !filing && (
				<div
					role="alert"
					className="p-2 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700/60 text-rose-800 dark:text-rose-300 text-sm"
				>
					{error}
				</div>
			)}

			<FileChallengeButton
				hasActive={active.length > 0}
				onOpen={() => {
					setError(null);
					setFiling(true);
				}}
			/>

			{filing && (
				<FileChallengeModal
					currentAnswer={currentAnswer}
					availableLetters={availableLetters}
					challengedLetters={challengedLetters}
					onCancel={() => {
						setFiling(false);
						setError(null);
					}}
					onSubmit={async (letter, doc) => {
						setError(null);
						try {
							await file(letter, doc);
							setFiling(false);
						} catch (e) {
							if (e instanceof ApiError && e.status === 409) {
								setError("該答案已有進行中的挑戰,請參與既有挑戰的投票。");
								await refresh();
							} else if (e instanceof ApiError) {
								setError(String(e.data?.error ?? e.message));
							} else {
								setError(String(e));
							}
						}
					}}
					error={error}
				/>
			)}
		</div>
	);

	async function doWith(fn: () => Promise<void>) {
		setError(null);
		try {
			await fn();
		} catch (e) {
			if (e instanceof ApiError) {
				setError(String(e.data?.error ?? e.message));
			} else {
				setError(String(e));
			}
		}
	}
}

// ──────────────────────────────────────────────────────────────
// Active challenge banner
// ──────────────────────────────────────────────────────────────

function ActiveBanner({
	challenge,
	meEmail,
	onVote,
	onRetract,
	onWithdraw,
	onEditRationale,
}: {
	challenge: ActiveChallenge;
	meEmail: string | null;
	onVote: (vote: "agree" | "disagree") => void | Promise<void>;
	onRetract: () => void | Promise<void>;
	onWithdraw: () => void | Promise<void>;
	onEditRationale: (doc: unknown) => Promise<void>;
}) {
	// Expanded by default; collapsible to save vertical space when several
	// challenges are active at once.
	const [showRationale, setShowRationale] = useState(true);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<unknown>(null);
	const [saving, setSaving] = useState(false);
	// Which action is in flight. Voting is a single round trip to a Worker over
	// an Access-authenticated connection — on a cold Worker that is seconds, not
	// milliseconds, and without this the row does not change in any way while it
	// runs, so the press reads as dropped and gets repeated.
	const [pending, setPending] = useState<
		"agree" | "disagree" | "retract" | "withdraw" | null
	>(null);
	const isProposer = meEmail !== null && meEmail === challenge.proposer_email;
	const proposerLabel =
		challenge.proposer_name && challenge.proposer_name.trim().length > 0
			? challenge.proposer_name
			: challenge.proposer_email.split("@")[0];

	const statusPill =
		challenge.status === "contested" ? (
			<span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200">
				<AlertTriangle size={11} /> 討論中
			</span>
		) : (
			<span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-sky-100 dark:bg-sky-900/30 text-sky-800 dark:text-sky-200">
				表決中
			</span>
		);

	let rationaleDoc: unknown = null;
	try {
		rationaleDoc = JSON.parse(challenge.rationale_json);
	} catch {
		rationaleDoc = null;
	}

	return (
		<div className="bg-amber-50/70 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-700/60 rounded-lg p-4">
			<div className="flex items-start gap-2 flex-wrap">
				<AlertTriangle
					className="text-amber-700 dark:text-amber-300 shrink-0 mt-0.5"
					size={16}
				/>
				<div className="flex-1 min-w-0">
					<div className="text-sm text-ink-800 dark:text-ink-100 flex items-center gap-2 flex-wrap">
						<span className="font-medium">{proposerLabel}</span>
						<span className="text-ink-600 dark:text-ink-300">主張正解應為</span>
						<span className="font-mono font-semibold text-amber-800 dark:text-amber-200">
							{challenge.proposed_answer}
						</span>
						<span className="text-ink-400 dark:text-ink-500">
							(原 {challenge.original_answer_at_challenge})
						</span>
						{statusPill}
					</div>
					<div className="mt-1 text-xs text-ink-500 dark:text-ink-400">
						同意{" "}
						<span className="font-mono text-emerald-700 dark:text-emerald-300">
							{challenge.agrees}
						</span>{" "}
						· 反對{" "}
						<span className="font-mono text-rose-700 dark:text-rose-300">
							{challenge.disagrees}
						</span>
						{challenge.status === "open" ? (
							<span className="ml-2 text-ink-400 dark:text-ink-500">
								· 2 票同意 + 0 反對即自動修正答案
							</span>
						) : (
							<span className="ml-2 text-ink-400 dark:text-ink-500">
								· 已有反對,需更高共識
							</span>
						)}
					</div>
				</div>
			</div>

			<div className="mt-3 flex items-center gap-2 flex-wrap">
				{!isProposer && (
					<>
						<VoteButton
							variant="agree"
							active={challenge.my_vote === "agree"}
							loading={pending === "agree"}
							disabled={pending !== null}
							onClick={() => run("agree", () => onVote("agree"))}
						/>
						<VoteButton
							variant="disagree"
							active={challenge.my_vote === "disagree"}
							loading={pending === "disagree"}
							disabled={pending !== null}
							onClick={() => run("disagree", () => onVote("disagree"))}
						/>
						{challenge.my_vote !== null && (
							<button
								onClick={() => run("retract", onRetract)}
								disabled={pending !== null}
								aria-busy={pending === "retract"}
								className="text-xs text-ink-500 hover:text-ink-700 dark:hover:text-ink-300 inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{pending === "retract" && (
									<Loader2 size={11} className="animate-spin" />
								)}
								撤回投票
							</button>
						)}
					</>
				)}
				{isProposer && (
					<button
						onClick={() => run("withdraw", onWithdraw)}
						disabled={pending !== null}
						aria-busy={pending === "withdraw"}
						className="px-3 py-1.5 text-sm rounded border border-ink-200 dark:border-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-700 inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{pending === "withdraw" && (
							<Loader2 size={13} className="animate-spin" />
						)}
						撤回挑戰
					</button>
				)}
				<span className="ml-auto inline-flex items-center gap-3">
					{isProposer && !editing && (
						<button
							onClick={() => {
								setDraft(rationaleDoc ?? EMPTY_DOC);
								setEditing(true);
								setShowRationale(true);
							}}
							className="text-xs text-ink-600 dark:text-ink-300 hover:text-accent inline-flex items-center gap-1"
						>
							<Pencil size={12} /> 編輯理由
						</button>
					)}
					<button
						onClick={() => setShowRationale((v) => !v)}
						className="text-xs text-ink-600 dark:text-ink-300 hover:text-accent inline-flex items-center gap-1"
					>
						<MessageSquare size={12} />{" "}
						{showRationale ? "收起理由" : "查看挑戰理由"}
					</button>
				</span>
			</div>

			{showRationale && editing && (
				<div className="mt-3 pt-3 border-t border-amber-200 dark:border-amber-700/60">
					<RichEditor content={draft} onChange={setDraft} autofocus />
					<div className="mt-2 flex gap-3 justify-end">
						<button
							onClick={() => setEditing(false)}
							disabled={saving}
							className="px-3 py-1.5 text-xs text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100"
						>
							取消
						</button>
						<button
							onClick={async () => {
								if (saving) return;
								setSaving(true);
								try {
									await onEditRationale(draft);
									setEditing(false);
								} catch (e) {
									alert(
										"儲存失敗:" +
											String(
												e instanceof ApiError
													? (e.data?.error ?? e.message)
													: e,
											),
									);
								} finally {
									setSaving(false);
								}
							}}
							disabled={saving}
							className="bg-accent hover:bg-accent-dark text-white px-4 py-1.5 text-xs rounded font-medium disabled:opacity-40"
						>
							{saving ? "儲存中…" : "儲存理由"}
						</button>
					</div>
				</div>
			)}

			{showRationale && !editing && !!rationaleDoc && (
				<article className="mt-3 pt-3 border-t border-amber-200 dark:border-amber-700/60 prose-tight">
					<StaticContent content={rationaleDoc} />
				</article>
			)}
		</div>
	);

	// The banner unmounts when a vote resolves the challenge; the trailing
	// setPending is then a no-op rather than a leak (React 18).
	async function run(
		kind: "agree" | "disagree" | "retract" | "withdraw",
		fn: () => void | Promise<void>,
	) {
		if (pending) return;
		setPending(kind);
		try {
			await fn();
		} finally {
			setPending(null);
		}
	}
}

function VoteButton({
	variant,
	active,
	loading,
	disabled,
	onClick,
}: {
	variant: "agree" | "disagree";
	active: boolean;
	/** This button's own request is in flight — it gets the spinner. */
	loading: boolean;
	/** Any action on the banner is in flight — everything else just dims. */
	disabled: boolean;
	onClick: () => void;
}) {
	const isAgree = variant === "agree";
	const base =
		"inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border transition";
	const activeCls = isAgree
		? " bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
		: " bg-rose-600 text-white border-rose-600 hover:bg-rose-700";
	const idleCls = isAgree
		? " border-emerald-300 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
		: " border-rose-300 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/30";
	// The spinner replaces the icon rather than sitting next to it, so the row
	// doesn't reflow the moment you press — a shifting button under the cursor
	// is its own kind of "did that register?".
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			aria-busy={loading}
			className={
				base +
				(active ? activeCls : idleCls) +
				" disabled:opacity-50 disabled:cursor-not-allowed"
			}
		>
			{loading ? (
				<Loader2 size={14} className="animate-spin" />
			) : isAgree ? (
				<Check size={14} />
			) : (
				<X size={14} />
			)}
			{isAgree ? "同意挑戰" : "反對"}
		</button>
	);
}

// ──────────────────────────────────────────────────────────────
// Recent-promotion pill
// ──────────────────────────────────────────────────────────────

function RecentPromotionPill({ challenge }: { challenge: ResolvedChallenge }) {
	// The promotion rationale stays readable after the flip — expanded by
	// default, collapsible to save space.
	const [showRationale, setShowRationale] = useState(true);
	const when = challenge.resolved_at
		? new Date(challenge.resolved_at).toLocaleDateString("zh-TW")
		: "";

	let rationaleDoc: unknown = null;
	try {
		rationaleDoc = JSON.parse(challenge.rationale_json);
	} catch {
		rationaleDoc = null;
	}

	return (
		<div className="rounded-lg px-4 py-3 text-xs bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700/60 text-emerald-800 dark:text-emerald-200">
			<div className="flex items-center gap-2 flex-wrap">
				✏️ {when} 由社群修正:
				<span className="font-mono">
					{challenge.original_answer_at_challenge}
				</span>
				→
				<span className="font-mono font-semibold">
					{challenge.proposed_answer}
				</span>
				<span className="text-emerald-700/70 dark:text-emerald-300/70">
					(由 {challenge.proposer_email.split("@")[0]} 發起)
				</span>
				{!!rationaleDoc && (
					<button
						onClick={() => setShowRationale((v) => !v)}
						className="ml-auto inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:hover:text-emerald-100"
					>
						<MessageSquare size={12} />{" "}
						{showRationale ? "收起理由" : "查看修正理由"}
					</button>
				)}
			</div>
			{showRationale && !!rationaleDoc && (
				<article className="mt-2.5 pt-2.5 border-t border-emerald-200 dark:border-emerald-700/60 prose-tight text-sm text-ink-800 dark:text-ink-200">
					<StaticContent content={rationaleDoc} />
				</article>
			)}
		</div>
	);
}

// ──────────────────────────────────────────────────────────────
// File-challenge entry button + modal
// ──────────────────────────────────────────────────────────────

function FileChallengeButton({
	hasActive,
	onOpen,
}: {
	hasActive: boolean;
	onOpen: () => void;
}) {
	return (
		<button
			onClick={onOpen}
			className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1"
			title="對本題答案有疑義?發起挑戰,讓社群投票決定。"
		>
			{hasActive ? "🤔 主張其他答案?發起新挑戰" : "🤔 對答案有疑問?發起挑戰"}
		</button>
	);
}

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

function FileChallengeModal({
	currentAnswer,
	availableLetters,
	challengedLetters,
	onCancel,
	onSubmit,
	error,
}: {
	currentAnswer: string;
	availableLetters: string[];
	/** Letters already under an active challenge — vote there instead. */
	challengedLetters: string[];
	onCancel: () => void;
	onSubmit: (proposed: string, rationale: unknown) => Promise<void>;
	error: string | null;
}) {
	const [proposed, setProposed] = useState<string | null>(null);
	const [doc, setDoc] = useState<unknown>(EMPTY_DOC);
	const [submitting, setSubmitting] = useState(false);

	const candidates = availableLetters.filter(
		(L) => L !== currentAnswer && !challengedLetters.includes(L),
	);

	async function submit() {
		if (!proposed || submitting) return;
		setSubmitting(true);
		try {
			await onSubmit(proposed, doc);
		} finally {
			setSubmitting(false);
		}
	}

	// Portal to <body> so the overlay escapes the question column's `lg:sticky`
	// stacking context — otherwise z-index is scoped to that context and the
	// modal renders behind the sticky header on wide screens (issue #10).
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-scrim"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onCancel();
			}}
		>
			<div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-xl max-w-2xl w-full p-5 sm:p-6 max-h-full overflow-y-auto">
				<h3 className="font-serif text-lg text-ink-900 dark:text-ink-100 mb-3">
					發起答案挑戰
				</h3>
				<p className="text-sm text-ink-600 dark:text-ink-300 mb-4">
					目前正解為{" "}
					<span className="font-mono font-semibold">{currentAnswer}</span>。
					請選擇你認為應該是的答案,並簡述理由。當有 2 位同意且 0
					反對時答案將自動修正;若有反對則進入討論。
				</p>

				<div className="mb-4">
					<div className="text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-2">
						主張答案應為
					</div>
					{candidates.length === 0 && (
						<p className="text-sm text-ink-500 dark:text-ink-400">
							所有其他選項都已有進行中的挑戰,請直接參與投票。
						</p>
					)}
					<div className="flex gap-2 flex-wrap">
						{candidates.map((L) => (
							<button
								key={L}
								onClick={() => setProposed(L)}
								className={
									"w-10 h-10 rounded-full border-2 font-mono font-semibold transition " +
									(proposed === L
										? "border-accent bg-accent/10 text-accent"
										: "border-ink-300 dark:border-ink-600 text-ink-700 dark:text-ink-200 hover:border-accent")
								}
							>
								{L}
							</button>
						))}
					</div>
				</div>

				<div className="mb-4">
					<div className="text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-2">
						理由(必填)
					</div>
					<RichEditor
						content={doc}
						onChange={setDoc}
						placeholder="說明為什麼你認為這題答案應該不同。引用指引、文獻,或補充臨床判讀重點都歡迎。"
						autofocus
					/>
				</div>

				{error && (
					<div className="mb-3 p-2 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700/60 text-rose-800 dark:text-rose-300 text-sm">
						{error}
					</div>
				)}

				<div className="flex gap-3 justify-end">
					<button
						onClick={onCancel}
						disabled={submitting}
						className="px-4 py-2 text-sm text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-ink-100"
					>
						取消
					</button>
					<button
						onClick={submit}
						disabled={!proposed || submitting}
						className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40"
					>
						{submitting ? "送出中…" : "發起挑戰"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
