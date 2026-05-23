import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { MentionList, type MentionListRef } from '../components/MentionList';
import { api } from './api';

type User = { email: string; display_name: string; avatar_key: string | null };

// Cache users for the session (refresh on focus is fine for 20-user app)
let usersCache: User[] | null = null;
async function getUsers(): Promise<User[]> {
  if (usersCache) return usersCache;
  usersCache = await api.get<User[]>('/api/users');
  return usersCache;
}

export const suggestionConfig: Omit<SuggestionOptions<User>, 'editor'> = {
  items: async ({ query }: { query: string }) => {
    const users = await getUsers();
    const q = query.toLowerCase();
    return users
      .filter(
        (u) =>
          u.display_name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q)
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
