// Shim — cal-heatmap ships types but its package.json `exports` map doesn't
// surface them in modern resolvers. Treat as opaque; we only use .paint() and
// .destroy() and don't need fine-grained types here.
declare module 'cal-heatmap' {
  export default class CalHeatmap {
    constructor();
    paint(opts: Record<string, unknown>): void;
    destroy?: () => void;
  }
}

declare module 'cal-heatmap/cal-heatmap.css';
