import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { useCallback, useEffect } from 'react';
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
    <div className="border border-ink-200 rounded-lg bg-white overflow-hidden">
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

  const btn = (label: string, action: () => void, isActive?: () => boolean) => (
    <button
      type="button"
      onClick={action}
      className={isActive?.() ? 'is-active' : ''}
      title={label}
    >
      {label}
    </button>
  );

  return (
    <div className="editor-toolbar">
      {btn('B', () => editor.chain().focus().toggleBold().run(), () => editor.isActive('bold'))}
      {btn('I', () => editor.chain().focus().toggleItalic().run(), () => editor.isActive('italic'))}
      {btn('S', () => editor.chain().focus().toggleStrike().run(), () => editor.isActive('strike'))}
      <span className="w-px bg-ink-200 mx-1" />
      {btn('H1', () => editor.chain().focus().toggleHeading({ level: 1 }).run(), () => editor.isActive('heading', { level: 1 }))}
      {btn('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), () => editor.isActive('heading', { level: 2 }))}
      {btn('H3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), () => editor.isActive('heading', { level: 3 }))}
      <span className="w-px bg-ink-200 mx-1" />
      {btn('•', () => editor.chain().focus().toggleBulletList().run(), () => editor.isActive('bulletList'))}
      {btn('1.', () => editor.chain().focus().toggleOrderedList().run(), () => editor.isActive('orderedList'))}
      {btn('"', () => editor.chain().focus().toggleBlockquote().run(), () => editor.isActive('blockquote'))}
      {btn('</>', () => editor.chain().focus().toggleCodeBlock().run(), () => editor.isActive('codeBlock'))}
      <span className="w-px bg-ink-200 mx-1" />
      {btn('🖼', fileInput)}
      <span className="flex-1" />
      {btn('↶', () => editor.chain().focus().undo().run())}
      {btn('↷', () => editor.chain().focus().redo().run())}
    </div>
  );
}
