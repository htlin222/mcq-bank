import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search as SearchIcon, X as XIcon, FolderPlus } from 'lucide-react';
import { api } from '../lib/api';
import { BookmarkBadge } from '../components/BookmarkBadge';
import { useBookmarkSet } from '../hooks/useBookmarkSet';

type Hit = {
  id: string;
  year: number;
  number: number;
  stem: string;
  group: '內科' | '共同' | null;
  snippet: string;
};
type Year = { year: number; count: number };
type Tag = { tag: string; count: number };

export function Search() {
  const [sp, setSp] = useSearchParams();
  const initialQ = sp.get('q') || '';
  const [q, setQ] = useState(initialQ);
  const [year, setYear] = useState<string>(sp.get('year') || '');
  const [group, setGroup] = useState<string>(sp.get('group') || '');
  const [tagSet, setTagSet] = useState<Set<string>>(
    new Set((sp.get('tags') || '').split(',').filter(Boolean)),
  );
  const [years, setYears] = useState<Year[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const bookmarkSet = useBookmarkSet();
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    api.get<Year[]>('/api/questions/_meta/years').then(setYears);
    api.get<Tag[]>('/api/questions/_meta/tags').then(setAllTags);
  }, []);

  const doSearch = useCallback(async () => {
    setSearching(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (year) params.set('year', year);
      if (group) params.set('group', group);
      if (tagSet.size > 0) params.set('tags', [...tagSet].join(','));
      setSp(params, { replace: true });
      const r = await api.get<{ items: Hit[] }>(`/api/search?${params}`);
      setHits(r.items);
    } finally {
      setSearching(false);
    }
  }, [q, year, group, tagSet, setSp]);

  // Initial search if URL had params
  useEffect(() => {
    if (initialQ || sp.get('year') || sp.get('group') || sp.get('tags')) {
      doSearch();
    }
  }, []);

  function toggleTag(t: string) {
    setTagSet((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  async function saveResults() {
    if (!hits || hits.length === 0 || saving) return;
    const name = folderName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const folder = await api.post<{ id: string; name: string }>('/api/folders', { name });
      const r = await api.post<{ inserted: number }>('/api/bookmarks/bulk', {
        question_ids: hits.map((h) => h.id),
        folder_id: folder.id,
      });
      setSavePromptOpen(false);
      setFolderName('');
      setSavedNotice(`已存 ${r.inserted} 題到資料夾「${folder.name}」`);
      setTimeout(() => setSavedNotice(null), 5000);
      // bulk-save adds bookmarks across the result set; refresh the global
      // bookmark set so the badge appears immediately everywhere.
      bookmarkSet.reload();
    } catch (e) {
      alert('儲存失敗:' + String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-4xl lg:max-w-5xl xl:max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-6 inline-flex items-center gap-2">
        <SearchIcon size={26} /> 搜尋
      </h1>

      <form
        onSubmit={(e) => { e.preventDefault(); doSearch(); }}
        className="flex gap-2 mb-4"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="關鍵字 (例:AML、Factor VIII、誘導化療)"
          className="flex-1 px-4 py-2.5 border border-ink-200 dark:border-ink-700 rounded text-base focus:outline-none focus:border-accent bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100"
        />
        <button
          type="submit"
          disabled={searching}
          className="bg-accent hover:bg-accent-dark text-white px-5 py-2.5 rounded font-medium disabled:opacity-40"
        >
          {searching ? '搜尋中…' : '搜尋'}
        </button>
      </form>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4 items-center text-sm">
        <select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
        >
          <option value="">所有年度</option>
          {years.map((y) => (
            <option key={y.year} value={y.year}>民國 {y.year}{y.year === 100 ? ' (模擬)' : ''}</option>
          ))}
        </select>
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          className="px-3 py-1.5 border border-ink-200 dark:border-ink-700 rounded bg-white dark:bg-ink-800 text-ink-800 dark:text-ink-200"
        >
          <option value="">所有 group</option>
          <option value="內科">內科</option>
          <option value="共同">共同</option>
        </select>
        {tagSet.size > 0 && (
          <button
            onClick={() => setTagSet(new Set())}
            className="text-xs text-ink-500 hover:text-rose-600 inline-flex items-center gap-1"
          >
            <XIcon size={12} /> 清除 {tagSet.size} 個 tag
          </button>
        )}
      </div>

      {/* Tag chips */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-6">
          {allTags.slice(0, 40).map((t) => {
            const on = tagSet.has(t.tag);
            return (
              <button
                key={t.tag}
                onClick={() => toggleTag(t.tag)}
                className={
                  'text-[11px] px-2 py-0.5 rounded transition ' +
                  (on
                    ? 'bg-accent text-white'
                    : 'bg-ink-100 dark:bg-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-200 dark:hover:bg-ink-600')
                }
              >
                #{t.tag} <span className="opacity-60">{t.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Results */}
      {hits === null ? (
        <p className="text-ink-400 text-sm">輸入關鍵字或選 filter 開始搜尋。</p>
      ) : hits.length === 0 ? (
        <p className="text-ink-400 text-sm">沒有符合的題目。</p>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <p className="text-xs text-ink-500 dark:text-ink-400">{hits.length} 筆結果</p>
            <div className="flex items-center gap-2">
              {savedNotice && (
                <span className="text-xs text-emerald-700 dark:text-emerald-300">{savedNotice}</span>
              )}
              {!savePromptOpen ? (
                <button
                  onClick={() => setSavePromptOpen(true)}
                  className="text-xs text-accent hover:text-accent-dark inline-flex items-center gap-1.5"
                >
                  <FolderPlus size={14} /> 儲存為收藏資料夾
                </button>
              ) : (
                <form
                  onSubmit={(e) => { e.preventDefault(); saveResults(); }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    autoFocus
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    placeholder="資料夾名稱"
                    maxLength={40}
                    className="px-2 py-1 border border-ink-200 dark:border-ink-700 rounded text-xs bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    disabled={saving || !folderName.trim()}
                    className="bg-accent hover:bg-accent-dark text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-40"
                  >
                    {saving ? '存…' : '存'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSavePromptOpen(false); setFolderName(''); }}
                    disabled={saving}
                    className="text-xs text-ink-500 hover:text-ink-700"
                  >
                    取消
                  </button>
                </form>
              )}
            </div>
          </div>
          <ul className="space-y-2">
            {hits.map((h) => (
              <li key={h.id}>
                <Link
                  to={`/q/${h.id}`}
                  className="block bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent hover:shadow-paper transition"
                >
                  <div className="flex items-center gap-2 text-xs mb-1.5">
                    <span className="font-mono text-ink-500 dark:text-ink-400">
                      {h.year}-{String(h.number).padStart(3, '0')}
                    </span>
                    <BookmarkBadge questionId={h.id} />
                    {h.group && (
                      <span className={
                        'px-1.5 py-0.5 rounded text-[10px] ' +
                        (h.group === '內科'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-sky-100 text-sky-800')
                      }>{h.group}</span>
                    )}
                  </div>
                  <div className="text-ink-800 dark:text-ink-200 text-sm leading-relaxed">
                    {h.snippet ? <Snippet text={h.snippet} /> : <span className="line-clamp-2">{h.stem}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Render FTS5 snippet (uses << >> as our markers — see worker/routes/search.ts)
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<<[^>]+>>)/g);
  return (
    <span className="line-clamp-3">
      {parts.map((p, i) =>
        p.startsWith('<<') && p.endsWith('>>') ? (
          <mark key={i} className="bg-amber-200 dark:bg-amber-700 text-inherit rounded px-0.5">
            {p.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}
