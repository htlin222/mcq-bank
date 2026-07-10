import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { ReadOnlyContent } from './ReadOnlyContent';

// Read-only renderer for 個人筆記. Two view-only affordances the plain
// ReadOnlyContent doesn't give:
//   • a paragraph that is just `---` / `***` / `___` renders as a real <hr>
//   • each <h2> becomes a collapsible accordion (folded by default), holding
//     the blocks under it until the next <h2>
// The blocks inside each section are still rendered by ReadOnlyContent, so
// images, tables, links, highlights etc. all keep working.

type Node = { type?: string; attrs?: any; content?: Node[]; text?: string };
type Section = { heading: Node | null; blocks: Node[] };

const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

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

// Split the doc into an optional lead-in section (heading null, always shown)
// followed by one section per <h2>.
function splitByH2(content: Node[]): Section[] {
  const sections: Section[] = [];
  let cur: Section = { heading: null, blocks: [] };
  for (const raw of content) {
    const node = toHrIfMarker(raw);
    if (node.type === 'heading' && node.attrs?.level === 2) {
      if (cur.heading || cur.blocks.length) sections.push(cur);
      cur = { heading: node, blocks: [] };
    } else {
      cur.blocks.push(node);
    }
  }
  if (cur.heading || cur.blocks.length) sections.push(cur);
  return sections;
}

export function NoteContent({ content }: { content: any }) {
  const blocks: Node[] = content?.content ?? [];
  const sections = splitByH2(blocks);

  return (
    <div className="tiptap-note">
      {sections.map((sec, i) =>
        sec.heading ? (
          <NoteAccordion
            key={i}
            title={headingText(sec.heading)}
            blocks={sec.blocks}
          />
        ) : (
          sec.blocks.length > 0 && (
            <ReadOnlyContent key={i} content={{ type: 'doc', content: sec.blocks }} />
          )
        ),
      )}
    </div>
  );
}

function NoteAccordion({ title, blocks }: { title: string; blocks: Node[] }) {
  const [open, setOpen] = useState(false);
  const hasBody = blocks.length > 0;

  return (
    <div className="border-b border-ink-200 dark:border-ink-700 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 py-3 text-left group"
      >
        <ChevronRight
          size={16}
          className={
            'shrink-0 text-ink-400 dark:text-ink-500 transition-transform ' +
            (open ? 'rotate-90' : '')
          }
        />
        <span className="font-serif text-lg text-ink-900 dark:text-ink-100 group-hover:text-accent transition-colors">
          {title || '（無標題）'}
        </span>
      </button>
      {open && hasBody && (
        <div className="pb-3 pl-6">
          <ReadOnlyContent content={{ type: 'doc', content: blocks }} />
        </div>
      )}
    </div>
  );
}
