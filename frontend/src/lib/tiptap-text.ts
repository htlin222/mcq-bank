// Flatten a TipTap doc JSON to plain text — used when sending content
// to /api/ai/summarize and any other downstream consumer that wants a
// readable string rather than ProseMirror nodes. Mirrors the server's
// excerpt() walker in worker/lib/db.ts.
export function tiptapToText(doc: any): string {
  if (!doc) return '';
  const parts: string[] = [];
  walk(doc, (n) => {
    if (n?.type === 'text' && typeof n.text === 'string') parts.push(n.text);
  });
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function walk(node: any, fn: (n: any) => void) {
  if (!node) return;
  fn(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) walk(child, fn);
  }
}
