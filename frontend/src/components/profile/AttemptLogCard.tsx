import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import {
  fetchAttemptLogMeta,
  previewAttemptLog,
  downloadAttemptLog,
  isDefaultFilters,
  localDate,
  lastNDays,
  type AttemptLogMeta,
  type AttemptLogFilters,
} from '../../lib/attemptLogApi';

// 「答題狀態分析」—— 把自己每一次作答倒成一張 CSV 長表,拿去 Excel / R 自己切。
//
// 站內已經有正確率、弱點圖、信心校準這些「幫你看完再告訴你結論」的畫面;
// 這張卡的定位相反,它只負責把原始資料完整交出去,不做任何歸納。
//
// 條件預設都是「全部」,而且只涵蓋真的作答過的題目(未作答、模擬考尚未交卷
// 的空題都不在裡面)—— 見 worker/lib/attempt-log.ts 的 buildAttemptWhere。

const PRESETS = [
  { label: '最近 7 天', days: 7 },
  { label: '最近 30 天', days: 30 },
  { label: '最近 90 天', days: 90 },
];

export function AttemptLogCard() {
  const [meta, setMeta] = useState<AttemptLogMeta | null>(null);
  const [metaErr, setMetaErr] = useState(false);
  const [years, setYears] = useState<number[]>([]);
  const [wrongOnly, setWrongOnly] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filters: AttemptLogFilters = {
    years,
    wrong_only: wrongOnly,
    from: from || null,
    to: to || null,
  };

  useEffect(() => {
    let alive = true;
    fetchAttemptLogMeta()
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setMetaErr(true));
    return () => {
      alive = false;
    };
  }, []);

  // 條件一改就重新報數。debounce 是為了 <input type="date"> —— 手打日期時
  // 每一個字元都是一次 change,而 2026-08-0 是個合法但無意義的中間狀態。
  // seq 擋掉亂序回來的舊請求,否則慢的那個會蓋掉新的數字。
  const seq = useRef(0);
  const key = JSON.stringify(filters);
  useEffect(() => {
    if (!meta || meta.total === 0) return;
    const mine = ++seq.current;
    setCounting(true);
    const t = window.setTimeout(() => {
      previewAttemptLog(filters)
        .then((r) => {
          if (seq.current !== mine) return;
          setCount(r.count);
          setCounting(false);
        })
        .catch(() => {
          if (seq.current !== mine) return;
          setCount(null);
          setCounting(false);
        });
    }, 300);
    return () => window.clearTimeout(t);
  }, [key, meta?.total]);

  async function download() {
    if (downloading) return;
    setDownloading(true);
    setErr(null);
    try {
      await downloadAttemptLog(filters);
    } catch {
      setErr('下載失敗,請稍後再試。');
    } finally {
      setDownloading(false);
    }
  }

  function toggleYear(y: number) {
    setYears((prev) => (prev.includes(y) ? prev.filter((v) => v !== y) : [...prev, y]));
  }

  function reset() {
    setYears([]);
    setWrongOnly(false);
    setFrom('');
    setTo('');
  }

  const minDate = meta?.first_at ? localDate(new Date(meta.first_at)) : undefined;
  const maxDate = localDate(new Date());
  const capped = count !== null && meta !== null && count > meta.max_rows;

  return (
    <div
      id="profile-attempts"
      className="scroll-mt-[calc(var(--header-h)+1.5rem)] bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6"
    >
      <h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">答題狀態分析</h2>
      <p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed mb-5">
        把你每一次作答倒成一份 CSV:年份、題號、題幹、你選的選項、正解、是否答對、
        答前信心、標籤、作答秒數、來源與時間,一次一列。站內的統計是幫你看完再給結論,
        這裡則是把原始資料整份交給你,拿去 Excel 或其他工具自己切。
      </p>

      {metaErr && (
        <p className="text-sm text-red-700 dark:text-red-400">讀不到作答紀錄,請重新整理。</p>
      )}

      {!metaErr && !meta && (
        <p className="text-sm text-ink-400 dark:text-ink-500">載入中…</p>
      )}

      {meta && meta.total === 0 && (
        <p className="text-sm text-ink-500 dark:text-ink-400 leading-relaxed">
          目前還沒有可匯出的作答紀錄。去
          <a href="/review" className="text-accent hover:underline underline-offset-2 mx-1">
            複習模式
          </a>
          或全真作答答幾題,紀錄就會出現在這裡。
          <br />
          <span className="text-xs text-ink-400 dark:text-ink-500">
            (逐次作答紀錄自 2026-07 起才開始留存,更早的作答只有累計次數,沒有明細。)
          </span>
        </p>
      )}

      {meta && meta.total > 0 && (
        <div className="space-y-5">
          <FilterRow label="年份">
            <div className="flex flex-wrap gap-2">
              <Chip on={years.length === 0} onClick={() => setYears([])}>
                全部
              </Chip>
              {meta.years.map((y) => (
                <Chip key={y.year} on={years.includes(y.year)} onClick={() => toggleYear(y.year)}>
                  {y.year}
                  <span className="ml-1.5 text-[0.85em] opacity-60">{y.n}</span>
                </Chip>
              ))}
            </div>
          </FilterRow>

          <FilterRow label="範圍">
            <label className="inline-flex items-center gap-2 text-sm text-ink-700 dark:text-ink-200 cursor-pointer">
              <input
                type="checkbox"
                checked={wrongOnly}
                onChange={(e) => setWrongOnly(e.target.checked)}
                className="accent-accent"
              />
              只要答錯的
            </label>
          </FilterRow>

          <FilterRow label="作答區間">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={from}
                min={minDate}
                max={maxDate}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="作答區間起"
                className="px-2 py-1.5 text-sm border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded focus:outline-none focus:border-accent text-ink-900 dark:text-ink-100"
              />
              <span className="text-ink-400 dark:text-ink-500 text-sm">到</span>
              <input
                type="date"
                value={to}
                min={from || minDate}
                max={maxDate}
                onChange={(e) => setTo(e.target.value)}
                aria-label="作答區間迄"
                className="px-2 py-1.5 text-sm border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded focus:outline-none focus:border-accent text-ink-900 dark:text-ink-100"
              />
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {PRESETS.map((p) => {
                const r = lastNDays(p.days);
                return (
                  <Chip
                    key={p.days}
                    on={from === r.from && to === r.to}
                    onClick={() => {
                      setFrom(r.from);
                      setTo(r.to);
                    }}
                  >
                    {p.label}
                  </Chip>
                );
              })}
              <Chip
                on={!from && !to}
                onClick={() => {
                  setFrom('');
                  setTo('');
                }}
              >
                不限
              </Chip>
            </div>
            <p className="text-xs text-ink-400 dark:text-ink-500 mt-2">
              起迄都含當天,以台北時間計。
            </p>
          </FilterRow>

          <div className="pt-1 flex flex-wrap items-center gap-3">
            <button
              onClick={download}
              disabled={downloading || count === 0}
              className="inline-flex items-center gap-2 bg-accent hover:bg-accent-dark text-white px-4 py-2 rounded text-sm font-medium transition disabled:opacity-40"
            >
              <Download size={15} />
              {downloading ? '產生中…' : '下載 CSV'}
              {!downloading && !counting && count !== null && (
                <span className="opacity-80">({count.toLocaleString('en-US')} 筆)</span>
              )}
            </button>
            {!isDefaultFilters(filters) && (
              <button
                onClick={reset}
                className="text-sm text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-200 underline underline-offset-2"
              >
                清除條件
              </button>
            )}
            {counting && (
              <span className="text-xs text-ink-400 dark:text-ink-500">計算中…</span>
            )}
            {count === 0 && !counting && (
              <span className="text-xs text-ink-500 dark:text-ink-400">
                這組條件沒有符合的作答紀錄。
              </span>
            )}
          </div>

          {capped && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              符合條件的有 {count!.toLocaleString('en-US')} 筆,單次最多匯出{' '}
              {meta.max_rows.toLocaleString('en-US')} 筆(取最近的)。想拿完整資料請分年份或分區間下載。
            </p>
          )}

          <p className="text-xs text-ink-400 dark:text-ink-500 leading-relaxed">
            「信心」是複習模式裡揭曉答案前的自評,1=猜、2=普通、3=有把握;模擬考不問信心,
            該欄留白。「秒數」只計實際看著那題的時間,切到別的分頁不算。
            逐次紀錄自 2026-07 起才開始留存,更早的作答只有累計次數,不在這份檔案裡。
          </p>
        </div>
      )}

      {err && <p className="text-sm text-red-700 dark:text-red-400 mt-3">{err}</p>}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sm:flex sm:gap-4">
      <div className="shrink-0 sm:w-24 sm:pt-1.5 mb-1.5 sm:mb-0 text-sm font-medium text-ink-700 dark:text-ink-200">
        {label}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={[
        'px-3 py-1 rounded-full text-sm border transition',
        on
          ? 'bg-accent border-accent text-white'
          : 'border-ink-300 dark:border-ink-600 text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-700',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
