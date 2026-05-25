import { forwardRef, useImperativeHandle, useState, useEffect } from 'react';
import { Avatar } from './Avatar';
import type { MentionItem, MentionSelection } from '../lib/mention-suggestion';

export type MentionListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type Props = {
  items: MentionItem[];
  command: (item: MentionSelection) => void;
};

export const MentionList = forwardRef<MentionListRef, Props>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => setSelectedIndex(0), [props.items]);

  const selectItem = (idx: number) => {
    const item = props.items[idx];
    if (!item) return;
    if (item.kind === 'user') {
      props.command({ kind: 'user', id: item.email, label: item.display_name });
    } else {
      props.command({ kind: 'question', id: item.id });
    }
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length);
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex((selectedIndex + 1) % props.items.length);
        return true;
      }
      if (event.key === 'Enter') {
        selectItem(selectedIndex);
        return true;
      }
      return false;
    },
  }));

  if (props.items.length === 0) {
    return (
      <div className="mention-list">
        <div className="mention-item text-ink-400 dark:text-ink-500">沒有結果</div>
      </div>
    );
  }

  return (
    <div className="mention-list">
      {props.items.map((item, idx) => (
        <div
          key={item.kind === 'user' ? `u:${item.email}` : `q:${item.id}`}
          className={`mention-item ${idx === selectedIndex ? 'is-selected' : ''}`}
          onClick={() => selectItem(idx)}
        >
          {item.kind === 'user' ? (
            <>
              <Avatar email={item.email} avatarKey={item.avatar_key} name={item.display_name} size={24} />
              <div>
                <div className="font-medium text-ink-800 dark:text-ink-100">{item.display_name}</div>
                <div className="text-xs text-ink-500 dark:text-ink-400">{item.email}</div>
              </div>
            </>
          ) : (
            <>
              <div className="w-6 h-6 flex items-center justify-center text-[10px] font-mono bg-accent/10 text-accent rounded">
                Q
              </div>
              <div className="min-w-0">
                <div className="font-mono text-sm text-ink-800 dark:text-ink-100">{item.id}</div>
                <div className="text-xs text-ink-500 dark:text-ink-400 truncate">{item.stem}</div>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
});
MentionList.displayName = 'MentionList';
