import { useEffect, useRef } from 'react';
import CalHeatmap from 'cal-heatmap';
import 'cal-heatmap/cal-heatmap.css';
import { api } from '../lib/api';

type Bucket = { d: string; n: number };

export function ActivityHeatmap() {
  const ref = useRef<HTMLDivElement>(null);
  const calRef = useRef<any>(null);

  useEffect(() => {
    let alive = true;
    api.get<Bucket[]>('/api/review/heatmap?days=90').then((data) => {
      if (!alive || !ref.current) return;
      if (calRef.current) {
        try { calRef.current.destroy?.(); } catch {}
      }
      const cal = new CalHeatmap();
      calRef.current = cal;
      cal.paint({
        itemSelector: ref.current,
        domain: { type: 'month', gutter: 6 },
        subDomain: { type: 'ghDay', radius: 2, width: 13, height: 13, gutter: 3 },
        date: { start: new Date(Date.now() - 80 * 86_400_000) },
        range: 3,
        data: {
          source: data.map((d) => ({ date: d.d, value: d.n })),
          x: 'date',
          y: 'value',
        },
        scale: {
          color: {
            type: 'threshold',
            range: ['#ede9e2', '#fde7d4', '#f5c39a', '#e58e60', '#a8442a'],
            domain: [1, 5, 10, 20],
          },
        },
      });
    }).catch(() => {/* ignore */});
    return () => {
      alive = false;
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
