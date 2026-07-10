import { Fragment } from 'react';
import { Link } from 'react-router-dom';

// Chat text is plain text with three kinds of inline tokens:
//   @114-010  → question link (also @114-10, padded to 3 digits)
//   @all      → everyone highlight
//   @<name>   → member mention (validated against the roster names)

export type ChatSeg =
  | { kind: 'text'; value: string }
  | { kind: 'all'; value: string }
  | { kind: 'qref'; value: string; qid: string }
  | { kind: 'mention'; value: string };

const QREF_RE = /^@(\d{3})-(\d{1,3})$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function segmentChatText(text: string, names: string[]): ChatSeg[] {
  // Longest name first so "王小明" wins over "王小".
  const nameAlt = [...new Set(names)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((n) => `@${escapeRe(n)}`)
    .join('|');
  const re = new RegExp(
    `(@all(?![\\w])|@\\d{3}-\\d{1,3}(?!\\d)${nameAlt ? `|${nameAlt}` : ''})`,
    'g',
  );
  return text
    .split(re)
    .filter((part) => part !== '' && part !== undefined)
    .map((part): ChatSeg => {
      if (part === '@all') return { kind: 'all', value: part };
      const q = QREF_RE.exec(part);
      if (q) {
        return { kind: 'qref', value: part, qid: `${q[1]}-${q[2].padStart(3, '0')}` };
      }
      if (part.startsWith('@') && names.includes(part.slice(1))) {
        return { kind: 'mention', value: part };
      }
      return { kind: 'text', value: part };
    });
}

/**
 * Render chat text with highlighted tokens. `inverted` is for text sitting
 * on the accent bubble (own messages) where accent-on-accent would vanish.
 */
export function renderChatText(text: string, names: string[], inverted = false) {
  const linkCls = inverted
    ? 'underline font-medium text-white hover:text-white/80'
    : 'text-accent hover:text-accent-dark font-medium';
  const tagCls = inverted
    ? 'bg-white/25 text-white rounded px-1 font-medium'
    : 'bg-accent/10 text-accent rounded px-1 font-medium';

  return segmentChatText(text, names).map((seg, i) => {
    switch (seg.kind) {
      case 'qref':
        return (
          <Link key={i} to={`/q/${seg.qid}`} className={linkCls}>
            {seg.value}
          </Link>
        );
      case 'all':
      case 'mention':
        return (
          <span key={i} className={tagCls}>
            {seg.value}
          </span>
        );
      default:
        return <Fragment key={i}>{seg.value}</Fragment>;
    }
  });
}

export function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-TW', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
