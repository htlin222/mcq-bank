import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';

// Global bookmark state — fetched once on app load, mutated optimistically
// when the user toggles a bookmark anywhere. List views read from this set
// to show a "★ 收藏" badge regardless of which endpoint produced the row.
//
// Cheap because each user has at most a few hundred bookmarks total.

type BookmarkRow = { id: string };

type Ctx = {
  ready: boolean;
  has: (questionId: string) => boolean;
  add: (questionId: string) => void;
  remove: (questionId: string) => void;
  reload: () => Promise<void>;
};

const BookmarkContext = createContext<Ctx | null>(null);

export function BookmarkProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);

  async function reload() {
    try {
      const rows = await api.get<BookmarkRow[]>('/api/bookmarks');
      setIds(new Set(rows.map((r) => r.id)));
      setReady(true);
    } catch {
      setReady(true);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  const value: Ctx = {
    ready,
    has: (qid) => ids.has(qid),
    add: (qid) =>
      setIds((prev) => {
        if (prev.has(qid)) return prev;
        const next = new Set(prev);
        next.add(qid);
        return next;
      }),
    remove: (qid) =>
      setIds((prev) => {
        if (!prev.has(qid)) return prev;
        const next = new Set(prev);
        next.delete(qid);
        return next;
      }),
    reload,
  };

  return <BookmarkContext.Provider value={value}>{children}</BookmarkContext.Provider>;
}

export function useBookmarkSet(): Ctx {
  const ctx = useContext(BookmarkContext);
  if (!ctx) {
    throw new Error('useBookmarkSet must be used inside <BookmarkProvider>');
  }
  return ctx;
}
