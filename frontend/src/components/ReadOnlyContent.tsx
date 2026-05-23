import { useEditor, EditorContent } from '@tiptap/react';
import { useEffect } from 'react';
import { buildExtensions } from '../lib/tiptap-extensions';

export function ReadOnlyContent({ content }: { content: any }) {
  const editor = useEditor({
    extensions: buildExtensions({ readOnly: true }),
    content: content || { type: 'doc', content: [] },
    editable: false,
    editorProps: { attributes: { class: 'tiptap' } },
  });

  useEffect(() => {
    if (editor && content) editor.commands.setContent(content, false);
  }, [content, editor]);

  if (!editor) return null;
  return <EditorContent editor={editor} />;
}
