import { createContext, useContext, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { ReadOnlyContent } from './ReadOnlyContent';
import { AnnotatableContent, hashContent } from './AnnotatableContent';

// When annotation is on, section bodies render through AnnotatableContent
// (select→螢光標記, click→清除, cloze). Each batch keys its localStorage by a
// hash of its own content, namespaced per note by `keyPrefix`, so highlights
// survive re-renders and stay put even as accordions open/close.
type AnnoCtx = { keyPrefix: string; cloze: boolean } | null;
const AnnotationCtx = createContext<AnnoCtx>(null);

// Read-only renderer for 個人筆記 with two view-only affordances:
//   • a paragraph that is just ---/***/___ renders as a real <hr>
//   • every heading (h1/h2/h3) becomes a collapsible accordion, folded by
//     default and NESTED by level: an h1 section holds the h2 sections under
//     it, each h2 holds its h3 sections, and so on.
// Section bodies render through ReadOnlyContent, so tables, images, links and
// highlights all keep working. Content before the first heading stays visible.

type Node = { type?: string; attrs?: any; content?: Node[]; text?: string };
type Section = { kind: 'section'; heading: Node; level: number; children: Item[] };
type Block = { kind: 'block'; node: Node };
type Item = Section | Block;

const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_LEVELS = new Set([1, 2, 3]);

// A paragraph whose only content is a horizontal-rule marker → an <hr> node.
function toHrIfMarker(node: Node): Node {
  if (node.type !== 'paragraph') return node;
  const kids = node.content ?? [];
  if (kids.length === 1 && kids[0].type === 'text' && HR_RE.test(kids[0].text ?? '')) {
    return { type: 'horizontalRule' };
  }
  return node;
}

function headingText(node: Node): string {
  return (node.content ?? [])
    .map((n) => n.text ?? '')
    .join('')
    .trim();
}

// Fold the flat block list into a heading-nested tree. A heading closes any
// open sections at its level or deeper, then opens a new one; plain blocks
// attach to the current deepest section.
function buildTree(content: Node[]): Item[] {
  const root: Section = { kind: 'section', heading: {}, level: 0, children: [] };
  const stack: Section[] = [root];
  for (const raw of content) {
    if (raw.type === 'heading' && HEADING_LEVELS.has(raw.attrs?.level)) {
      const level = raw.attrs.level as number;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const sec: Section = { kind: 'section', heading: raw, level, children: [] };
      stack[stack.length - 1].children.push(sec);
      stack.push(sec);
    } else {
      stack[stack.length - 1].children.push({ kind: 'block', node: toHrIfMarker(raw) });
    }
  }
  return root.children;
}

export function NoteContent({
  content,
  annotateKeyPrefix,
  cloze = false,
}: {
  content: any;
  /** When set, section bodies become annotatable, keyed under this prefix. */
  annotateKeyPrefix?: string;
  cloze?: boolean;
}) {
  const items = buildTree(content?.content ?? []);
  const ctx: AnnoCtx = annotateKeyPrefix
    ? { keyPrefix: annotateKeyPrefix, cloze }
    : null;
  return (
    <AnnotationCtx.Provider value={ctx}>
      <div className="tiptap-note">
        <ItemList items={items} />
      </div>
    </AnnotationCtx.Provider>
  );
}

// One batch of consecutive blocks — annotatable when a note-level context is
// present, otherwise plain read-only (used by every other NoteContent caller).
function SectionBody({ doc }: { doc: any }) {
  const anno = useContext(AnnotationCtx);
  if (!anno) return <ReadOnlyContent content={doc} />;
  return (
    <AnnotatableContent
      content={doc}
      storeKey={`${anno.keyPrefix}:${hashContent(doc)}`}
      cloze={anno.cloze}
    />
  );
}

// Render items in order: consecutive blocks batch into one ReadOnlyContent (so
// lists/paragraphs render correctly); sections render as nested accordions.
function ItemList({ items }: { items: Item[] }) {
  const out: ReactNode[] = [];
  let buf: Node[] = [];
  let key = 0;
  const flush = () => {
    if (buf.length) {
      out.push(
        <SectionBody key={`b${key++}`} doc={{ type: 'doc', content: buf }} />,
      );
      buf = [];
    }
  };
  for (const it of items) {
    if (it.kind === 'block') {
      buf.push(it.node);
    } else {
      flush();
      out.push(<NoteAccordion key={`s${key++}`} section={it} />);
    }
  }
  flush();
  return <>{out}</>;
}

// Heading size shrinks with depth so nesting reads as a hierarchy.
const TITLE_CLS: Record<number, string> = {
  1: 'text-xl',
  2: 'text-lg',
  3: 'text-base',
};

function NoteAccordion({ section }: { section: Section }) {
  const [open, setOpen] = useState(false);
  const title = headingText(section.heading);
  const hasChildren = section.children.length > 0;

  return (
    <div className="border-b border-ink-200 dark:border-ink-700 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 py-2.5 text-left group"
      >
        <ChevronRight
          size={16}
          className={
            'shrink-0 text-ink-400 dark:text-ink-500 transition-transform ' +
            (open ? 'rotate-90' : '')
          }
        />
        <span
          className={
            'font-serif text-ink-900 dark:text-ink-100 group-hover:text-accent transition-colors ' +
            (TITLE_CLS[section.level] ?? 'text-base')
          }
        >
          {title || '（無標題）'}
        </span>
      </button>
      {open && hasChildren && (
        <div className="pb-2 pl-6">
          <ItemList items={section.children} />
        </div>
      )}
    </div>
  );
}
