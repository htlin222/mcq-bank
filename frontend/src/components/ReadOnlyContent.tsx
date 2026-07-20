import { useEditor, EditorContent } from '@tiptap/react';
import { useEffect, useMemo } from 'react';
import { buildExtensions } from '../lib/tiptap-extensions';
import { normalizeTiptapDoc } from '../lib/tiptap-doc';

export function ReadOnlyContent({ content }: { content: any }) {
  // 遺留的 snake_case 節點名稱會讓 schema 丟掉整份文件 —— 見 lib/tiptap-doc.ts。
  // useMemo 保住身分:乾淨的文件本來就會原封不動回來,需要改寫的也只算一次,
  // 否則下面那個以 doc 為依賴的 effect 會每次 render 都重設文件。
  const doc = useMemo(() => normalizeTiptapDoc(content), [content]);
  const editor = useEditor({
    extensions: buildExtensions({ readOnly: true }),
    content: doc || { type: 'doc', content: [] },
    editable: false,
    editorProps: { attributes: { class: 'tiptap' } },
  });

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(doc || { type: 'doc', content: [] }, false);
    // The table extension doesn't wrap tables in read-only render, so wrap
    // each in a scroll container — a table wider than the reading column then
    // scrolls left/right instead of overflowing the page. Read-only never
    // dispatches transactions, so ProseMirror leaves these wrappers in place.
    const root = editor.view.dom as HTMLElement;
    wrapTables(root);
    requestAnimationFrame(() => wrapTables(root));
  }, [doc, editor]);

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
