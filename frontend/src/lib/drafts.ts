// Session-scoped draft persistence for in-progress edits (TipTap comment /
// explanation / note drafts). sessionStorage: survives route switches and
// reloads within the browser tab, evaporates when the tab closes. Purely
// client-side — nothing here talks to the server.

const PREFIX = 'draft:';
const timers = new Map<string, number>();

export function loadDraft<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

// TipTap "nothing typed yet" shapes: no nodes, or a single empty paragraph.
export function isEmptyDoc(json: any): boolean {
  const nodes = json?.content;
  if (!Array.isArray(nodes) || nodes.length === 0) return true;
  return nodes.length === 1 && !nodes[0]?.content?.length;
}

// Debounced write — TipTap fires onUpdate per keystroke, and serialising a
// large doc every keystroke is wasted work. The timer lives at module level,
// so a pending write still lands after the component unmounts (route switch);
// only a tab close inside the delay can drop it, and then sessionStorage
// would have died with the tab anyway.
export function saveDraft(key: string, value: unknown, delay = 400) {
  const prev = timers.get(key);
  if (prev !== undefined) window.clearTimeout(prev);
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      const empty =
        value === null ||
        value === '' ||
        (typeof value === 'object' && (value as any)?.type === 'doc' && isEmptyDoc(value));
      try {
        if (empty) sessionStorage.removeItem(PREFIX + key);
        else sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch {
        /* private mode / quota — the draft just won't persist */
      }
    }, delay),
  );
}

// Also cancels a pending debounced write, so a save/cancel can't be
// resurrected by a timer that fires afterwards.
export function clearDraft(key: string) {
  const t = timers.get(key);
  if (t !== undefined) {
    window.clearTimeout(t);
    timers.delete(key);
  }
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}
