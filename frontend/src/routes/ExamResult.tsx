import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ExternalLink, Flag } from 'lucide-react';
import { api } from '../lib/api';
import { BookmarkBadge } from '../components/BookmarkBadge';
import { choicePct, type StatsPayload } from '../lib/choiceStats';
import { describeFilters } from '../lib/customTestLabel';
import { ExportButton } from '../components/ExportDialog';

type Result = {
  session: {
    id: string;
    year: number;
    started_at: number;
    finished_at: number;
    score: number;
    duration_sec: number;
    /** migration 0026;舊列走 DEFAULT 'year'。判斷種類看 kind,不要看 year。 */
    kind?: 'year' | 'custom';
    filter_json?: string | null;
  };
  answers: {
    question_id: string;
    chosen: string | null;
    is_correct: 0 | 1 | null;
    number: number;
    correct_answer: string;
    stem: string;
    /** null for sessions predating the attempts log (migration 0023). */
    elapsed_ms: number | null;
    /** 選項全文,字母 → 內容。展開卡片時就地顯示,不再另外打一支端點。 */
    options?: Record<string, string>;
    /** 複習進度目前記著的答案(review_progress.last_chosen)。
     *  模擬考不寫那張表,所以它可能停在一個月前的複習作答 —— 「登記進複習進度」
     *  按的就是這個差距。 */
    review_last_chosen?: string | null;
    /** 標記待回頭檢查(migration 0028)。舊列 DEFAULT 0。 */
    flagged: 0 | 1;
    flagged_at: number | null;
  }[];
};

type Pacing = {
  n: number;
  first_half_avg_ms: number | null;
  second_half_avg_ms: number | null;
  delta_pct: number | null;
  median_ms: number | null;
  slowest: { question_id: string; number: number; ms: number }[];
};

/** mm:ss — matches the 分/秒 style used elsewhere on this page. */
function fmtMs(ms: number): string {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function ExamResult() {
  const { sid } = useParams<{ sid: string }>();
  const [data, setData] = useState<Result | null>(null);
  const [filter, setFilter] = useState<'all' | 'wrong' | 'right' | 'flagged'>('wrong');
  const [pacing, setPacing] = useState<Pacing | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!sid) return;
    api.get<Result>(`/api/exam/${sid}`).then(setData);
    api.get<Pacing>(`/api/exam/${sid}/pacing`).then(setPacing).catch(() => {
      /* pacing is best-effort — never block the result page */
    });
  }, [sid]);

  // 「登記進複習進度」—— 模擬考只寫 exam_answers / attempts,從不碰
  // review_progress,而 /q/:id 的「我的作答」讀的是後者。所以考完之後打開題目,
  // 看到的是上一次在複習模式答的那個。這顆按鈕把考對的那些搬過去。
  //
  // 只搬考對的:複習紀錄因此維持「目前最好的狀態」,不會因為一次考差把以前答對
  // 的拉下來。規則寫在 worker/lib/apply-exam-to-review.ts,前端只負責算出「按下去
  // 會改變幾題」——**要跟伺服器同一套判準**,否則按鈕上的數字跟結果對不起來。
  async function applyToReview(ids?: string[]) {
    if (!sid || applying) return;
    setApplying(true);
    setApplyMsg(null);
    try {
      const r = await api.post<{ applied: string[]; skipped_already: number }>(
        `/api/exam/${sid}/apply-to-review`,
        ids ? { question_ids: ids } : {},
      );
      // 就地改寫,不重抓整份成績 —— 這一頁的其他東西(配速、篩選)都沒變。
      const done = new Set(r.applied);
      setData((d) =>
        d
          ? {
              ...d,
              answers: d.answers.map((a) =>
                done.has(a.question_id)
                  ? { ...a, review_last_chosen: a.chosen }
                  : a,
              ),
            }
          : d,
      );
      setApplyMsg(
        r.applied.length > 0
          ? `已登記 ${r.applied.length} 題`
          : '沒有需要登記的題目',
      );
    } catch (e: any) {
      setApplyMsg('登記失敗:' + (e?.data?.error ?? e?.message ?? '請稍後再試'));
    } finally {
      setApplying(false);
    }
  }

  if (!data) return <div className="p-8 text-center text-ink-400 dark:text-ink-500">載入中…</div>;

  const total = data.answers.length;
  const correct = data.session.score;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  const mins = Math.floor(data.session.duration_sec / 60);
  const secs = data.session.duration_sec % 60;

  const flaggedCount = data.answers.filter((a) => a.flagged === 1).length;

  // 「按下去會改變幾題」——**跟伺服器同一套判準**(考對 + 複習紀錄還不是這個答案)。
  // 把已經一樣的算進去的話,使用者會按完發現數字沒動。
  const pendingApply = data.answers.filter(
    (a) => a.is_correct === 1 && a.chosen && a.review_last_chosen !== a.chosen,
  );

  const visible = data.answers.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'wrong') return a.is_correct !== 1;
    if (filter === 'flagged') return a.flagged === 1;
    return a.is_correct === 1;
  });

  return (
    <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-8 flex items-center justify-between gap-4">
        <Link to="/exam" className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent">
          ← 全真作答
        </Link>
        <div className="flex items-center gap-2">
          <ExportButton scope={{ kind: 'exam', session_id: data.session.id }} />
          <ExportButton
            scope={{ kind: 'exam', session_id: data.session.id, only_wrong: true }}
            label="只匯出答錯的"
          />
        </div>
      </header>

      {/* Score banner */}
      <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mb-8 text-center">
        <div className="text-sm text-ink-500 dark:text-ink-400 mb-2">
          {data.session.kind === 'custom' ? (
            <>
              自訂測驗
              {describeFilters(data.session.filter_json) && (
                <span className="block text-xs mt-0.5">
                  {describeFilters(data.session.filter_json)}
                </span>
              )}
            </>
          ) : (
            <>{data.session.year} 年度模擬考</>
          )}
        </div>
        <div className="font-serif text-6xl text-ink-900 dark:text-ink-100 mb-3">
          {correct}<span className="text-ink-300 dark:text-ink-600 text-3xl">/{total}</span>
        </div>
        {/* 及格與否**只**寫在 emerald/rose 裡 —— 數字本身不帶判斷。1-bit 下
            顏色沒了就什麼都不剩,所以補一個只在電子紙顯示的 ✓ / ✗。 */}
        <div className={`text-lg font-medium ${pct >= 60 ? 'text-emerald-700 dark:text-emerald-400 eink-mark-ok' : 'text-rose-700 dark:text-rose-400 eink-mark-bad'}`}>
          {pct}%
        </div>
        <div className="text-xs text-ink-400 dark:text-ink-500 mt-3">
          用時 {mins} 分 {secs} 秒 ·{' '}
          {new Date(data.session.finished_at).toLocaleString('zh-TW')}
        </div>
      </div>

      {/* 登記進複習進度。放在分數卡與逐題清單之間 —— 它是「看完成績之後要不要
          把成果收進複習」的動作,屬於整份成績,不屬於任何一題。 */}
      {(pendingApply.length > 0 || applyMsg) && (
        <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 shadow-paper mb-8 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 text-sm text-ink-600 dark:text-ink-300">
            <p>
              有 <span className="font-medium">{pendingApply.length}</span>{' '}
              題這次考對了,但複習進度還記著舊答案。
            </p>
            <p className="text-xs text-ink-400 dark:text-ink-500 mt-0.5">
              登記之後,題目頁的「我的作答」會顯示這次的答案,也不會再被當成錯題丟回來。
              考錯的不會動。
            </p>
          </div>
          <button
            type="button"
            onClick={() => applyToReview()}
            disabled={applying || pendingApply.length === 0}
            className="shrink-0 rounded bg-accent hover:bg-accent-dark text-white px-3 py-1.5 text-sm disabled:opacity-40"
          >
            {applying ? '登記中…' : `全部登記 (${pendingApply.length})`}
          </button>
          {applyMsg && (
            <p className="w-full text-xs text-ink-500 dark:text-ink-400">{applyMsg}</p>
          )}
        </div>
      )}

      {/* Pacing card */}
      {pacing && (
        <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 sm:p-5 shadow-paper mb-8">
          {pacing.n === 0 ? (
            <p className="text-sm text-ink-400 dark:text-ink-500">
              本場沒有逐題計時資料(舊場次)
            </p>
          ) : (
            <>
              <div className="text-xs text-ink-500 dark:text-ink-400 mb-2">配速</div>
              <p className="text-sm text-ink-700 dark:text-ink-300 leading-relaxed">
                前半段平均 {fmtMs(pacing.first_half_avg_ms ?? 0)} ·{' '}
                後半段平均 {fmtMs(pacing.second_half_avg_ms ?? 0)}
                {pacing.delta_pct !== null && (
                  <>
                    {' '}·{' '}
                    <span
                      className={
                        pacing.delta_pct > 25
                          ? 'font-medium text-rose-700 dark:text-rose-400'
                          : pacing.delta_pct < -25
                          ? 'font-medium text-emerald-700 dark:text-emerald-400'
                          : 'font-medium text-ink-800 dark:text-ink-200'
                      }
                    >
                      {pacing.delta_pct >= 0
                        ? `後段慢了 ${pacing.delta_pct}%`
                        : `後段快了 ${-pacing.delta_pct}%`}
                    </span>
                  </>
                )}
              </p>
              {pacing.slowest.length > 0 && (
                <div className="text-xs text-ink-500 dark:text-ink-400 mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  <span>最慢五題:</span>
                  {pacing.slowest.map((s) => (
                    <Link
                      key={s.question_id}
                      to={`/q/${s.question_id}`}
                      className="hover:text-accent"
                    >
                      第 {s.number} 題 {fmtMs(s.ms)}
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4 text-sm">
        {(['wrong', 'right', 'flagged', 'all'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            // 沒有標記題時不給點,避免點進空清單。
            disabled={f === 'flagged' && flaggedCount === 0}
            className={`px-3 py-1.5 rounded border transition ${
              filter === f
                ? 'bg-ink-900 dark:bg-ink-700 text-white border-ink-900 dark:border-ink-700'
                : 'border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-ink-400 dark:hover:border-ink-500'
            } disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-ink-200 dark:disabled:hover:border-ink-700`}
          >
            {f === 'all' && `全部 (${total})`}
            {f === 'right' && `答對 (${correct})`}
            {f === 'wrong' && `答錯/未答 (${total - correct})`}
            {f === 'flagged' && `標記 (${flaggedCount})`}
          </button>
        ))}
      </div>

      {/* Per-question list */}
      <ul className="space-y-2">
        {visible.map((a) => {
          const right = a.is_correct === 1;
          const unanswered = !a.chosen;
          return (
            <li key={a.question_id}>
              {/* ⚠️ 「在新分頁開啟」**必須是整列連結的兄弟,不能放進去** ——
                  巢狀 `<a>` 是無效 HTML,瀏覽器解析時會把內層拉到外層之外,
                  於是那顆按鈕會跑到列的上面、而且點了不一定去對的地方。
                  所以這裡多包一層 `relative group` 讓它疊上去。
                  只包整列連結,不包 AnswerDetail —— 否則絕對定位的基準會變成
                  「連同展開的選項」那一整塊,按鈕會飄在很下面。 */}
              <div className="relative group">
              <Link
                to={`/q/${a.question_id}`}
                className="flex gap-3 items-start bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent hover:shadow-paper transition"
              >
                <span
                  // 三種底色在 1-bit 下會一起變白 → 全部長一樣。改成
                  // 對=反白 / 錯=粗實框 / 未作答=虛線框。
                  className={`shrink-0 w-9 h-9 rounded-full grid place-items-center font-mono text-sm ${
                    right
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 eink-invert'
                      : unanswered
                      ? 'bg-ink-100 dark:bg-ink-700 text-ink-500 dark:text-ink-400 eink:border eink:border-dashed eink:border-black'
                      : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 eink:border-2 eink:border-black'
                  }`}
                >
                  {a.number}
                </span>
                {/* 標記過的題目:與考試中同一組 amber 視覺 */}
                {a.flagged === 1 && (
                  <Flag
                    size={11}
                    className="shrink-0 mt-1 fill-amber-500 text-amber-600"
                    aria-label="已標記"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed inline-flex items-start gap-1.5">
                    <BookmarkBadge questionId={a.question_id} className="mt-1" />
                    <span>{a.stem}</span>
                  </p>
                  <div className="text-xs text-ink-500 dark:text-ink-400 mt-1">
                    {unanswered ? (
                      <span>未作答 · 正解 {a.correct_answer}</span>
                    ) : right ? (
                      <span className="text-emerald-700 dark:text-emerald-400">✓ {a.chosen}</span>
                    ) : (
                      <span className="text-rose-700 dark:text-rose-400">
                        ✗ 你選 {a.chosen} · 正解 {a.correct_answer}
                      </span>
                    )}
                    <span> · 用時 {a.elapsed_ms === null ? '—' : fmtMs(a.elapsed_ms)}</span>
                  </div>
                </div>
              </Link>
              {/* hover 才現身,同 NoteSwitcher 的刪除鈕:檢討成績時每一列都會看,
                  但「另開分頁」不是每一列都要,不該和題號一樣顯眼。
                  觸控裝置上等於看不見 —— 那是可以接受的,因為長按整列本來就有
                  系統的「在新分頁開啟」,平台慣例已經涵蓋了。
                  `focus:opacity-100` 讓鍵盤走得到。
                  底色要**不透明**(不是 `bg-white/90`):它會蓋在題幹上,而且
                  e-ink 那層的顏色掃描要求可見元素的 alpha 必須是 1。 */}
              <Link
                to={`/q/${a.question_id}`}
                target="_blank"
                rel="noreferrer"
                title="在新分頁開啟這一題"
                aria-label={`在新分頁開啟第 ${a.number} 題`}
                className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 px-2 py-1 text-xs text-ink-500 dark:text-ink-400 opacity-0 transition hover:text-accent hover:border-accent focus:opacity-100 group-hover:opacity-100"
              >
                <ExternalLink size={12} /> 在新分頁開啟
              </Link>
              </div>
              <AnswerDetail
                questionId={a.question_id}
                options={a.options ?? {}}
                chosen={a.chosen}
                correctAnswer={a.correct_answer}
                applyState={
                  a.is_correct !== 1 || !a.chosen
                    ? 'n/a'
                    : a.review_last_chosen === a.chosen
                      ? 'done'
                      : 'pending'
                }
                applying={applying}
                onApply={() => applyToReview([a.question_id])}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 逐題檢討的展開區:**選項全文 + 選項分布**。
 *
 * 選項文字跟著 `/api/exam/:sid` 一起回來(就在同一列 questions 上),所以展開是
 * 即時的、不打任何請求;分布仍然懶載入 —— 100 題全部預抓等於 100 個 request,
 * 所以只在展開該題時才打 `/stats`(每題最多一次)。
 *
 * 兩者合成同一列而不是各畫一區:分開的話同一個字母會在畫面上出現兩次,讀者得
 * 自己把「B 寫的是什麼」跟「B 有幾成人選」對起來 —— 那正是檢討時最不想做的事。
 *
 * 列的來源是**題目的選項**,不是 stats 回來的 letters:人數不足 / 未作答 /
 * 載入失敗時都沒有分布,但選項仍然要看得到,那才是展開的主要目的。
 */
function AnswerDetail({
  questionId,
  options,
  chosen,
  correctAnswer,
  applyState,
  applying,
  onApply,
}: {
  questionId: string;
  options: Record<string, string>;
  chosen: string | null;
  correctAnswer: string;
  /** 'n/a' = 考錯或未作答(依規則不登記)· 'pending' = 可登記 · 'done' = 已一致 */
  applyState: 'n/a' | 'pending' | 'done';
  applying: boolean;
  onApply(): void;
}) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || stats) return;
    let cancelled = false;
    api
      .get<StatsPayload>(`/api/questions/${questionId}/stats`)
      .then((r) => { if (!cancelled) setStats(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, stats, questionId]);

  const fromQuestion = Object.keys(options);
  // 舊 session 或 options_json 壞掉時退回 stats 的 letters —— 至少畫得出分布,
  // 不會整個展開區空白。
  const letters =
    fromQuestion.length > 0
      ? fromQuestion
      : stats?.choices_state === 'ok'
      ? Object.keys(stats.choice_pct ?? {})
      : [];

  return (
    <div className="px-3 pb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`opts-${questionId}`}
        className="text-xs text-ink-400 dark:text-ink-500 hover:text-accent py-1"
      >
        {open ? '收合選項' : '展開選項'}
      </button>
      {/* 逐題登記。只有「考對了但複習進度還是舊答案」時才出現 —— 一顆按了不會
          有任何變化的按鈕,比沒有這顆更糟。已登記的留一行灰字當回饋,不留的話
          按完只是按鈕消失,看起來像壞掉。 */}
      {applyState === 'pending' && (
        <button
          type="button"
          onClick={onApply}
          disabled={applying}
          className="ml-3 text-xs text-accent hover:underline disabled:opacity-40"
        >
          登記進複習進度
        </button>
      )}
      {applyState === 'done' && (
        <span className="ml-3 text-xs text-ink-400 dark:text-ink-500">
          已登記進複習
        </span>
      )}
      {open && (
        <div id={`opts-${questionId}`} className="pb-2 space-y-1">
          <ul className="space-y-1">
            {letters.map((L) => {
              const pct = choicePct(stats, L);
              const isCorrect = L === correctAnswer;
              const picked = L === chosen;
              // 顏色沒了之後語意要換一個維度重講(同 QuestionCard 的選項列):
              //   正解      → 整列反白
              //   選錯的    → 粗框 + 選項文字刪除線
              //   其他      → 細框
              const cls = isCorrect
                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/15 eink-invert'
                : picked
                ? 'border-rose-500 bg-rose-50 dark:bg-rose-500/15 eink:border-2'
                : 'border-ink-200 dark:border-ink-700';
              return (
                <li
                  key={L}
                  className={`relative flex items-start gap-2 overflow-hidden rounded border px-2 py-1.5 text-xs ${cls}`}
                >
                  {pct !== null && (
                    <span
                      aria-hidden
                      className={
                        'absolute inset-y-0 left-0 pointer-events-none ' +
                        (isCorrect
                          ? 'bg-accent/15'
                          : 'bg-ink-200/60 dark:bg-ink-600/40') +
                        // 淡色填充在 1-bit 下會被洗白 → 整條消失。改成貼底的細
                        // 黑槓:資訊還在,又不會跟「正解=整列反白」搶同一個維度。
                        // 正解列不加 —— 黑槓畫在黑底上看不見。
                        (isCorrect
                          ? ''
                          : ' eink:inset-y-auto eink:bottom-0 eink:h-px eink:bg-black')
                      }
                      style={{ width: `${pct}%` }}
                    />
                  )}
                  <span className="relative font-mono font-semibold text-ink-700 dark:text-ink-300 shrink-0">
                    {L}
                  </span>
                  {/* min-w-0 + break-words 兩個一起才有用:選項裡的
                      DEK::NUP214 這種整串不可斷,少了前者會把右側標籤擠出去。 */}
                  <span
                    className={
                      'relative min-w-0 flex-1 break-words leading-relaxed text-ink-800 dark:text-ink-200' +
                      (picked && !isCorrect ? ' eink:line-through' : '')
                    }
                  >
                    {options[L] ?? ''}
                  </span>
                  <span className="relative shrink-0 self-center inline-flex items-center gap-1.5 text-ink-500 dark:text-ink-400">
                    {pct !== null && (
                      <span className="tabular-nums">{pct}%</span>
                    )}
                    {isCorrect && <span className="whitespace-nowrap">✓ 正解</span>}
                    {picked && !isCorrect && (
                      <span className="whitespace-nowrap">你選的</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {/* 分布的狀態訊息放在選項**之後**:選項是展開的主要目的,把
              「作答人數不足」擺在最上面會讓人以為整區沒有東西可看。 */}
          <div className="text-xs text-ink-500 dark:text-ink-400">
            {failed && <p>選項分布載入失敗</p>}
            {!failed && !stats && <p>分布載入中…</p>}
            {stats?.choices_state === 'not_answered' && (
              <p>本題你未作答,作答後才會顯示分布</p>
            )}
            {stats?.choices_state === 'below_threshold' && (
              <p>作答人數不足,暫不顯示選項分布</p>
            )}
            {stats?.choices_state === 'ok' && (
              <p>{stats.choice_responders} 人作答</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
