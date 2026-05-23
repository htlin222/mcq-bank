import { Node, mergeAttributes } from '@tiptap/react';

// Inline atom rendering a clickable reference to another question.
// Insertion happens via the @mention picker (mention-suggestion.ts);
// click handling is intercepted globally in App.tsx so the link uses
// react-router instead of triggering a full page reload.
export const QuestionRef = Node.create({
  name: 'questionRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-question-ref]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs.id as string;
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        class: 'qref',
        href: `/q/${id}`,
        'data-question-ref': id,
      }),
      `@${id}`,
    ];
  },

  renderText({ node }) {
    return `@${node.attrs.id}`;
  },
});
