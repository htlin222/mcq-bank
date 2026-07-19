import { api } from './api';
import { pickHighlight, type LocalHl, type ServerHl } from './highlightSync';

// Storage layer for 畫記 (highlights). localStorage stays the instant,
// offline-capable cache; the server (/api/highlights) makes them follow the
// user across devices. Every write goes to both; reads reconcile the two by
// content hash + last-write-wins (see pickHighlight).

type StoredDoc = { h: string; doc: unknown; t: number };

// ── localStorage (now carries a timestamp `t`; legacy entries lack it) ──

export function readLocal(storeKey: string): LocalHl {
  try {
    const raw = localStorage.getItem(storeKey);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.h === 'string' && p.doc) {
      return { h: p.h, doc: p.doc, t: typeof p.t === 'number' ? p.t : 0 };
    }
  } catch {
    /* corrupt cache */
  }
  return null;
}

function writeLocal(storeKey: string, v: StoredDoc): void {
  try {
    localStorage.setItem(storeKey, JSON.stringify(v));
  } catch {
    /* quota/availability */
  }
}

// ── server ──

async function loadServer(storeKey: string): Promise<ServerHl> {
  try {
    return await api.get<ServerHl>(`/api/highlights/one?key=${encodeURIComponent(storeKey)}`);
  } catch {
    return null;
  }
}

export async function saveServer(storeKey: string, v: StoredDoc): Promise<void> {
  try {
    await api.put('/api/highlights', {
      store_key: storeKey,
      content_hash: v.h,
      doc_json: JSON.stringify(v.doc),
      updated_at: v.t,
    });
  } catch {
    /* offline — localStorage still holds it, migration will retry later */
  }
}

// ── public API ──

// Persist a highlight edit: local immediately, server fire-and-forget.
export function saveHighlight(storeKey: string, h: string, doc: unknown): void {
  const t = Date.now();
  writeLocal(storeKey, { h, doc, t });
  void saveServer(storeKey, { h, doc, t });
}

export function removeHighlight(storeKey: string): void {
  try {
    localStorage.removeItem(storeKey);
  } catch {
    /* ignore */
  }
  void api.del(`/api/highlights?key=${encodeURIComponent(storeKey)}`).catch(() => {});
}

// Reconcile local vs server for this key. Returns a doc ONLY when the server
// holds a newer copy that should replace what the local cache is showing;
// otherwise returns null (local is already current) after pushing local up if
// the server was missing/stale.
export async function reconcileHighlight(
  storeKey: string,
  baseHash: string,
): Promise<unknown | null> {
  const local = readLocal(storeKey);
  const server = await loadServer(storeKey);
  const pick = pickHighlight(local, server, baseHash);

  if (pick.source === 'server' && server) {
    const doc = safeParse(server.doc_json);
    if (doc == null) return null;
    writeLocal(storeKey, { h: server.content_hash, doc, t: server.updated_at });
    return doc;
  }

  if (pick.source === 'local' && pick.pushToServer && local) {
    void saveServer(storeKey, { h: local.h, doc: local.doc, t: local.t ?? Date.now() });
  }
  return null;
}

// One-time-per-device upload of pre-sync localStorage highlights to the server,
// so existing 畫記 aren't stranded on one device. Uses reconcileHighlight per
// key (against the entry's own hash), which pushes to the server only when the
// server is missing/older — never clobbering a newer copy from another device.
// Guarded by a flag so it runs once; call only when authenticated.
const MIGRATED_FLAG = 'anno:synced:v1';

export async function migrateLocalHighlights(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATED_FLAG)) return;
  } catch {
    return;
  }
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('anno:exp:') || k.startsWith('anno:note:'))) keys.push(k);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    const local = readLocal(key);
    if (!local) continue;
    try {
      await reconcileHighlight(key, local.h);
    } catch {
      /* one bad key shouldn't abort the sweep */
    }
  }
  try {
    localStorage.setItem(MIGRATED_FLAG, String(keys.length));
  } catch {
    /* ignore */
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
