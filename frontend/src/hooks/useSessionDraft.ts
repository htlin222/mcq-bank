import { useEffect, useState } from 'react';

/**
 * useState backed by sessionStorage: the value survives route switches and
 * page reloads within the browser tab, and evaporates when the tab closes.
 * Meant for ephemeral drafts (chat input, reply target), not server state.
 *
 * Values are JSON-serialised; an empty string or null clears the entry so
 * abandoned drafts don't pile up.
 */
export function useSessionDraft<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      if (value === null || value === '') sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota — the draft just won't persist */
    }
  }, [key, value]);

  return [value, setValue] as const;
}
