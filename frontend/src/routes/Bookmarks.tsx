import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Folder, FolderPlus, Trash2, MoreVertical, Highlighter } from 'lucide-react';
import { api } from '../lib/api';
import { BookmarkBadge } from '../components/BookmarkBadge';
import { groupBadgeClass } from '../lib/groups';
import { loadNoteHighlights, type HlGroup } from '../lib/noteHighlights';

type Folder = { id: string; name: string; sort: number; item_count: number };
type FoldersResp = {
  folders: Folder[];
  uncategorized_count: number;
  notes_count: number;
};
type Item = {
  id: string;            // question id
  folder_id: string | null;
  note: string | null;
  created_at: number;
  year: number;
  number: number;
  stem: string;
  group: string | null;
};

const UNCATEGORIZED = '__uncat__';
const ALL = '__all__';
const NOTES = '__notes__';
const HIGHLIGHTS = '__highlights__';

export function Bookmarks() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [uncatCount, setUncatCount] = useState(0);
  const [notesCount, setNotesCount] = useState(0);
  const [active, setActive] = useState<string>(ALL);
  const [items, setItems] = useState<Item[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  // 我的畫記 — derived from this device's localStorage, not the server.
  const hlGroups = useMemo<HlGroup[]>(() => loadNoteHighlights(), []);
  // qid → stem/group, fetched per involved year when the tab opens.
  const [hlStems, setHlStems] = useState<Record<string, { stem: string; group: string | null }>>({});

  async function loadFolders() {
    const r = await api.get<FoldersResp>('/api/folders');
    setFolders(r.folders);
    setUncatCount(r.uncategorized_count);
    setNotesCount(r.notes_count);
  }

  async function loadItems(folder: string) {
    let qs = '';
    if (folder === NOTES) qs = '?source=notes';
    else if (folder === UNCATEGORIZED) qs = '?folder=null';
    else if (folder !== ALL) qs = `?folder=${folder}`;
    const r = await api.get<Item[]>(`/api/bookmarks${qs}`);
    setItems(r);
  }

  // Stems for the highlighted questions — batched by the years involved (no
  // per-id endpoint), joined locally. 年-題號 already comes from the qid.
  async function loadHlStems() {
    const years = [...new Set(hlGroups.map((g) => g.year))];
    const missing = years.filter((y) =>
      hlGroups.some((g) => g.year === y && !hlStems[g.qid]),
    );
    if (!missing.length) return;
    const lists = await Promise.all(
      missing.map((y) =>
        api
          .get<{ id: string; stem: string; group: string | null }[]>(
            `/api/questions?year=${y}&limit=200`,
          )
          .catch(() => []),
      ),
    );
    setHlStems((prev) => {
      const next = { ...prev };
      for (const list of lists)
        for (const q of list) next[q.id] = { stem: q.stem, group: q.group };
      return next;
    });
  }

  useEffect(() => { loadFolders(); }, []);
  useEffect(() => {
    // 我的畫記 is localStorage-derived — skip the bookmarks API, fetch stems.
    if (active === HIGHLIGHTS) {
      loadHlStems();
      return;
    }
    loadItems(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function createFolder() {
    if (!newName.trim()) return;
    await api.post('/api/folders', { name: newName.trim() });
    setNewName('');
    setCreating(false);
    await loadFolders();
  }

  async function renameFolder(id: string, current: string) {
    const name = prompt('新名稱', current);
    if (!name || !name.trim() || name === current) return;
    await api.patch(`/api/folders/${id}`, { name: name.trim() });
    await loadFolders();
  }

  async function deleteFolder(id: string, name: string, count: number) {
    if (!confirm(`刪除「${name}」?\n資料夾內 ${count} 則收藏會變成「未分類」。`)) return;
    await api.del(`/api/folders/${id}`);
    if (active === id) setActive(ALL);
    await loadFolders();
    await loadItems(active === id ? ALL : active);
  }

  async function moveItem(qid: string, toFolder: string | null) {
    await api.put(`/api/bookmarks/${qid}`, { folder_id: toFolder });
    await Promise.all([loadFolders(), loadItems(active)]);
  }

  async function removeItem(qid: string) {
    await api.del(`/api/bookmarks/${qid}`);
    await Promise.all([loadFolders(), loadItems(active)]);
  }

  const totalCount = folders.reduce((s, f) => s + f.item_count, 0) + uncatCount;

  return (
    <div className="max-w-5xl lg:max-w-6xl xl:max-w-7xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-6">我的收藏</h1>

      <div className="grid sm:grid-cols-[200px_1fr] gap-6">
        {/* Folder sidebar */}
        <aside>
          <SideItem
            label="全部"
            count={totalCount}
            active={active === ALL}
            onClick={() => setActive(ALL)}
          />
          <SideItem
            label="未分類"
            count={uncatCount}
            active={active === UNCATEGORIZED}
            onClick={() => setActive(UNCATEGORIZED)}
          />
          <SideItem
            label="已做筆記"
            count={notesCount}
            active={active === NOTES}
            onClick={() => setActive(NOTES)}
          />
          <SideItem
            label="我的畫記"
            count={hlGroups.length}
            active={active === HIGHLIGHTS}
            onClick={() => setActive(HIGHLIGHTS)}
            icon={<Highlighter size={14} className="shrink-0" />}
          />
          <div className="mt-3 mb-1.5 px-2 text-[11px] uppercase tracking-wider text-ink-400 dark:text-ink-500">
            資料夾
          </div>
          {folders.map((f) => (
            <FolderItem
              key={f.id}
              folder={f}
              active={active === f.id}
              onClick={() => setActive(f.id)}
              onRename={() => renameFolder(f.id, f.name)}
              onDelete={() => deleteFolder(f.id, f.name, f.item_count)}
            />
          ))}
          {creating ? (
            <form
              onSubmit={(e) => { e.preventDefault(); createFolder(); }}
              className="mt-2 flex gap-1"
            >
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="flex-1 px-2 py-1 border border-ink-200 dark:border-ink-700 rounded text-sm focus:outline-none focus:border-accent dark:bg-ink-800 dark:text-ink-100"
                placeholder="資料夾名稱"
              />
              <button type="submit" className="px-2 text-sm text-accent">建</button>
            </form>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="mt-2 w-full text-left px-2 py-1.5 text-sm text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800 rounded inline-flex items-center gap-1.5"
            >
              <FolderPlus size={14} /> 新增資料夾
            </button>
          )}
        </aside>

        {/* Items */}
        <section>
          {active === HIGHLIGHTS ? (
            hlGroups.length === 0 ? (
              <p className="text-ink-400 dark:text-ink-500 text-sm">
                這台裝置還沒有個人筆記的畫記。在題目頁的「個人筆記」選取文字即可加螢光標記。
              </p>
            ) : (
              <>
                <p className="text-[11px] text-ink-400 dark:text-ink-500 mb-2">
                  畫記存在本機瀏覽器,僅這台裝置可見。
                </p>
                <ul className="space-y-2">
                  {hlGroups.map((g) => (
                    <HighlightCard key={g.qid} group={g} stem={hlStems[g.qid]} />
                  ))}
                </ul>
              </>
            )
          ) : items === null ? (
            <div className="text-ink-400 dark:text-ink-500 text-sm">載入中…</div>
          ) : items.length === 0 ? (
            <p className="text-ink-400 dark:text-ink-500 text-sm">
              {active === NOTES
                ? '尚未為任何題目寫過個人筆記。在題目頁切到「個人筆記」分頁即可開始。'
                : '這裡還沒有收藏題目。在任何題目右上角點 ▭+ 即可收藏。'}
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((it) => (
                <li key={it.id} className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 flex items-start gap-3 hover:border-accent transition">
                  <Link
                    to={`/q/${it.id}`}
                    className="flex-1 flex items-start gap-3"
                  >
                    <span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0 w-16 text-right">
                      {it.year}-{String(it.number).padStart(3, '0')}
                    </span>
                    {active === NOTES && <BookmarkBadge questionId={it.id} className="mt-1" />}
                    <span className="text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed flex-1">{it.stem}</span>
                    {it.group && (
                      <span className={
                        'text-[11px] px-2 py-0.5 rounded shrink-0 self-center ' +
                        groupBadgeClass(it.group)
                      }>{it.group}</span>
                    )}
                  </Link>
                  {active !== NOTES && (
                    <ItemMenu
                      item={it}
                      folders={folders}
                      onMove={(fid) => moveItem(it.id, fid)}
                      onRemove={() => removeItem(it.id)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// A question with 個人筆記 highlights: 年-題號 + stem, then up to 3 highlighted
// lines (context with the marked span in yellow), and a "還有 N 條" tail.
function HighlightCard({
  group,
  stem,
}: {
  group: HlGroup;
  stem?: { stem: string; group: string | null };
}) {
  const extra = group.total - group.lines.length;
  return (
    <li className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded p-3 hover:border-accent transition">
      <Link to={`/q/${group.qid}`} className="block">
        <div className="flex items-start gap-3">
          <span className="font-mono text-sm text-ink-500 dark:text-ink-400 shrink-0 w-16 text-right">
            {group.year}-{String(group.number).padStart(3, '0')}
          </span>
          <span className="text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed flex-1">
            {stem ? stem.stem : <span className="text-ink-400 dark:text-ink-500">載入題幹…</span>}
          </span>
          {stem?.group && (
            <span className={
              'text-[11px] px-2 py-0.5 rounded shrink-0 self-center ' +
              groupBadgeClass(stem.group)
            }>{stem.group}</span>
          )}
        </div>
        <ul className="mt-2 pl-16 space-y-1">
          {group.lines.map((line, i) => (
            <li
              key={i}
              className="text-[13px] leading-relaxed text-ink-600 dark:text-ink-300 line-clamp-2"
            >
              {line.ellipsisStart && '…'}
              {line.segments.map((s, j) =>
                s.hl ? (
                  <mark key={j} className="bg-yellow-200 dark:bg-yellow-400/30 text-inherit rounded-sm px-0.5">
                    {s.text}
                  </mark>
                ) : (
                  <span key={j}>{s.text}</span>
                ),
              )}
              {line.ellipsisEnd && '…'}
            </li>
          ))}
          {extra > 0 && (
            <li className="text-[11px] text-ink-400 dark:text-ink-500">還有 {extra} 條畫記…</li>
          )}
        </ul>
      </Link>
    </li>
  );
}

function SideItem({
  label, count, active, onClick, icon,
}: {
  label: string; count: number; active: boolean; onClick: () => void;
  icon?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-1.5 ' +
        (active
          ? 'bg-accent/10 text-accent font-medium'
          : 'text-ink-700 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800')
      }
    >
      {icon}
      <span className="flex-1">{label}</span>
      <span className="text-[11px] text-ink-400 dark:text-ink-500">{count}</span>
    </button>
  );
}

function FolderItem({
  folder, active, onClick, onRename, onDelete,
}: {
  folder: Folder; active: boolean;
  onClick: () => void; onRename: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group relative">
      <button
        onClick={onClick}
        className={
          'w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-1.5 ' +
          (active
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-ink-700 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800')
        }
      >
        <Folder size={14} className="shrink-0" />
        <span className="flex-1 truncate">{folder.name}</span>
        <span className="text-[11px] text-ink-400 dark:text-ink-500">{folder.item_count}</span>
        <span
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
          className="p-1 opacity-0 group-hover:opacity-100 hover:bg-ink-200 dark:hover:bg-ink-700 rounded"
          role="button"
        >
          <MoreVertical size={12} />
        </span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-32 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded shadow-lg z-30 text-sm py-1"
          onMouseLeave={() => setOpen(false)}
        >
          <button onClick={() => { onRename(); setOpen(false); }} className="w-full text-left px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-700 text-ink-700 dark:text-ink-200">重新命名</button>
          <button onClick={() => { onDelete(); setOpen(false); }} className="w-full text-left px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-700 dark:text-rose-300 inline-flex items-center gap-1.5">
            <Trash2 size={12} /> 刪除
          </button>
        </div>
      )}
    </div>
  );
}

function ItemMenu({
  item, folders, onMove, onRemove,
}: {
  item: Item; folders: Folder[];
  onMove: (folderId: string | null) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0" onMouseLeave={() => setOpen(false)}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-1.5 text-ink-400 hover:text-accent hover:bg-ink-100 dark:hover:bg-ink-700 rounded"
        aria-label="管理"
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded shadow-lg z-20 py-1 text-sm">
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-ink-400 border-b border-ink-100 dark:border-ink-700">
            移到資料夾
          </div>
          <button onClick={() => { onMove(null); setOpen(false); }} className={
            'w-full text-left px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-700 ' +
            (item.folder_id === null ? 'text-accent font-medium' : 'text-ink-700 dark:text-ink-200')
          }>
            未分類
          </button>
          {folders.map((f) => (
            <button key={f.id} onClick={() => { onMove(f.id); setOpen(false); }} className={
              'w-full text-left px-3 py-1.5 hover:bg-ink-50 dark:hover:bg-ink-700 ' +
              (item.folder_id === f.id ? 'text-accent font-medium' : 'text-ink-700 dark:text-ink-200')
            }>
              {f.name}
            </button>
          ))}
          <button onClick={() => { onRemove(); setOpen(false); }} className="w-full text-left px-3 py-1.5 hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-700 dark:text-rose-300 border-t border-ink-100 dark:border-ink-700 mt-1 pt-1 inline-flex items-center gap-1.5">
            <Trash2 size={12} /> 取消收藏
          </button>
        </div>
      )}
    </div>
  );
}
