import { useEffect, useRef } from 'react';
import CalHeatmap from 'cal-heatmap';
import 'cal-heatmap/cal-heatmap.css';
import { api } from '../lib/api';

type Bucket = { d: string; n: number };

// Threshold ramps matched to the warm ink palette; the empty-cell colour sits
// one step off the card surface in each theme so the grid never glares.
const LIGHT_RANGE = ['#ede9e2', '#fde7d4', '#f5c39a', '#e58e60', '#a8442a'];
const DARK_RANGE = ['#2a2419', '#4a3220', '#7a4a28', '#c26a3d', '#e58e60'];

export function ActivityHeatmap() {
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
      const dark = document.documentElement.classList.contains('dark');
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
            range: dark ? DARK_RANGE : LIGHT_RANGE,
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

    // ThemeToggle flips the `dark` class on <html>; repaint so the cell
    // colours follow (cal-heatmap bakes them into the SVG at paint time).
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
      <div ref={ref} className="cal-heatmap-host" />
    </div>
  );
}
