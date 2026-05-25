import { useMemo, useState } from 'react';
import { AlertTriangle, Check, X, MessageSquare } from 'lucide-react';
import { ApiError } from '../lib/api';
import { useChallenge, type ActiveChallenge, type ResolvedChallenge } from '../hooks/useChallenge';
import { RichEditor } from './RichEditor';
import { ReadOnlyContent } from './ReadOnlyContent';

type Props = {
  questionId: string;
  /** Letters the proposer may pick from (excludes the current canonical answer). */
  currentAnswer: string;
  availableLetters: string[];
  /** Current user email — proposer cannot vote on own challenge. */
  meEmail: string | null;
};

const RECENT_PILL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

export function ChallengePanel({ questionId, currentAnswer, availableLetters, meEmail }: Props) {
  const { active, recent, file, vote, retract, withdraw, refresh } = useChallenge(questionId);
  const [filing, setFiling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Most recent promoted challenge in the last 30d, for the "recently corrected" pill.
  const recentPromotion = useMemo<ResolvedChallenge | null>(() => {
    const now = Date.now();
    return (
      recent.find(
        (c) =>
          c.status === 'promoted' &&
          c.resolved_at !== null &&
          now - (c.resolved_at as number) < RECENT_PILL_MS,
      ) ?? null
    );
  }, [recent]);

  if (active === undefined) {
    // Loading — render nothing to avoid layout flicker. Reviewed below the
    // answer-reveal block; a momentary blank is preferable to a flashy skeleton.
    return null;
  }

  return (
    <div className="mt-4 space-y-3">
      {active && (
        <ActiveBanner
          challenge={active}
          meEmail={meEmail}
          onVote={(v) => doWith(() => vote(active.id, v))}
          onRetract={() => doWith(() => retract(active.id))}
          onWithdraw={() => doWith(() => withdraw(active.id))}
        />
      )}

      {!active && recentPromotion && (
        <RecentPromotionPill challenge={recentPromotion} />
      )}

      {!active && (
        <FileChallengeButton
          onOpen={() => {
            setError(null);
            setFiling(true);
          }}
        />
      )}

      {filing && (
        <FileChallengeModal
          currentAnswer={currentAnswer}
          availableLetters={availableLetters}
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
                setError('已有進行中的挑戰,請先參與既有討論。');
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
}: {
  challenge: ActiveChallenge;
  meEmail: string | null;
  onVote: (vote: 'agree' | 'disagree') => void | Promise<void>;
  onRetract: () => void | Promise<void>;
  onWithdraw: () => void | Promise<void>;
}) {
  const [showRationale, setShowRationale] = useState(false);
  const isProposer = meEmail !== null && meEmail === challenge.proposer_email;
  const proposerLabel =
    challenge.proposer_name && challenge.proposer_name.trim().length > 0
      ? challenge.proposer_name
      : challenge.proposer_email.split('@')[0];

  const statusPill =
    challenge.status === 'contested' ? (
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
        <AlertTriangle className="text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" size={16} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-ink-800 dark:text-ink-100 flex items-center gap-2 flex-wrap">
            <span className="font-medium">{proposerLabel}</span>
            <span className="text-ink-600 dark:text-ink-300">主張正解應為</span>
            <span className="font-mono font-semibold text-amber-800 dark:text-amber-200">
              {challenge.proposed_answer}
            </span>
            <span className="text-ink-400 dark:text-ink-500">(原 {challenge.original_answer_at_challenge})</span>
            {statusPill}
          </div>
          <div className="mt-1 text-xs text-ink-500 dark:text-ink-400">
            同意 <span className="font-mono text-emerald-700 dark:text-emerald-300">{challenge.agrees}</span>{' '}
            · 反對 <span className="font-mono text-rose-700 dark:text-rose-300">{challenge.disagrees}</span>
            {challenge.status === 'open' ? (
              <span className="ml-2 text-ink-400 dark:text-ink-500">· 2 票同意 + 0 反對即自動修正答案</span>
            ) : (
              <span className="ml-2 text-ink-400 dark:text-ink-500">· 已有反對,需更高共識</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {!isProposer && (
          <>
            <VoteButton
              variant="agree"
              active={challenge.my_vote === 'agree'}
              onClick={() => onVote('agree')}
            />
            <VoteButton
              variant="disagree"
              active={challenge.my_vote === 'disagree'}
              onClick={() => onVote('disagree')}
            />
            {challenge.my_vote !== null && (
              <button
                onClick={onRetract}
                className="text-xs text-ink-500 hover:text-ink-700 dark:hover:text-ink-300"
              >
                撤回投票
              </button>
            )}
          </>
        )}
        {isProposer && (
          <button
            onClick={onWithdraw}
            className="px-3 py-1.5 text-sm rounded border border-ink-200 dark:border-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-700"
          >
            撤回挑戰
          </button>
        )}
        <button
          onClick={() => setShowRationale((v) => !v)}
          className="ml-auto text-xs text-ink-600 dark:text-ink-300 hover:text-accent inline-flex items-center gap-1"
        >
          <MessageSquare size={12} /> {showRationale ? '收起理由' : '查看挑戰理由'}
        </button>
      </div>

      {showRationale && !!rationaleDoc && (
        <article className="mt-3 pt-3 border-t border-amber-200 dark:border-amber-700/60 prose-tight">
          <ReadOnlyContent content={rationaleDoc} />
        </article>
      )}
    </div>
  );
}

function VoteButton({
  variant,
  active,
  onClick,
}: {
  variant: 'agree' | 'disagree';
  active: boolean;
  onClick: () => void;
}) {
  const isAgree = variant === 'agree';
  const base =
    'inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border transition';
  const activeCls = isAgree
    ? ' bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
    : ' bg-rose-600 text-white border-rose-600 hover:bg-rose-700';
  const idleCls = isAgree
    ? ' border-emerald-300 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/30'
    : ' border-rose-300 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-900/30';
  return (
    <button onClick={onClick} className={base + (active ? activeCls : idleCls)}>
      {isAgree ? <Check size={14} /> : <X size={14} />}
      {isAgree ? '同意挑戰' : '反對'}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────
// Recent-promotion pill
// ──────────────────────────────────────────────────────────────

function RecentPromotionPill({ challenge }: { challenge: ResolvedChallenge }) {
  const when = challenge.resolved_at
    ? new Date(challenge.resolved_at).toLocaleDateString('zh-TW')
    : '';
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700/60 text-emerald-800 dark:text-emerald-200">
      ✏️ {when} 由社群修正:
      <span className="font-mono">{challenge.original_answer_at_challenge}</span>
      →
      <span className="font-mono font-semibold">{challenge.proposed_answer}</span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// File-challenge entry button + modal
// ──────────────────────────────────────────────────────────────

function FileChallengeButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1"
      title="對本題答案有疑義?發起挑戰,讓社群投票決定。"
    >
      🤔 對答案有疑問?發起挑戰
    </button>
  );
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

function FileChallengeModal({
  currentAnswer,
  availableLetters,
  onCancel,
  onSubmit,
  error,
}: {
  currentAnswer: string;
  availableLetters: string[];
  onCancel: () => void;
  onSubmit: (proposed: string, rationale: unknown) => Promise<void>;
  error: string | null;
}) {
  const [proposed, setProposed] = useState<string | null>(null);
  const [doc, setDoc] = useState<unknown>(EMPTY_DOC);
  const [submitting, setSubmitting] = useState(false);

  const candidates = availableLetters.filter((L) => L !== currentAnswer);

  async function submit() {
    if (!proposed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(proposed, doc);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg shadow-xl max-w-2xl w-full p-5 sm:p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="font-serif text-lg text-ink-900 dark:text-ink-100 mb-3">
          發起答案挑戰
        </h3>
        <p className="text-sm text-ink-600 dark:text-ink-300 mb-4">
          目前正解為{' '}
          <span className="font-mono font-semibold">{currentAnswer}</span>。
          請選擇你認為應該是的答案,並簡述理由。當有 2 位同意且 0 反對時答案將自動修正;若有反對則進入討論。
        </p>

        <div className="mb-4">
          <div className="text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-2">主張答案應為</div>
          <div className="flex gap-2 flex-wrap">
            {candidates.map((L) => (
              <button
                key={L}
                onClick={() => setProposed(L)}
                className={
                  'w-10 h-10 rounded-full border-2 font-mono font-semibold transition ' +
                  (proposed === L
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-ink-300 dark:border-ink-600 text-ink-700 dark:text-ink-200 hover:border-accent')
                }
              >
                {L}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <div className="text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-2">理由(必填)</div>
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
            {submitting ? '送出中…' : '發起挑戰'}
          </button>
        </div>
      </div>
    </div>
  );
}
