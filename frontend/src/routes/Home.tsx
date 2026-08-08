import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, History, AlertTriangle, CalendarDays, Scale, CalendarPlus } from 'lucide-react';
import { api } from '../lib/api';
import { config } from '../config';
import { loadLastPath, describePath } from '../lib/lastPath';
import { ResumeChip } from '../components/ResumeChip';
import { useMe } from '../hooks/useMe';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { PacingCard } from '../components/PacingCard';
import { StudyPlanDialog } from '../components/StudyPlanDialog';
import { GROUPS, TOTAL_EXAM_COUNT } from '../lib/groups';
import { formatDueAt, type DueSummary } from '../lib/due';

type YearMeta = { year: number; count: number };
type Stats = {
  questions_attempted: number;
  total_correct: number;
  total_attempts: number;
  by_year: { year: number; seen: number; correct: number }[];
};

// Exam start time — configured in /config.toml [exam].
const EXAM_DATE = new Date(config.exam.date_iso);

type Countdown = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  total_ms: number;
};

function countdownTo(target: Date): Countdown {
  const total_ms = Math.max(0, target.getTime() - Date.now());
  const totalSec = Math.floor(total_ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;
  return { days, hours, minutes, seconds, total_ms };
}

export function Home() {
  const { me } = useMe();
  const [years, setYears] = useState<YearMeta[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  // 跨年份到期佇列摘要 — 決定要不要顯示「今天 N 張」CTA。
  const [due, setDue] = useState<DueSummary | null>(null);
  const [countdown, setCountdown] = useState<Countdown>(() => countdownTo(EXAM_DATE));
  // 「繼續上次」— read once on mount; dismissable for this visit.
  const [resume, setResume] = useState(() => loadLastPath());
  const [planOpen, setPlanOpen] = useState(false);

  useEffect(() => {
    api.get<YearMeta[]>('/api/questions/_meta/years').then(setYears);
    api.get<Stats>('/api/review/stats').then(setStats).catch(() => setStats(null));
    api.get<DueSummary>('/api/review/due').then(setDue).catch(() => setDue(null));
    // Tick once per second so the SS digits keep up. State updates are cheap
    // here — only the countdown card depends on it.
    const t = window.setInterval(() => setCountdown(countdownTo(EXAM_DATE)), 1000);
    return () => window.clearInterval(t);
  }, []);

  const daysLeft = countdown.days;
  const finished = countdown.total_ms <= 0;

  const totalQuestions = years.reduce((s, y) => s + y.count, 0);
  const seen = stats?.questions_attempted ?? 0;
  const overallPct = totalQuestions ? Math.round((seen / totalQuestions) * 100) : 0;
  const correctPct = stats && stats.total_attempts
    ? Math.round((stats.total_correct / stats.total_attempts) * 100)
    : 0;

  return (
    <div className="max-w-4xl lg:max-w-5xl xl:max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header className="mb-6 flex items-baseline gap-x-3 gap-y-1 flex-wrap">
        <h1 className="font-serif text-2xl sm:text-3xl text-ink-900 dark:text-ink-100">
          {greeting()} {me?.display_name ? <span className="text-accent">{me.display_name}</span> : ''}
        </h1>
        <p className="text-ink-500 dark:text-ink-400 text-sm sm:text-base">
          {config.brand.home_subtitle}
        </p>
      </header>

      {/* Resume where you left off — last visited page, same device. */}
      {resume && (
        <section className="mb-4">
          <ResumeChip
            prefix="上次停留"
            label={describePath(resume.path)}
            to={resume.path}
            onDismiss={() => setResume(null)}
          />
        </section>
      )}

      {/* Countdown to exam — date and label come from /config.toml [exam]. */}
      <section className="mb-8">
        <div className="bg-accent/5 dark:bg-accent/15 border border-accent/30 dark:border-accent/40 rounded-lg px-5 py-3 sm:px-6 flex items-baseline gap-x-3 gap-y-1 flex-wrap">
          <CalendarDays className="text-accent shrink-0 self-center" size={22} strokeWidth={1.5} />
          <span className="text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400">
            {config.exam.countdown_label}
          </span>
          {finished ? (
            <span className="font-serif text-xl sm:text-2xl text-ink-700 dark:text-ink-200">
              考試已開始 — 加油!
            </span>
          ) : (
            <>
              <span className="font-serif flex items-baseline gap-2">
                <span className={`text-3xl sm:text-4xl ${daysLeft <= 30 ? 'text-rose-700 dark:text-rose-400' : daysLeft <= 60 ? 'text-amber-700 dark:text-amber-400' : 'text-accent dark:text-accent-light'}`}>
                  {daysLeft}
                </span>
                <span className="text-ink-600 dark:text-ink-300 text-base">天</span>
              </span>
              <span
                className="font-mono tabular-nums text-ink-600 dark:text-ink-300 text-sm sm:text-base"
                aria-live="polite"
              >
                {String(countdown.hours).padStart(2, '0')}
                <span className="text-ink-400 dark:text-ink-500">:</span>
                {String(countdown.minutes).padStart(2, '0')}
                <span className="text-ink-400 dark:text-ink-500">:</span>
                {String(countdown.seconds).padStart(2, '0')}
              </span>
              <span className="text-ink-500 dark:text-ink-400 text-xs sm:text-sm">
                · {config.exam.date_label}
              </span>
              {/* 靠 ml-auto 推到卡片右緣;self-center 讓它脫離 baseline ——
                  跟左邊 text-3xl 的天數對 baseline 會明顯錯位。ghost 樣式:
                  這張卡已經有 accent 底色,再放一顆實心鈕會打架。 */}
              <button
                type="button"
                onClick={() => setPlanOpen(true)}
                className="ml-auto self-center inline-flex items-center gap-1.5 rounded-full border border-transparent px-3 py-1 text-xs sm:text-sm text-accent dark:text-accent-light hover:border-accent/50 hover:bg-accent/10 transition"
              >
                <CalendarPlus size={15} strokeWidth={1.75} />
                生成讀書計畫
              </button>
            </>
          )}
        </div>
        {planOpen && <StudyPlanDialog onClose={() => setPlanOpen(false)} />}

        {/* 跨年份「今天該複習什麼」入口。0 張時只留一行低調文字,不搶版面。 */}
        {due && due.due_total > 0 ? (
          <Link
            to="/due"
            className="mt-3 flex items-center justify-between gap-3 flex-wrap rounded-lg border border-accent/30 bg-accent/5 dark:bg-accent/15 px-4 py-3 hover:border-accent transition"
          >
            <span className="text-ink-800 dark:text-ink-100">
              今天 <span className="font-mono text-accent text-lg">{due.due_total}</span> 張到期
            </span>
            <span className="text-xs text-ink-500 dark:text-ink-400">
              到期 {due.due_review} · 學習中 {due.learning} · 新卡 {due.new_remaining} →
            </span>
          </Link>
        ) : due ? (
          <p className="mt-3 text-xs text-ink-400 dark:text-ink-500">
            今天沒有到期卡片
            {due.next_due_at ? ` · 下一張 ${formatDueAt(due.next_due_at)}` : ''}
          </p>
        ) : null}
      </section>

      {/* 讀書進度預估 — 把倒數與活動量接起來。天數用 API 的 days_left,
          不是上面倒數卡的 countdown.days(ceil vs floor,會差一天)。 */}
      <section className="mb-8">
        <PacingCard />
      </section>

      {/* Activity heatmap + stats summary */}
      <section className="mb-10 flex flex-col lg:flex-row gap-4 sm:gap-5 lg:items-stretch">
        <div className="lg:shrink-0">
          <ActivityHeatmap />
        </div>
        <div className="flex-1 grid grid-cols-3 lg:grid-cols-1 lg:grid-rows-3 gap-3 sm:gap-4">
          <StatBlock label="總題數" value={totalQuestions} />
          <StatBlock
            label="已複習"
            value={seen}
            sub={`${overallPct}%`}
            accent
          />
          <StatBlock label="準確率" value={`${correctPct}%`} sub={`${stats?.total_correct ?? 0}/${stats?.total_attempts ?? 0}`} />
        </div>
      </section>

      {/* Mode cards */}
      <section className="grid sm:grid-cols-3 gap-4 mb-10">
        <Link
          to="/review"
          className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
        >
          <h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
            複習模式
          </h2>
          <p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
            一題一答即時對照詳解,可協作編輯共筆、留言討論、提及他人。
          </p>
        </Link>
        <Link
          to="/exam"
          className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
        >
          <h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
            全真作答
          </h2>
          <p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
            按年度作答模擬考 ({GROUPS.map((g) => `${g.count} ${g.label}`).join(' + ')},共 {TOTAL_EXAM_COUNT} 題),完賽看分數與錯題回顧。
          </p>
        </Link>
        <Link
          to="/lectures"
          className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 shadow-paper hover:shadow-md hover:border-accent transition group"
        >
          <h2 className="font-serif text-xl text-ink-900 dark:text-ink-100 group-hover:text-accent transition">
            複習班講義
          </h2>
          <p className="text-sm text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
            線上閱讀講義 PDF,可螢光標記、頁面筆記 (支援 @114-001 引用題目)、選取文字 AI 解釋與截圖。
          </p>
        </Link>
      </section>

      {/* Year picker */}
      <section className="mb-10">
        <h2 className="font-serif text-xl text-ink-800 dark:text-ink-200 mb-4">依年度 (民國)</h2>
        {years.length === 0 ? (
          <p className="text-sm text-ink-400 dark:text-ink-500">尚無題目。請使用 import-questions 匯入 CSV。</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 sm:gap-3">
            {years.map((y) => {
              const s = stats?.by_year.find((x) => x.year === y.year);
              const seen = s?.seen ?? 0;
              const correct = s?.correct ?? 0;
              const seenPct = y.count > 0 ? Math.round((seen / y.count) * 100) : 0;
              const accPct = seen > 0 ? Math.round((correct / seen) * 100) : null;
              return (
                <Link
                  key={y.year}
                  to={`/year/${y.year}`}
                  className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-3 hover:border-accent hover:shadow-paper transition"
                >
                  <div className="flex items-baseline gap-2">
                    <div className="font-serif text-2xl text-ink-900 dark:text-ink-100">
                      {y.year}
                      {y.year === 100 && (
                        <span className="ml-1 text-xs text-ink-400 dark:text-ink-500 align-middle">(模擬)</span>
                      )}
                    </div>
                    <div className="text-xs text-ink-500 dark:text-ink-400">{y.count} 題</div>
                  </div>

                  {/* eink:軌道補黑框,否則 0% 時整條被洗白、看不見 */}
                  <div className="mt-2 h-1.5 rounded-full bg-ink-100 dark:bg-ink-700 overflow-hidden eink:border eink:border-black">
                    <div
                      className="h-full bg-accent transition-[width]"
                      style={{ width: `${Math.min(100, seenPct)}%` }}
                    />
                  </div>

                  <div className="mt-1.5 flex items-center justify-between text-[11px]">
                    <span className="text-ink-500 dark:text-ink-400">
                      已複習 <span className="font-mono text-ink-700 dark:text-ink-200">{seen}</span>
                      <span className="text-ink-400 dark:text-ink-500">/{y.count}</span>
                    </span>
                    {accPct !== null && (
                      <span
                        className={
                          'font-mono ' +
                          (accPct >= 70
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : accPct >= 50
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-rose-700 dark:text-rose-300')
                        }
                        title="準確率 (本年最近一次作答)"
                      >
                        {accPct}%
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Quick links */}
      <section className="flex gap-4 flex-wrap text-sm">
        <Link to="/bookmarks" className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark">
          <Bookmark size={14} /> 我的收藏
        </Link>
        <Link to="/wrong" className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark">
          <AlertTriangle size={14} /> 錯題回顧
        </Link>
        <Link to="/exam-history" className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark">
          <History size={14} /> 作答紀錄
        </Link>
        <Link to="/challenges" className="inline-flex items-center gap-1.5 text-accent hover:text-accent-dark">
          <Scale size={14} /> 答案挑戰
        </Link>
      </section>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '凌晨好';
  if (h < 12) return '早安';
  if (h < 18) return '午安';
  return '晚安';
}

function StatBlock({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 sm:p-5 lg:px-6 lg:py-3 shadow-paper flex flex-col justify-center text-center lg:flex-row lg:items-center lg:justify-between lg:text-left">
      <div className="text-xs text-ink-500 dark:text-ink-400 mb-1 lg:mb-0">{label}</div>
      <div className="lg:text-right">
        <div className={`font-serif text-2xl sm:text-3xl ${accent ? 'text-accent' : 'text-ink-900 dark:text-ink-100'}`}>
          {value}
          {sub && (
            <span className="font-sans text-xs text-ink-400 dark:text-ink-500 ml-2">{sub}</span>
          )}
        </div>
      </div>
    </div>
  );
}
