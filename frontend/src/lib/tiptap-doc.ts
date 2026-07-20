// ProseMirror JSON 進入 TipTap 之前的節點名稱正規化。
//
// 為什麼需要:TipTap 的 schema 用 camelCase 宣告節點 (`bulletList`, `listItem`),
// 但寫進 explanations/notes 的文件並不保證是這個拼法 —— markdown 轉換器慣用
// ProseMirror 上游的 snake_case (`bullet_list`, `list_item`)。schema 認不得的
// 節點會讓 TipTap 把**整份文件**丟掉,畫面上就是一張完全空白的詳解卡片(編輯器
// 掛載成功、內容長度 0),看起來像 render 壞掉,其實是資料拼法不合。
//
// worker/lib/tiptap-render.ts 與 scripts/build-anki.py 早就兩種拼法都收,所以
// 匯出與 Anki 一直正常 —— 前端是唯一沒有防線的地方。這裡補上。
//
// 正規化是「讀取端」的防線,不是資料修正:資料本身該在寫入端修好。但顯示層絕不
// 該因為一個節點名稱就整篇消失。

const NODE_ALIASES: Record<string, string> = {
  bullet_list: 'bulletList',
  ordered_list: 'orderedList',
  list_item: 'listItem',
  code_block: 'codeBlock',
  horizontal_rule: 'horizontalRule',
  hard_break: 'hardBreak',
  table_row: 'tableRow',
  table_cell: 'tableCell',
  table_header: 'tableHeader',
};

type AnyNode = { type?: unknown; content?: unknown[]; [k: string]: unknown };

function hasAlias(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as AnyNode;
  if (typeof n.type === 'string' && n.type in NODE_ALIASES) return true;
  const kids = n.content;
  return Array.isArray(kids) && kids.some(hasAlias);
}

function rewrite(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  const n = node as AnyNode;
  const kids = Array.isArray(n.content) ? n.content.map(rewrite) : n.content;
  const type = typeof n.type === 'string' && n.type in NODE_ALIASES ? NODE_ALIASES[n.type] : n.type;
  return { ...n, ...(type === undefined ? {} : { type }), ...(kids === undefined ? {} : { content: kids }) };
}

/**
 * Rename legacy snake_case nodes to the names TipTap's schema declares.
 *
 * Returns the doc UNCHANGED (same object identity) when there is nothing to
 * rewrite — which is the overwhelmingly common case. That matters: callers key
 * effects and content hashes off this value, and handing back a fresh object on
 * every render is what made the note view reset its own document (f9da4f1).
 */
export function normalizeTiptapDoc<T>(doc: T): T {
  if (!hasAlias(doc)) return doc;
  return rewrite(doc) as T;
}
