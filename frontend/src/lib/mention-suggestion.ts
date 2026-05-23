import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import { MentionList, type MentionListRef } from '../components/MentionList';
import { api } from './api';

export type UserItem = {
  kind: 'user';
  email: string;
  display_name: string;
  avatar_key: string | null;
};

export type QuestionItem = {
  kind: 'question';
  id: string;
  year: number;
  number: number;
  stem: string;
};

export type MentionItem = UserItem | QuestionItem;

// Discriminated payload returned by MentionList when the user picks an entry.
export type MentionSelection =
  | { kind: 'user'; id: string; label: string }
  | { kind: 'question'; id: string };

// Session cache for the 20-user roster — sub-millisecond after first call.
let usersCache: UserItem[] | null = null;
async function getUsers(): Promise<UserItem[]> {
  if (usersCache) return usersCache;
  const raw = await api.get<Array<{ email: string; display_name: string; avatar_key: string | null }>>(
    '/api/users',
  );
  usersCache = raw.map((u) => ({ kind: 'user' as const, ...u }));
  return usersCache;
}

export const suggestionConfig: Omit<SuggestionOptions<MentionItem>, 'editor'> = {
  items: async ({ query }: { query: string }) => {
    // Question mode: query starts with a digit (e.g. "1", "114", "114-0")
    if (/^\d/.test(query)) {
      const rows = await api.get<Array<{ id: string; year: number; number: number; stem: string }>>(
        `/api/questions/_meta/lookup?q=${encodeURIComponent(query)}`,
      );
      return rows.map((r) => ({ kind: 'question' as const, ...r }));
    }
    // User mode (default)
    const users = await getUsers();
    const q = query.toLowerCase();
    return users
      .filter(
        (u) =>
          u.display_name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q),
      )
      .slice(0, 8);
  },

  render: () => {
    let component: ReactRenderer<MentionListRef, any>;
    let popup: TippyInstance[];

    return {
      onStart: (props) => {
        component = new ReactRenderer(MentionList, {
          props,
          editor: props.editor,
        });
        if (!props.clientRect) return;
        popup = tippy('body', {
          getReferenceClientRect: props.clientRect as any,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start',
        });
      },
      onUpdate(props) {
        component.updateProps(props);
        if (!props.clientRect) return;
        popup[0].setProps({ getReferenceClientRect: props.clientRect as any });
      },
      onKeyDown(props) {
        if (props.event.key === 'Escape') {
          popup[0].hide();
          return true;
        }
        return component.ref?.onKeyDown(props) ?? false;
      },
      onExit() {
        popup?.[0].destroy();
        component?.destroy();
      },
    };
  },
};

// Insert the right node when the user picks an item from the picker.
// Overrides @tiptap/extension-mention's default command, which would
// always insert a mention node.
export function mentionCommand({
  editor,
  range,
  props,
}: {
  editor: SuggestionProps<MentionItem>['editor'];
  range: SuggestionProps<MentionItem>['range'];
  props: MentionSelection;
}) {
  if (props.kind === 'question') {
    editor
      .chain()
      .focus()
      .insertContentAt(range, [
        { type: 'questionRef', attrs: { id: props.id } },
        { type: 'text', text: ' ' },
      ])
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: 'mention', attrs: { id: props.id, label: props.label } },
      { type: 'text', text: ' ' },
    ])
    .run();
}
