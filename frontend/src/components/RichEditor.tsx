import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { useCallback, useEffect, type ReactNode } from 'react';
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
  Image as ImageIcon,
  StickyNoteX,
  Undo2,
  Redo2,
} from 'lucide-react';
import { buildExtensions } from '../lib/tiptap-extensions';
import { api } from '../lib/api';

type Props = {
  content: any;
  onChange?: (json: any) => void;
  placeholder?: string;
  editable?: boolean;
  autofocus?: boolean;
};

export function RichEditor({ content, onChange, placeholder, editable = true, autofocus = false }: Props) {
  const editor = useEditor({
    extensions: buildExtensions({ placeholder }),
    content: content || { type: 'doc', content: [] },
    editable,
    autofocus: autofocus ? 'end' : false,
    onUpdate: ({ editor }) => onChange?.(editor.getJSON()),
    editorProps: {
      attributes: { class: 'tiptap' },
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
      {editable && <Toolbar editor={editor} onPickImage={uploadAndInsert} />}
      <div className="p-4">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor, onPickImage }: { editor: Editor; onPickImage: (f: File) => void }) {
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
