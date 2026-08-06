import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useMe } from '../hooks/useMe';

/**
 * 加入新年份 — 五步精靈。
 *
 * 設計文件:docs/plans/2026-08-06-new-year-ingest-design.md
 *
 * 精靈**不存自己的進度**。目前該顯示到第幾步,完全由伺服器狀態推導:有沒有
 * 心跳、有沒有進行中的 job、job 跑到哪個 stage。重新整理、換一台電腦打開,
 * 都會回到正確的位置。(CLAUDE.md:別用 localStorage 存 app state。)
 */

type Job = {
  id: string;
  year: number;
  created_by: string;
  stage: 'ready' | 'parsing' | 'parsed' | 'explaining' | 'pushed' | 'published';
  detail: string | null;
  question_count: number;
  needs_review: number;
  created_at: number;
  updated_at: number;
};

type Status = {
  configured: boolean;
  key_version: number;
  last_seen_at: number | null;
  jobs: Job[];
  server_now: number;
};

type StagedQuestion = {
  number: number;
  group: string;
  stem: string;
  options: Record<string, string>;
  answer: string;
  tags: string[];
  confidence: number;
  explanation_doc: unknown | null;
};

type JobDetail = {
  job: Job;
  questions: StagedQuestion[];
  blockers: string[];
  expected_total: number;
};

// 心跳多久算「還活著」。skill 只在啟動與各階段回報,所以窗口要比一次解析的
// 時間寬鬆得多,否則跑到一半會誤報離線。
const HEARTBEAT_FRESH_MS = 30 * 60 * 1000;
const STALL_MS = 5 * 60 * 1000;

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  return `${Math.round(m / 60)} 小時前`;
}

function Cmd({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className="bg-ink-900 dark:bg-black/40 text-ink-100 rounded px-4 py-3 text-xs overflow-x-auto">
        <code>{children}</code>
      </pre>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-2 right-2 text-[11px] px-2 py-1 rounded bg-white/10 text-ink-200 hover:bg-white/20 transition"
      >
        {copied ? '已複製' : '複製'}
      </button>
    </div>
  );
}

function Step({
  n,
  title,
  state,
  children,
}: {
  n: number;
  title: string;
  state: 'done' | 'active' | 'todo';
  children: React.ReactNode;
}) {
  const badge =
    state === 'done'
      ? 'bg-accent text-white border-accent'
      : state === 'active'
        ? 'border-accent text-accent'
        : 'border-ink-300 dark:border-ink-700 text-ink-400';
  return (
    <section
      className={`border rounded-lg p-5 mb-4 transition ${
        state === 'active'
          ? 'border-accent/50 bg-accent/[0.03] dark:bg-accent/10'
          : 'border-ink-200 dark:border-ink-800'
      }`}
    >
      <div className="flex items-center gap-3 mb-3">
        <span
          className={`w-7 h-7 shrink-0 rounded-full border flex items-center justify-center text-xs font-mono ${badge}`}
        >
          {state === 'done' ? '✓' : n}
        </span>
        <h2 className="font-serif text-lg text-ink-800 dark:text-ink-100">{title}</h2>
      </div>
      <div className={state === 'todo' ? 'opacity-55' : ''}>{children}</div>
    </section>
  );
}

export function NewYear() {
  const { me } = useMe();
  const [status, setStatus] = useState<Status | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<string | null>(null);
  const detailFor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.get<Status>('/api/admin/import-year/status');
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  // 輪詢:Step 2/3 的整個價值就在於它會跟著本機的動作變化。這幾支端點刻意
  // 排除在 Service Worker 的快取白名單之外(frontend/src/lib/sw-guards.ts),
  // 快取一個「12 秒前」會讓這個機制變成謊話。
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const job = status?.jobs?.[0] ?? null;

  useEffect(() => {
    if (!job) {
      setDetail(null);
      detailFor.current = null;
      return;
    }
    if (job.stage !== 'pushed') return;
    if (detailFor.current === job.id && detail?.job.updated_at === job.updated_at) return;
    detailFor.current = job.id;
    api
      .get<JobDetail>(`/api/admin/import-year/${job.id}`)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [job, detail?.job.updated_at]);

  const now = Date.now();
  const alive =
    status?.last_seen_at != null && now - status.last_seen_at < HEARTBEAT_FRESH_MS;
  const stalled = job != null && now - job.updated_at > STALL_MS && job.stage !== 'pushed';

  const steps = useMemo(() => {
    const s1: 'done' | 'active' | 'todo' = alive || job ? 'done' : 'active';
    const s2 = alive || job ? 'done' : s1 === 'done' ? 'active' : 'todo';
    const s3 = job ? (job.stage === 'pushed' ? 'done' : 'active') : alive ? 'active' : 'todo';
    const s4 = job?.stage === 'pushed' ? 'done' : job ? 'active' : 'todo';
    const s5 = job?.stage === 'pushed' ? 'active' : 'todo';
    return { s1, s2, s3, s4, s5 } as Record<string, 'done' | 'active' | 'todo'>;
  }, [alive, job]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (me && me.is_admin === false) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <p className="text-ink-500 dark:text-ink-400">這個頁面只有管理員能用。</p>
        <Link to="/review" className="text-accent hover:text-accent-dark text-sm mt-4 inline-block">
          ← 回複習模式
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <Link to="/review" className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent">
        ← 複習模式
      </Link>
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mt-3 mb-2">加入新年份</h1>
      <p className="text-ink-500 dark:text-ink-400 text-sm mb-8 leading-relaxed">
        把官方考題 PDF 解析成題庫。解析在你自己的電腦上跑,推上來的題目會先進暫存區
        —— 在你於最後一步按下發布之前,學員看不到任何東西。
      </p>

      {status && !status.configured && (
        <div className="border border-amber-400/50 bg-amber-50 dark:bg-amber-500/10 rounded p-4 mb-6 text-sm text-ink-700 dark:text-ink-200">
          伺服器尚未設定 <code className="font-mono text-xs">BANK_KEY_SECRET</code>,
          下載功能停用。請先執行{' '}
          <code className="font-mono text-xs">wrangler secret put BANK_KEY_SECRET</code>。
        </div>
      )}

      {error && (
        <div className="border border-red-400/50 bg-red-50 dark:bg-red-500/10 rounded p-4 mb-6 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* ---- Step 1 ---- */}
      <Step n={1} title="下載工具" state={steps.s1}>
        <p className="text-sm text-ink-600 dark:text-ink-300 mb-4 leading-relaxed">
          這份 <code className="font-mono text-xs">.skill</code> 會帶著一把只屬於你的金鑰。
          它<strong>只寫得到暫存區</strong> —— 不能發布、不能改既有題目。發布只能在這個頁面做。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="/api/me/bank-skill"
            className={`inline-flex items-center gap-2 rounded px-5 py-2.5 text-sm font-medium transition ${
              status?.configured
                ? 'bg-accent hover:bg-accent-dark text-white'
                : 'bg-ink-200 dark:bg-ink-800 text-ink-400 pointer-events-none'
            }`}
          >
            下載 bank-ingest.skill
          </a>
          <span className="text-xs text-ink-400 font-mono">v{status?.key_version ?? '—'}</span>
          <button
            onClick={() =>
              run('rotate', async () => {
                if (
                  !confirm('重新產生金鑰會讓已經下載的 bank-ingest.skill 立刻失效。要繼續嗎?')
                ) {
                  throw new Error('已取消');
                }
                await api.post('/api/me/bank-key/rotate');
              })
            }
            disabled={busy === 'rotate'}
            className="text-xs text-ink-500 dark:text-ink-400 hover:text-accent underline underline-offset-2"
          >
            重新產生金鑰
          </button>
        </div>
      </Step>

      {/* ---- Step 2 ---- */}
      <Step n={2} title="設定本機環境" state={steps.s2}>
        <Cmd>{`unzip bank-ingest.skill -d ~/.claude/skills/bank-ingest
cd ~/.claude/skills/bank-ingest && uv sync
uv run python scripts/doctor.py`}</Cmd>
        <div className="mt-4 flex items-center gap-2 text-sm">
          <span
            className={`w-2 h-2 rounded-full ${alive ? 'bg-emerald-500' : 'bg-ink-300 dark:bg-ink-700'}`}
          />
          {alive && status?.last_seen_at ? (
            <span className="text-emerald-700 dark:text-emerald-400">
              本機環境已就緒 · {ago(now - status.last_seen_at)}
            </span>
          ) : (
            <span className="text-ink-400">尚未偵測到本機環境</span>
          )}
        </div>
        <p className="text-xs text-ink-400 mt-2 leading-relaxed">
          自檢會順便驗證金鑰還有效。若它說金鑰已被撤銷,回上一步重新下載即可 ——
          不必手改 <code className="font-mono">.env</code>。
        </p>
      </Step>

      {/* ---- Step 3 ---- */}
      <Step n={3} title="解析 PDF" state={steps.s3}>
        <p className="text-sm text-ink-600 dark:text-ink-300 mb-3 leading-relaxed">
          把官方 PDF 放成一個科別一個檔,<strong>檔名要包含科別名稱</strong>:
        </p>
        <Cmd>{`~/bank-115/
  內科.pdf
  共同.pdf`}</Cmd>
        <p className="text-sm text-ink-600 dark:text-ink-300 my-3">
          然後在 Claude Code 裡說:
        </p>
        <Cmd>{`/bank-ingest 115 ~/bank-115`}</Cmd>
        <p className="text-xs text-ink-400 mt-3 leading-relaxed">
          過程中它會問你詳解要怎麼處理(只抽取來源 / 抽取＋AI 補缺 / 不匯入)。
          那個問題發生在 terminal,不在這裡。
        </p>

        {job && (
          <div className="mt-4 border border-ink-200 dark:border-ink-800 rounded p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-ink-800 dark:text-ink-100">
                <span className="font-mono">{job.year}</span> 年 ·{' '}
                <span className="text-ink-500 dark:text-ink-400">
                  {job.stage === 'parsing'
                    ? '解析中'
                    : job.stage === 'parsed'
                      ? '解析完成'
                      : job.stage === 'explaining'
                        ? '處理詳解中'
                        : job.stage === 'pushed'
                          ? '已推送'
                          : '已開始'}
                </span>
                {job.detail && (
                  <span className="text-ink-400 text-xs ml-2 font-mono">{job.detail}</span>
                )}
              </div>
              <span className="text-xs text-ink-400">{ago(now - job.updated_at)}</span>
            </div>
            {stalled && (
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-3 leading-relaxed">
                上次回報是 {ago(now - job.updated_at)},可能已經中斷。重跑一次同樣的指令即可
                —— 它會接續同一個工作,不會產生兩份。
              </p>
            )}
          </div>
        )}
      </Step>

      {/* ---- Step 4 ---- */}
      <Step n={4} title="推進暫存區" state={steps.s4}>
        {job?.stage === 'pushed' ? (
          <p className="text-sm text-ink-700 dark:text-ink-200">
            已收到 <span className="font-mono">{job.year}</span> 年{' '}
            <span className="font-mono">{job.question_count}</span> 題
            {job.needs_review > 0 && (
              <>
                ,其中{' '}
                <span className="font-mono text-amber-600 dark:text-amber-400">
                  {job.needs_review}
                </span>{' '}
                題待你確認
              </>
            )}
            。
          </p>
        ) : (
          <p className="text-sm text-ink-500 dark:text-ink-400">
            skill 推送完成後,這裡會自動出現。這一步你不用做任何事。
          </p>
        )}
      </Step>

      {/* ---- Step 5 ---- */}
      <Step n={5} title="審閱與發布" state={steps.s5}>
        {!detail || job?.stage !== 'pushed' ? (
          <p className="text-sm text-ink-500 dark:text-ink-400">等暫存區有資料才會開放。</p>
        ) : (
          <ReviewPanel
            detail={detail}
            busy={busy}
            publishResult={publishResult}
            onFix={(number, answer) =>
              run(`fix-${number}`, async () => {
                await api.patch(
                  `/api/admin/import-year/${detail.job.id}/questions/${number}`,
                  { answer },
                );
                setDetail(await api.get<JobDetail>(`/api/admin/import-year/${detail.job.id}`));
              })
            }
            onPublish={() =>
              run('publish', async () => {
                const r = await api.post<{ published: number; year: number }>(
                  `/api/admin/import-year/${detail.job.id}/publish`,
                );
                setPublishResult(`${r.year} 年 ${r.published} 題已發布`);
                setDetail(null);
              })
            }
            onDiscard={() =>
              run('discard', async () => {
                if (!confirm(`作廢 ${detail.job.year} 年的暫存資料?這不會影響已發布的題庫。`)) {
                  throw new Error('已取消');
                }
                await api.post(`/api/admin/import-year/${detail.job.id}/discard`);
                setDetail(null);
              })
            }
          />
        )}
        {publishResult && (
          <p className="mt-4 text-sm text-emerald-700 dark:text-emerald-400">
            ✓ {publishResult} —— 回{' '}
            <Link to="/review" className="underline underline-offset-2">
              複習模式
            </Link>{' '}
            就看得到了。
          </p>
        )}
      </Step>
    </div>
  );
}

function ReviewPanel({
  detail,
  busy,
  publishResult,
  onFix,
  onPublish,
  onDiscard,
}: {
  detail: JobDetail;
  busy: string | null;
  publishResult: string | null;
  onFix: (number: number, answer: string) => void;
  onPublish: () => void;
  onDiscard: () => void;
}) {
  const [showAll, setShowAll] = useState(false);

  // 需要人看的排前面 —— 缺答案的最前,再來是低信心的。其餘預設收合:
  // 一次捲一百題找那三題紅字,是最容易漏掉的一種介面。
  const { flagged, clean } = useMemo(() => {
    const f = detail.questions.filter((q) => !q.answer || q.confidence < 0.8);
    const c = detail.questions.filter((q) => q.answer && q.confidence >= 0.8);
    f.sort((a, b) => (a.answer ? 1 : 0) - (b.answer ? 1 : 0) || a.number - b.number);
    return { flagged: f, clean: c };
  }, [detail.questions]);

  const canPublish = detail.blockers.length === 0 && !publishResult;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm mb-4">
        <span className="text-ink-800 dark:text-ink-100">
          <span className="font-mono">{detail.job.year}</span> 年 ·{' '}
          <span className="font-mono">{detail.questions.length}</span>/
          <span className="font-mono">{detail.expected_total}</span> 題
        </span>
        {flagged.length > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            {flagged.length} 題待確認
          </span>
        )}
        {flagged.length === 0 && (
          <span className="text-emerald-600 dark:text-emerald-400">全部題目都有答案</span>
        )}
      </div>

      {detail.blockers.length > 0 && (
        <ul className="border border-amber-400/50 bg-amber-50 dark:bg-amber-500/10 rounded p-4 mb-4 text-sm text-ink-700 dark:text-ink-200 space-y-1">
          {detail.blockers.map((b, i) => (
            <li key={i}>• {b}</li>
          ))}
        </ul>
      )}

      <div className="space-y-3 mb-5">
        {flagged.map((q) => (
          <QuestionRow key={q.number} q={q} busy={busy} onFix={onFix} highlight />
        ))}
      </div>

      {clean.length > 0 && (
        <>
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-sm text-accent hover:text-accent-dark mb-3"
          >
            {showAll ? '收合' : `展開其餘 ${clean.length} 題`}
          </button>
          {showAll && (
            <div className="space-y-3 mb-5">
              {clean.map((q) => (
                <QuestionRow key={q.number} q={q} busy={busy} onFix={onFix} />
              ))}
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-ink-200 dark:border-ink-800">
        <button
          onClick={onPublish}
          disabled={!canPublish || busy === 'publish'}
          className={`rounded px-6 py-2.5 text-sm font-medium transition ${
            canPublish
              ? 'bg-accent hover:bg-accent-dark text-white'
              : 'bg-ink-200 dark:bg-ink-800 text-ink-400 cursor-not-allowed'
          }`}
        >
          {busy === 'publish' ? '發布中…' : `發布 ${detail.job.year} 年`}
        </button>
        <button
          onClick={onDiscard}
          disabled={busy === 'discard'}
          className="text-sm text-ink-500 dark:text-ink-400 hover:text-red-600 underline underline-offset-2"
        >
          作廢重來
        </button>
      </div>
    </div>
  );
}

function QuestionRow({
  q,
  busy,
  onFix,
  highlight,
}: {
  q: StagedQuestion;
  busy: string | null;
  onFix: (number: number, answer: string) => void;
  highlight?: boolean;
}) {
  const keys = Object.keys(q.options).sort();
  return (
    <div
      className={`border rounded p-4 ${
        highlight
          ? 'border-amber-400/60 bg-amber-50/50 dark:bg-amber-500/5'
          : 'border-ink-200 dark:border-ink-800'
      }`}
    >
      <div className="flex items-baseline gap-3 mb-2">
        <span className="font-mono text-xs text-ink-400">
          {String(q.number).padStart(3, '0')}
        </span>
        <span className="text-xs text-ink-400">{q.group}</span>
        {!q.answer ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">沒抓到答案</span>
        ) : q.confidence < 0.8 ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            信心 {q.confidence.toFixed(1)}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-ink-800 dark:text-ink-100 mb-3 leading-relaxed">{q.stem}</p>
      <div className="space-y-1.5">
        {keys.map((k) => (
          <div key={k} className="flex items-start gap-2 text-sm">
            <button
              onClick={() => onFix(q.number, k)}
              disabled={busy === `fix-${q.number}`}
              title={q.answer === k ? '目前的答案' : `把答案改成 ${k}`}
              className={`w-6 h-6 shrink-0 rounded-full border text-xs font-mono transition ${
                q.answer === k
                  ? 'bg-accent border-accent text-white'
                  : 'border-ink-300 dark:border-ink-700 text-ink-400 hover:border-accent hover:text-accent'
              }`}
            >
              {k}
            </button>
            <span className="text-ink-600 dark:text-ink-300 leading-relaxed pt-0.5">
              {q.options[k]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
