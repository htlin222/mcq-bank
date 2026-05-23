import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import { suggestionConfig } from './mention-suggestion';

export function buildExtensions(opts: { placeholder?: string; readOnly?: boolean } = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
    }),
    Image.configure({ inline: false, allowBase64: false }),
    Link.configure({
      openOnClick: opts.readOnly === true,
      autolink: true,
      protocols: ['http', 'https', 'mailto'],
    }),
    Placeholder.configure({
      placeholder: opts.placeholder || '寫下你的想法…',
    }),
    Mention.configure({
      HTMLAttributes: { class: 'mention' },
      renderText: ({ node }) => `@${node.attrs.label || node.attrs.id}`,
      suggestion: suggestionConfig,
    }),
  ];
}
