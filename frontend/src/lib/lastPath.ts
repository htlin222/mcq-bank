// Remember the last page the user was on.
//
// Two tiers:
// - Global 「上次停留」 (Home chip): localStorage — per-device is fine there.
// - Section 複習 / 全真 positions: server-side via /api/state (UserState
//   Durable Object), so they follow the user across computers.

import { api } from './api';

const KEY = 'last-path';
// Entries older than this are ignored — a two-week-old "resume" is noise.
export const RESUME_MAX_AGE_MS = 14 * 86_400_000;

export type LastPath = { path: string; at: number };
// Section-scoped memories: 複習 remembers the last question/year page,
// 全真 remembers the in-progress exam session.
export type Section = 'review' | 'exam';

function write(key: string, path: string) {
  try {
    localStorage.setItem(key, JSON.stringify({ path, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

function read(key: string): LastPath | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as LastPath;
    if (typeof v?.path !== 'string' || typeof v?.at !== 'number') return null;
    return Date.now() - v.at < RESUME_MAX_AGE_MS ? v : null;
  } catch {
    return null;
  }
}

export function saveLastPath(path: string) {
  write(KEY, path);
}

export function loadLastPath(): LastPath | null {
  return read(KEY);
}

// Section writes are debounced (rapid prev/next question hops collapse into
// one request) and fire-and-forget — losing one is harmless.
const sectionTimers = new Map<Section, number>();

export function saveSectionPath(section: Section, path: string) {
  const prev = sectionTimers.get(section);
  if (prev !== undefined) window.clearTimeout(prev);
  sectionTimers.set(
    section,
    window.setTimeout(() => {
      sectionTimers.delete(section);
      api.put(`/api/state/${section}`, { path }).catch(() => {});
    }, 1000),
  );
}

export async function loadSectionPath(section: Section): Promise<LastPath | null> {
  try {
    const positions = await api.get<Record<Section, LastPath | null>>('/api/state');
    const v = positions[section];
    return v && Date.now() - v.at < RESUME_MAX_AGE_MS ? v : null;
  } catch {
    return null;
  }
}

export function clearSectionPath(section: Section) {
  const prev = sectionTimers.get(section);
  if (prev !== undefined) {
    window.clearTimeout(prev);
    sectionTimers.delete(section);
  }
  api.del(`/api/state/${section}`).catch(() => {});
}

// Human label for the resume chip on Home.
export function describePath(path: string): string {
  const base = path.split('?')[0];
  const q = /^\/q\/(\d+)-(\d+)$/.exec(base);
  if (q) return `${q[1]} 年第 ${q[2]} 題`;
  const year = /^\/year\/(\d+)$/.exec(base);
  if (year) return `${year[1]} 年題目列表`;
  if (/^\/lectures\/.+/.test(base)) return '講義閱讀';
  if (/^\/exam\/.+\/result$/.test(base)) return '模擬考結果';
  if (/^\/exam\/.+/.test(base)) return '進行中的模擬考';
  const named: Record<string, string> = {
    '/review': '複習模式',
    '/exam': '全真作答',
    '/search': '搜尋',
    '/bookmarks': '我的收藏',
    '/wrong': '錯題回顧',
    '/lectures': '講義',
    '/challenges': '答案挑戰',
    '/chat': '聊天大廳',
    '/exam-history': '作答紀錄',
    '/profile': '個人資料',
    '/anki': 'Anki 卡片',
  };
  return named[base] ?? base;
}
