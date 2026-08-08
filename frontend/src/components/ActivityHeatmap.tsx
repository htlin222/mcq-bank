import { useEffect, useRef } from 'react';
import CalHeatmap from 'cal-heatmap';
import 'cal-heatmap/cal-heatmap.css';
import { api } from '../lib/api';
import { useIsEink } from '../lib/theme';

type Bucket = { d: string; n: number };

// Threshold ramps matched to the warm ink palette; the empty-cell colour sits
// one step off the card surface in each theme so the grid never glares.
const LIGHT_RANGE = ['#ede9e2', '#fde7d4', '#f5c39a', '#e58e60', '#a8442a'];
const DARK_RANGE = ['#2a2419', '#4a3220', '#7a4a28', '#c26a3d', '#e58e60'];
// 電子紙:五階明度在 1-bit 下不存在,改用**網底密度**。cal-heatmap 只是把
// range 的字串塞進 SVG 的 fill,而 `fill="url(#…)"` 是合法的 —— 所以密度階
// 可以用 <pattern> 表達,不必退回「有/沒有」兩值。
// 空白格用白底 + 細黑框(見 styles.css 的 .ch-subdomain-bg 規則),否則整張圖
// 在白紙上會消失。
const EINK_RANGE = ['#fff', 'url(#eink-hm-1)', 'url(#eink-hm-2)', 'url(#eink-hm-3)', '#000'];

// 密度網底。放在同一份 document 裡就好 —— SVG 的 `fill="url(#id)"` 是跨
// <svg> 元素查同文件 id 的,不必塞進 cal-heatmap 自己畫的那棵樹。
function EinkHeatmapPatterns() {
  return (
    <svg width="0" height="0" aria-hidden className="absolute">
      <defs>
        <pattern id="eink-hm-1" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="#fff" />
          <circle cx="2" cy="2" r="0.7" fill="#000" />
        </pattern>
        <pattern id="eink-hm-2" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="#fff" />
          <path d="M0 4L4 0" stroke="#000" strokeWidth="1" />
        </pattern>
        <pattern id="eink-hm-3" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect width="4" height="4" fill="#fff" />
          <path d="M0 4L4 0M-1 1L1 -1M3 5L5 3" stroke="#000" strokeWidth="1.6" />
        </pattern>
      </defs>
    </svg>
  );
}

export function ActivityHeatmap() {
  const eink = useIsEink();
  const ref = useRef<HTMLDivElement>(null);
  const calRef = useRef<any>(null);
  const dataRef = useRef<Bucket[] | null>(null);

  useEffect(() => {
    let alive = true;

    const paint = () => {
      if (!ref.current || !dataRef.current) return;
      if (calRef.current) {
        try { calRef.current.destroy?.(); } catch {}
      }
      // 讀 DOM 而不是讀 props:MutationObserver 觸發的重繪不經過 React,
      // 拿到的必須是「此刻 <html> 上掛的是什麼」。
      const root = document.documentElement.classList;
      const range = root.contains('eink')
        ? EINK_RANGE
        : root.contains('dark')
          ? DARK_RANGE
          : LIGHT_RANGE;
      const cal = new CalHeatmap();
      calRef.current = cal;
      cal.paint({
        itemSelector: ref.current,
        domain: { type: 'month', gutter: 6 },
        subDomain: { type: 'ghDay', radius: 2, width: 13, height: 13, gutter: 3 },
        date: { start: new Date(Date.now() - 80 * 86_400_000) },
        range: 3,
        data: {
          source: dataRef.current.map((d) => ({ date: d.d, value: d.n })),
          x: 'date',
          y: 'value',
        },
        scale: {
          color: {
            type: 'threshold',
            range,
            domain: [1, 5, 10, 20],
          },
        },
      });
    };

    api.get<Bucket[]>('/api/review/heatmap?days=90').then((data) => {
      if (!alive) return;
      dataRef.current = data;
      paint();
    }).catch(() => {/* ignore */});

    // ThemeToggle flips the `dark` / `eink` class on <html>; repaint so the
    // cell colours follow (cal-heatmap bakes them into the SVG at paint time).
    const observer = new MutationObserver(() => paint());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      alive = false;
      observer.disconnect();
      try { calRef.current?.destroy?.(); } catch {}
    };
  }, []);

  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 overflow-x-auto h-full">
      <div className="text-xs uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-3">
        最近 3 個月活動
      </div>
      {eink && <EinkHeatmapPatterns />}
      <div ref={ref} className="cal-heatmap-host" />
    </div>
  );
}
