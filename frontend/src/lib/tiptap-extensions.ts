import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import { suggestionConfig, mentionCommand } from './mention-suggestion';
import { QuestionRef } from './question-ref';

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
      // Cast: @tiptap/extension-mention's suggestion typing forces
      // MentionNodeAttrs as the props shape, but our command accepts a
      // wider MentionSelection union so we can also insert questionRef.
      suggestion: {
        ...suggestionConfig,
        command: mentionCommand,
      } as any,
    }),
    QuestionRef,
  ];
}
