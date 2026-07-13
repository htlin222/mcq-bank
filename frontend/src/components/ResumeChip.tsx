import { Link } from 'react-router-dom';
import { ArrowRight, X } from 'lucide-react';

// One-line "resume where you left off" banner. Purely presentational —
// the caller decides what was remembered and what dismissing means.
export function ResumeChip({
  prefix,
  label,
  to,
  onDismiss,
}: {
  prefix: string; // e.g. 「上次停留」 / 「你上次停在」
  label: string;
  to: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-sm bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg px-4 py-2.5 shadow-paper">
      <span className="text-ink-500 dark:text-ink-400 shrink-0">{prefix}</span>
      <Link
        to={to}
        className="inline-flex items-center gap-1 text-accent hover:text-accent-dark font-medium truncate"
      >
        {label} <ArrowRight size={14} className="shrink-0" />
      </Link>
      <button
        aria-label="關閉"
        onClick={onDismiss}
        className="ml-auto shrink-0 text-ink-400 hover:text-ink-600 dark:hover:text-ink-200"
      >
        <X size={14} />
      </button>
    </div>
  );
}
