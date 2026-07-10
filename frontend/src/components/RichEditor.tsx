import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
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
import { transformPastedHTML } from '../lib/paste-transform';
import { looksLikeMarkdown, markdownToHtml } from '../lib/markdown-paste';
import { api } from '../lib/api';

type Props = {
  content: any;
  onChange?: (json: any) => void;
  placeholder?: string;
  editable?: boolean;
  autofocus?: boolean;
  // Rendered at the right end of the toolbar (e.g. 取消 / 儲存 actions).
  toolbarActions?: ReactNode;
};

export function RichEditor({
  content,
  onChange,
  placeholder,
  editable = true,
  autofocus = false,
  toolbarActions,
}: Props) {
  // handlePaste (defined in the useEditor config below) needs the editor to
  // insert parsed markdown, but `editor` isn't assigned yet at config time.
  // Read it through a ref that we keep pointed at the latest instance.
  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor({
    extensions: buildExtensions({ placeholder }),
    content: content || { type: 'doc', content: [] },
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
      handlePaste: (view, event) => {
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

        // Plain-text markdown (no rich HTML) → parse to real structure so
        // `- item`, `## heading`, nested lists etc. come through formatted
        // instead of as literal text.
        if (editorRef.current && !html.trim() && text && looksLikeMarkdown(text)) {
          event.preventDefault();
          editorRef.current.commands.insertContent(markdownToHtml(text));
          return true;
        }

        // HTML paste (e.g. OpenEvidence) may carry hotlinked external images
        // that won't load from our origin. Let the default paste + transform
        // run, then sideload any external <img> into R2 on the next tick.
        if (/<img[^>]+src=["']https?:\/\//i.test(html)) {
          setTimeout(() => sideloadExternalImages(view), 0);
        }
        return false;
      },
    },
  });

  const uploadAndInsert = useCallback(async (file: File) => {
    if (!editor) return;
    try {
      const { url } = await api.upload<{ url: string }>('/api/upload', file);
      editor.chain().focus().setImage({ src: url }).run();
    } catch (e) {
      alert('上傳失敗: ' + String(e));
    }
  }, [editor]);

  // Sync external content changes (e.g. after lock release / version pull)
  useEffect(() => {
    if (editor && content && !editor.isFocused) {
      const current = JSON.stringify(editor.getJSON());
      const incoming = JSON.stringify(content);
      if (current !== incoming) editor.commands.setContent(content, false);
    }
  }, [content, editor]);

  if (!editor) return null;

  return (
    <div className="border border-ink-200 dark:border-ink-700 rounded-lg bg-white dark:bg-ink-800 overflow-hidden">
      {editable && (
        <Toolbar
          editor={editor}
          onPickImage={uploadAndInsert}
          actions={toolbarActions}
        />
      )}
      <div className="p-4">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
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

// After an HTML paste, fetch every hotlinked image through the Worker (which
// stores it in R2) and rewrite the node src to the returned /img/ URL. Runs
// sequentially so one failure doesn't abort the rest; a failed image just
// keeps its broken external src.
async function sideloadExternalImages(view: import('@tiptap/pm/view').EditorView) {
  const srcs = new Set<string>();
  view.state.doc.descendants((node) => {
    if (node.type.name === 'image' && isExternalImg(node.attrs.src as string)) {
      srcs.add(node.attrs.src as string);
    }
  });
  for (const src of srcs) {
    try {
      const { url } = await api.post<{ url: string }>('/api/upload/url', { url: src });
      // Re-scan from the live state each time — positions shift as we dispatch.
      const tr = view.state.tr;
      let changed = false;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image' && node.attrs.src === src) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: url });
          changed = true;
        }
      });
      if (changed) view.dispatch(tr);
    } catch {
      /* leave the broken external image; user can delete or re-add it */
    }
  }
}

function Toolbar({
  editor,
  onPickImage,
  actions,
}: {
  editor: Editor;
  onPickImage: (f: File) => void;
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
