import { forwardRef, useImperativeHandle, useState, useEffect } from 'react';
import { Avatar } from './Avatar';

type User = { email: string; display_name: string; avatar_key: string | null };

export type MentionListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type Props = {
  items: User[];
  command: (item: { id: string; label: string }) => void;
};

export const MentionList = forwardRef<MentionListRef, Props>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => setSelectedIndex(0), [props.items]);

  const selectItem = (idx: number) => {
    const item = props.items[idx];
    if (item) {
      props.command({ id: item.email, label: item.display_name });
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
        <div className="mention-item text-ink-400">沒有結果</div>
      </div>
    );
  }

  return (
    <div className="mention-list">
      {props.items.map((user, idx) => (
        <div
          key={user.email}
          className={`mention-item ${idx === selectedIndex ? 'is-selected' : ''}`}
          onClick={() => selectItem(idx)}
        >
          <Avatar email={user.email} avatarKey={user.avatar_key} name={user.display_name} size={24} />
          <div>
            <div className="font-medium text-ink-800">{user.display_name}</div>
            <div className="text-xs text-ink-500">{user.email}</div>
          </div>
        </div>
      ))}
    </div>
  );
});
MentionList.displayName = 'MentionList';
