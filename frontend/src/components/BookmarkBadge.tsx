import { Bookmark } from 'lucide-react';
import { useBookmarkSet } from '../hooks/useBookmarkSet';

// Renders a small bookmark indicator next to a question reference in any
// list view. Returns null when not bookmarked, so callers can use it
// unconditionally without adding their own conditional layout.
export function BookmarkBadge({
  questionId,
  size = 12,
  className,
}: {
  questionId: string;
  size?: number;
  className?: string;
}) {
  const { has } = useBookmarkSet();
  if (!has(questionId)) return null;
  return (
    <span title="已收藏" className="inline-flex">
      <Bookmark
        size={size}
        aria-label="已收藏"
        className={'fill-accent text-accent shrink-0 ' + (className ?? '')}
      />
    </span>
  );
}
