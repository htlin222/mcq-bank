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
    if (!editor) return;
    editor.commands.setContent(content || { type: 'doc', content: [] }, false);
    // The table extension doesn't wrap tables in read-only render, so wrap
    // each in a scroll container — a table wider than the reading column then
    // scrolls left/right instead of overflowing the page. Read-only never
    // dispatches transactions, so ProseMirror leaves these wrappers in place.
    const root = editor.view.dom as HTMLElement;
    wrapTables(root);
    requestAnimationFrame(() => wrapTables(root));
  }, [content, editor]);

  if (!editor) return null;
  return <EditorContent editor={editor} />;
}

function wrapTables(root: HTMLElement) {
  root.querySelectorAll('table').forEach((table) => {
    const parent = table.parentElement;
    if (!parent || parent.classList.contains('table-scroll')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    parent.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}
