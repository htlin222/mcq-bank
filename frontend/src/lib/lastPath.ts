// Remember the last page the user was on — localStorage, so it survives
// closing the tab / browser on the same device. (Cross-device resume would
// need server-side state, which we deliberately don't keep for this.)

const KEY = 'last-path';

export type LastPath = { path: string; at: number };

export function saveLastPath(path: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

export function loadLastPath(): LastPath | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as LastPath;
    return typeof v?.path === 'string' && typeof v?.at === 'number' ? v : null;
  } catch {
    return null;
  }
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
