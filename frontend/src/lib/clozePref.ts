// Remembers that this reader turned 自動挖空 on for a given question, so the
// blanks come back after a reload instead of needing another button press.
//
// Why a stored flag rather than "restore whenever the server has terms":
// `explanation_cloze` is shared across everyone (one row per explanation
// version), so presence of a cached list says only that *somebody* asked for
// a self-test — restoring from it would blank the 詳解 for readers who never
// asked. `note_cloze` is per-user, but keeping one rule for both is simpler
// than two behaviours that differ in a way nobody will remember.
//
// Device-local on purpose: this is "how I am reading right now", the same
// class of state as the reveal set. The terms themselves live in D1, so a
// second device pays no Workers AI to reach the same place.

const KEY = 'cloze:auto:v1';

export type ClozeSource = 'explanation' | 'note';

/** `114-052|note` — one entry per question *and* section. */
export function prefKey(questionId: string, source: ClozeSource): string {
  return `${questionId}|${source}`;
}

function readAll(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeAll(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* private mode / quota — the toggle still works for this sitting */
  }
}

export function wasAutoCloze(questionId: string, source: ClozeSource): boolean {
  return readAll().has(prefKey(questionId, source));
}

export function rememberAutoCloze(
  questionId: string,
  source: ClozeSource,
  on: boolean,
): void {
  const set = readAll();
  const k = prefKey(questionId, source);
  if (on) set.add(k);
  else set.delete(k);
  writeAll(set);
}
