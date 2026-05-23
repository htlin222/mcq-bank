import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Folder, FolderPlus, Trash2, MoreVertical } from 'lucide-react';
import { api } from '../lib/api';

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
  group: '內科' | '共同' | null;
};

const UNCATEGORIZED = '__uncat__';
const ALL = '__all__';
const NOTES = '__notes__';

export function Bookmarks() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [uncatCount, setUncatCount] = useState(0);
  const [notesCount, setNotesCount] = useState(0);
  const [active, setActive] = useState<string>(ALL);
  const [items, setItems] = useState<Item[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

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

  useEffect(() => { loadFolders(); }, []);
  useEffect(() => { loadItems(active); }, [active]);

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
          <div className="mt-3 mb-1.5 px-2 text-[11px] uppercase tracking-wider text-ink-400">
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
          {items === null ? (
            <div className="text-ink-400 text-sm">載入中…</div>
          ) : items.length === 0 ? (
            <p className="text-ink-400 text-sm">
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
                    <span className="text-ink-800 dark:text-ink-200 line-clamp-2 leading-relaxed flex-1">{it.stem}</span>
                    {it.group && (
                      <span className={
                        'text-[11px] px-2 py-0.5 rounded shrink-0 self-center ' +
                        (it.group === '內科'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-sky-100 text-sky-800')
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

function SideItem({
  label, count, active, onClick,
}: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left px-2 py-1.5 rounded text-sm flex items-center justify-between ' +
        (active
          ? 'bg-accent/10 text-accent font-medium'
          : 'text-ink-700 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800')
      }
    >
      <span>{label}</span>
      <span className="text-[11px] text-ink-400">{count}</span>
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
        <span className="text-[11px] text-ink-400">{folder.item_count}</span>
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
