import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code2,
  Highlighter,
  Image as ImageIcon,
  StickyNoteX,
  Undo2,
  Redo2,
} from 'lucide-react';
import { buildExtensions } from '../lib/tiptap-extensions';
import { normalizeTiptapDoc } from '../lib/tiptap-doc';
import { transformPastedHTML } from '../lib/paste-transform';
import {
  looksLikeMarkdown,
  looksLikeAuthoredMarkdown,
  markdownToHtml,
} from '../lib/markdown-paste';
import { sanitizeImportedDoc } from '../lib/sanitize-import';
import { api } from '../lib/api';
import { OeImportDialog } from './OeImportDialog';
import { withQuestionHeading, type OeTurn } from '../lib/oe-import';
import {
  UploadSpinner,
  showUploadSpinner,
  hideUploadSpinner,
} from '../lib/tiptap-upload-spinner';

type Props = {
  content: any;
  onChange?: (json: any) => void;
  placeholder?: string;
  editable?: boolean;
  autofocus?: boolean;
  // Rendered at the right end of the toolbar (e.g. 取消 / 儲存 actions).
  toolbarActions?: ReactNode;
  // 收下「OpenEvidence 一則回答一則獨立筆記」的結果:每則已經是一份可以直接
  // 存起來的 TipTap 文件(圖片已 sideload 到 R2、已淨化、第一行是該則的提問)。
  // 只有支援多則筆記的呼叫端會傳(個人筆記面板);沒傳時匯入對話框連那個切換
  // 都不會出現。
  onImportAsNotes?: (docs: any[]) => Promise<void>;
};

export function RichEditor({
  content,
  onChange,
  placeholder,
  editable = true,
  autofocus = false,
  toolbarActions,
  onImportAsNotes,
}: Props) {
  // 遺留的 snake_case 節點名稱在 schema 裡不存在,會讓整份文件被丟掉
  // (見 lib/tiptap-doc.ts)。在編輯端也正規化,順帶讓下一次儲存把資料寫回
  // camelCase。useMemo 保住身分,下面的同步 effect 才不會每次 render 都跑。
  const doc = useMemo(() => normalizeTiptapDoc(content), [content]);
  // handlePaste (defined in the useEditor config below) needs the editor to
  // insert parsed markdown, but `editor` isn't assigned yet at config time.
  // Read it through a ref that we keep pointed at the latest instance.
  const editorRef = useRef<Editor | null>(null);
  // 上傳中的圖片有幾件在跑。轉圈是畫在游標上的 widget decoration
  // (lib/tiptap-upload-spinner.ts),不是頂端那條進度條 —— 使用者的視線在
  // 游標上,而圖片也正要落在那裡。
  //
  // 之所以要數而不是用一個 boolean:貼一張圖的同時拖進另一張,先回來的那件
  // 會把轉圈收掉,剩下那件就變成「什麼都沒發生」的等待。
  const pending = useRef(0);
  const busy = useMemo(
    () => ({
      begin: () => {
        pending.current += 1;
        showUploadSpinner(editorRef.current);
      },
      end: () => {
        pending.current = Math.max(0, pending.current - 1);
        if (pending.current === 0) hideUploadSpinner(editorRef.current);
      },
    }),
    [],
  );
  // OpenEvidence link-import dialog.
  const [oeOpen, setOeOpen] = useState(false);
  const editor = useEditor({
    // UploadSpinner 只掛在這個編輯器上 —— 唯讀的那些沒有貼上、也沒有上傳。
    extensions: [...buildExtensions({ placeholder }), UploadSpinner],
    content: doc || { type: 'doc', content: [] },
    editable,
    autofocus: autofocus ? 'end' : false,
    onCreate: ({ editor }) => { editorRef.current = editor; },
    onUpdate: ({ editor }) => onChange?.(editor.getJSON()),
    editorProps: {
      attributes: { class: 'tiptap' },
      // Rebuild OpenEvidence's flat <br>-separated HTML into real paragraphs
      // (and keep the table image) before ProseMirror parses the paste.
      transformPastedHTML,
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false;
        const files = event.dataTransfer?.files;
        if (files?.length) {
          const img = [...files].find((f) => f.type.startsWith('image/'));
          if (img) {
            event.preventDefault();
            uploadAndInsert(img);
            return true;
          }
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = event.clipboardData?.files;
        if (files?.length) {
          const img = [...files].find((f) => f.type.startsWith('image/'));
          if (img) {
            event.preventDefault();
            uploadAndInsert(img);
            return true;
          }
        }
        const html = event.clipboardData?.getData('text/html') || '';
        const text = event.clipboardData?.getData('text/plain') || '';

        // Prefer parsing the plain-text markdown when it's genuinely markdown —
        // always when there's no rich HTML, and also when the text was authored
        // as markdown (headings/bold/tables) even if a rich flavour tags along.
        // OpenEvidence's "Copy" is the motivating case: its text/plain is clean
        // markdown, but its text/html is a flat <br>-stream that collapses whole
        // sections (nested lists, sub-bullets) into a single mangled list. The
        // markdown round-trips into real, correctly-nested structure. Ordinary
        // rich pastes (Google Docs, Word) lack these markers, so their HTML wins.
        if (
          editorRef.current &&
          text &&
          looksLikeMarkdown(text) &&
          (!html.trim() || looksLikeAuthoredMarkdown(text))
        ) {
          event.preventDefault();
          const mdHtml = markdownToHtml(text);
          // Markdown may reference hotlinked images (![](https://…)) — sideload
          // them to R2 first, same as an HTML paste, so they don't break.
          if (/<img[^>]+src=["']https?:\/\//i.test(mdHtml)) {
            insertExternalHtml(editorRef.current, mdHtml, busy);
          } else {
            insertSanitized(editorRef.current, mdHtml);
          }
          return true;
        }

        // HTML paste (e.g. OpenEvidence) may carry hotlinked external images
        // that won't load from our origin. Upload them to R2 FIRST (concurrently,
        // showing a progress bar), then insert the corrected HTML — so there's no
        // broken-image window and no risk of saving before the swap completes.
        if (editorRef.current && /<img[^>]+src=["']https?:\/\//i.test(html)) {
          event.preventDefault();
          insertExternalHtml(editorRef.current, html, busy);
          return true;
        }
        return false;
      },
    },
  });

  const uploadAndInsert = useCallback(async (file: File) => {
    if (!editor) return;
    // R2 uploads have no offline queue — fail loudly and early rather than
    // dropping a broken image node into someone's draft.
    if (!navigator.onLine) {
      alert('離線中,無法上傳圖片。連線後再試一次。');
      return;
    }
    busy.begin();
    try {
      const { url } = await api.upload<{ url: string }>('/api/upload', file);
      editor.chain().focus().setImage({ src: url }).run();
    } catch (e) {
      alert('上傳失敗: ' + String(e));
    } finally {
      // 收轉圈與插圖之間沒有 paint(同一個 microtask 排空前都不會重繪),
      // 所以不會閃出「圖片旁邊還掛著一顆轉圈」的那一格。
      busy.end();
    }
  }, [editor, busy]);

  // Insert HTML from an OpenEvidence link import (same pipeline as a paste).
  const insertOeHtml = useCallback(
    (html: string) => insertExternalHtml(editorRef.current, html, busy),
    [busy],
  );

  // 同一份 HTML,但不插進這個編輯器 —— 每則轉成一份完整文件交給呼叫端去開新
  // 筆記。走的仍是 sideload → transform → sanitize 這條路,所以和貼上、和合併
  // 匯入的結果逐字相同;差別只在最後是 insertContent 還是回傳。
  const importOeAsNotes = useCallback(
    async (turns: OeTurn[]) => {
      const ed = editorRef.current;
      if (!ed || !onImportAsNotes) return;
      // 這條路不往這個編輯器插任何東西(每則各自開一則新筆記),所以**不**放
      // 游標轉圈 —— 游標處不會有東西落下,那顆轉圈只會讓人等錯地方。等待狀態
      // 由 OeImportDialog 自己的「匯入中…」負責。
      const docs: any[] = [];
      for (const turn of turns) {
        const fixed = await sideloadImagesInHtml(turn.answerHtml);
        docs.push(withQuestionHeading(importedHtmlToDoc(ed, fixed), turn.question));
      }
      await onImportAsNotes(docs);
    },
    [onImportAsNotes],
  );

  // Sync external content changes (e.g. after lock release / version pull)
  useEffect(() => {
    if (editor && doc && !editor.isFocused) {
      const current = JSON.stringify(editor.getJSON());
      const incoming = JSON.stringify(doc);
      if (current !== incoming) editor.commands.setContent(doc, false);
    }
  }, [doc, editor]);

  if (!editor) return null;

  return (
    <div
      className={
        'border border-ink-200 dark:border-ink-700 rounded-lg bg-white dark:bg-ink-800 overflow-hidden' +
        // Editable: bound the height and let the text area scroll on its own so
        // the toolbar (shrink-0, first flex child) stays pinned at the top.
        // Read-only renders keep their natural height — never height-capped.
        (editable ? ' flex flex-col max-h-[65vh]' : '')
      }
    >
      {editable && (
        <Toolbar
          editor={editor}
          onPickImage={uploadAndInsert}
          onImportOe={() => setOeOpen(true)}
          actions={toolbarActions}
        />
      )}
      {oeOpen && (
        <OeImportDialog
          onClose={() => setOeOpen(false)}
          onInsert={insertOeHtml}
          onInsertSeparate={onImportAsNotes ? importOeAsNotes : undefined}
        />
      )}
      <div className={'p-4' + (editable ? ' flex-1 min-h-0 overflow-y-auto overscroll-contain' : '')}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

// Insert externally-sourced HTML (a paste or an OpenEvidence link import):
// sideload its hotlinked images to R2 first (游標上轉圈), then rebuild
// OE's flat markup and insert. Shared so both entry points behave identically.
function insertExternalHtml(
  editor: Editor | null,
  html: string,
  busy: UploadBusy,
): Promise<void> {
  if (!editor) return Promise.resolve();
  busy.begin();
  return sideloadImagesInHtml(html)
    .then((fixed) => {
      insertSanitized(editor, fixed);
    })
    .finally(() => busy.end());
}

type UploadBusy = { begin: () => void; end: () => void };

// The single choke point for externally-sourced content: rebuild OE's flat
// markup, parse it to a doc with the editor's own schema, purge machine
// residue. Going through explicit JSON (rather than handing HTML to
// insertContent) is what makes the sanitize step possible at all — TipTap
// otherwise parses internally and there's nothing to intercept.
//
// Only imports pass through here. Content the user types is never sanitized.
function importedHtmlToDoc(editor: Editor, html: string): { content?: any[] } {
  const dom = new window.DOMParser().parseFromString(
    transformPastedHTML(html),
    'text/html',
  );
  const parsed = PMDOMParser.fromSchema(editor.schema).parse(dom.body).toJSON();
  return sanitizeImportedDoc(parsed);
}

function insertSanitized(editor: Editor, html: string): void {
  const content = importedHtmlToDoc(editor, html).content;
  if (content?.length) editor.commands.insertContent(content);
}

// An image src that our /img/ proxy doesn't serve — an absolute URL on
// another origin (hotlinked). Same-origin and relative /img/ srcs are ours.
function isExternalImg(src: string): boolean {
  if (!/^https?:\/\//i.test(src)) return false;
  try {
    return new URL(src).origin !== window.location.origin;
  } catch {
    return false;
  }
}

// Before inserting pasted HTML, fetch every hotlinked image through the Worker
// (which stores it in R2) and rewrite its src to the returned /img/ URL. Runs
// concurrently; a failed image keeps its external src rather than aborting the
// rest. Returns the corrected HTML so the inserted content is already
// same-origin — no broken-image window and nothing to race a save against.
async function sideloadImagesInHtml(html: string): Promise<string> {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const imgs = Array.from(tpl.content.querySelectorAll('img')).filter((im) =>
    isExternalImg(im.getAttribute('src') || ''),
  );
  await Promise.all(
    imgs.map(async (im) => {
      const src = im.getAttribute('src');
      if (!src) return;
      try {
        const { url } = await api.post<{ url: string }>('/api/upload/url', { url: src });
        im.setAttribute('src', url);
      } catch {
        /* leave the external src; the user can delete or re-add it */
      }
    }),
  );
  return tpl.innerHTML;
}

function Toolbar({
  editor,
  onPickImage,
  onImportOe,
  actions,
}: {
  editor: Editor;
  onPickImage: (f: File) => void;
  onImportOe: () => void;
  actions?: ReactNode;
}) {
  const fileInput = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) onPickImage(f);
    };
    input.click();
  }, [onPickImage]);

  return (
    <div className="editor-toolbar">
      <IconBtn
        label="粗體"
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
      >
        <Bold size={15} />
      </IconBtn>
      <IconBtn
        label="斜體"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
      >
        <Italic size={15} />
      </IconBtn>
      <IconBtn
        label="螢光標記"
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        active={editor.isActive('highlight')}
      >
        <Highlighter size={15} />
      </IconBtn>
      <IconBtn
        label="刪除線"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
      >
        <Strikethrough size={15} />
      </IconBtn>
      <Divider />
      <IconBtn
        label="標題 1"
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive('heading', { level: 1 })}
      >
        <Heading1 size={16} />
      </IconBtn>
      <IconBtn
        label="標題 2"
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive('heading', { level: 2 })}
      >
        <Heading2 size={16} />
      </IconBtn>
      <IconBtn
        label="標題 3"
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive('heading', { level: 3 })}
      >
        <Heading3 size={16} />
      </IconBtn>
      <Divider />
      <IconBtn
        label="項目符號"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive('bulletList')}
      >
        <List size={16} />
      </IconBtn>
      <IconBtn
        label="編號清單"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive('orderedList')}
      >
        <ListOrdered size={16} />
      </IconBtn>
      <IconBtn
        label="引言"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive('blockquote')}
      >
        <Quote size={15} />
      </IconBtn>
      <IconBtn
        label="程式碼區塊"
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive('codeBlock')}
      >
        <Code2 size={15} />
      </IconBtn>
      <Divider />
      <IconBtn label="插入圖片" onClick={fileInput}>
        <ImageIcon size={15} />
      </IconBtn>
      <IconBtn label="匯入 OpenEvidence 連結" onClick={onImportOe}>
        <span className="inline-flex items-center justify-center w-[15px] h-[15px] rounded-full border-[1.5px] border-current text-[10px] font-bold leading-none">
          O
        </span>
      </IconBtn>
      <IconBtn label="清除引用標記" onClick={() => clearCitationMarks(editor)}>
        <StickyNoteX size={15} />
      </IconBtn>
      <span className="flex-1" />
      <IconBtn
        label="復原"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
      >
        <Undo2 size={15} />
      </IconBtn>
      <IconBtn
        label="重做"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
      >
        <Redo2 size={15} />
      </IconBtn>
      {actions && (
        <>
          <Divider />
          <div className="flex items-center gap-2">{actions}</div>
        </>
      )}
    </div>
  );
}

// Strip journal citation marks pasted alongside text — [1], [12], [1-2],
// [1,3], [1–3] and immediate runs like [1][2] — from every text node in one
// undoable transaction, along with any whitespace directly before them.
// Digits-only inside the brackets, so prose like "[註]" or option labels
// are untouched.
const CITATION_RE = /[ \t ]*\[\d+(?:\s*[-–,]\s*\d+)*\]/g;

function clearCitationMarks(editor: Editor) {
  const { state } = editor;
  const ranges: { from: number; to: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    CITATION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITATION_RE.exec(node.text))) {
      ranges.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    }
  });
  if (ranges.length === 0) return;
  const tr = state.tr;
  // Delete back-to-front so earlier ranges keep their positions.
  for (const r of ranges.reverse()) tr.delete(r.from, r.to);
  editor.view.dispatch(tr);
  editor.commands.focus();
}

function IconBtn({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={
        'inline-flex items-center justify-center w-8 h-8 rounded transition ' +
        (disabled
          ? 'text-ink-300 dark:text-ink-600 cursor-not-allowed'
          : active
          ? 'bg-ink-200 dark:bg-ink-700 text-ink-900 dark:text-ink-100'
          : 'text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-700 hover:text-ink-900 dark:hover:text-ink-100')
      }
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="w-px h-5 bg-ink-200 dark:bg-ink-700 mx-1 self-center" aria-hidden="true" />;
}
