import { useCallback, useEffect, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { api } from '../lib/api';

// 讀書進度預估卡片 —— 「以我目前的速度,考前做得完嗎」。
//
// 設計立場(見 docs/plans/2026-07-20-study-goals-and-pacing.md):
//   * 每週目標,不是 daily streak。漏一天就歸零對成年在職考生(值班、家庭、
//     突發)是棄坑觸發器而非動力;每週目標保留「週三沒讀、週六補回來」的空間。
//   * 沒有排行榜、積分、徽章。所有數字只有自己看得到。
//   * 落後時的文案是「每天 N 題就能追上」這種具體可執行的下一步,不是
//     「你落後了」。不用紅色、不用警告語彙。
//
// 天數一律用 API 的 `days_left`(對毫秒差 ceil),不要混用首頁倒數卡的
// `countdown.days`(floor)—— 兩者會差一天,同一畫面出現兩個天數是體感 bug。

export type Pacing = {
  total_questions: number;
  completed: number;
  remaining: number;
  done: boolean;
  days_left: number | null;
  recent_rate: number;
  days_to_finish: number | null;
  buffer_days: number | null;
  on_track: boolean | null;
  needed_per_day: number | null;
  week_start: string;
  week_done: number;
  week_target: number;
  week_pct: number;
  week_met: boolean;
  weekly_target: number;
  weekly_target_is_default: boolean;
};

export function verdict(p: Pacing): string {
  if (p.done) return '第一輪已完成 — 接下來交給 FSRS 複習排程。';
  if (p.recent_rate === 0)
    return '這週還沒開始 — 先做 10 題暖身,速度算得出來卡片就會更新。';
  if (p.days_left == null)
    return `近 7 天平均 ${p.recent_rate} 題/天,依此速度還需 ${p.days_to_finish} 天完成第一輪。`;
  if (p.on_track)
    return `依近 7 天速度(平均 ${p.recent_rate} 題/天),預計考前 ${p.buffer_days} 天完成第一輪。`;
  return `每天 ${p.needed_per_day} 題就能在考前跑完第一輪(近 7 天平均 ${p.recent_rate} 題/天)。`;
}

export function PacingCard() {
  const [p, setP] = useState<Pacing | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saveErr, setSaveErr] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    return api
      .get<Pacing>('/api/review/readiness')
      .then((d) => {
        setP(d);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    setSaveErr('');
    try {
      await api.put('/api/review/goal', { weekly_target: Number(draft) });
      // 重新取數而不是只改本地 state —— week_pct / week_met 是後端算的。
      await load();
      setEditing(false);
    } catch {
      setSaveErr('請輸入 1 到 1000 之間的題數');
    } finally {
      setSaving(false);
    }
  }

  // 固定高度的骨架,避免卡片載入完成時把下面的 heatmap 推下去(CLS)。
  if (!p) {
    return (
      <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 shadow-paper min-h-[7.5rem]">
        <p className="text-sm text-ink-400 dark:text-ink-500">
          {failed ? '進度預估暫時讀不到' : '載入進度預估…'}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 shadow-paper min-h-[7.5rem]">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-ink-500 dark:text-ink-400">
          {p.days_left != null ? `距考試 ${p.days_left} 天 · ` : ''}
          已完成 {p.completed} / {p.total_questions} 題
        </p>
        <button
          type="button"
          aria-label="設定每週目標"
          onClick={() => {
            setDraft(String(p.weekly_target));
            setSaveErr('');
            setEditing((v) => !v);
          }}
          className="shrink-0 text-ink-400 hover:text-accent transition"
        >
          <Settings2 size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <span className="text-ink-800 dark:text-ink-100">
            本週{' '}
            <span className="font-mono tabular-nums text-lg text-accent dark:text-accent-light">
              {p.week_done}
            </span>{' '}
            / {p.week_target} 題
            {p.weekly_target_is_default ? (
              <span className="ml-1.5 text-xs text-ink-400 dark:text-ink-500">
                建議值
              </span>
            ) : null}
          </span>
          <span className="text-xs text-ink-400 dark:text-ink-500">
            {p.week_met ? '本週目標已達成' : `本週起算 ${p.week_start}`}
          </span>
        </div>
        <div
          // eink:軌道補黑框,否則 0% 時淡色軌道被洗白、整條看不見
          className="mt-2 h-1.5 rounded-full bg-ink-100 dark:bg-ink-700 overflow-hidden eink:border eink:border-black"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, p.week_pct)}
          aria-label="本週目標進度"
        >
          <div
            className="h-full bg-accent"
            style={{ width: `${Math.min(100, p.week_pct)}%` }}
          />
        </div>
      </div>

      {editing ? (
        <div className="mt-3">
          <div className="flex items-center gap-2 flex-wrap">
            <label
              htmlFor="weekly-target"
              className="text-sm text-ink-600 dark:text-ink-300"
            >
              每週目標
            </label>
            <input
              id="weekly-target"
              type="number"
              min={1}
              max={1000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-24 px-2 py-1 rounded border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 text-ink-800 dark:text-ink-100 font-mono tabular-nums text-sm"
            />
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-3 py-1 text-sm rounded bg-accent text-white hover:bg-accent-dark disabled:opacity-50 transition"
            >
              儲存
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setSaveErr('');
              }}
              className="px-3 py-1 text-sm rounded border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 hover:border-accent transition"
            >
              取消
            </button>
          </div>
          {saveErr ? (
            <p className="mt-2 text-xs text-ink-600 dark:text-ink-300">{saveErr}</p>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink-600 dark:text-ink-300">{verdict(p)}</p>
      )}
    </div>
  );
}
