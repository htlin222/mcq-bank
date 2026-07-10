import { Fragment, useMemo, useRef, useState } from 'react';
import { CornerUpLeft, Send, X } from 'lucide-react';
import { segmentChatText } from './chatText';
import type { UserLite } from '../hooks/useUsers';

export type ReplyDraft = { id: number; name: string; snippet: string };

type Props = {
  users: UserLite[];
  myEmail: string | null;
  connected: boolean;
  reply: ReplyDraft | null;
  onCancelReply: () => void;
  onSend: (text: string, mentions: string[], mentionAll: boolean) => void;
};

export function Composer({ users, myEmail, connected, reply, onCancelReply, onSend }: Props) {
  const [text, setText] = useState('');
  const [mentionToken, setMentionToken] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const names = useMemo(() => users.map((u) => u.display_name), [users]);

  // Live highlight of recognised tokens (@名字 / @all / @114-010) behind the
  // transparent-text textarea. Spans must not alter glyph metrics — colour
  // and background only, no padding / font-weight.
  const segments = useMemo(() => segmentChatText(text, names), [text, names]);

  const candidates = useMemo(() => {
    if (mentionToken === null) return [];
    const token = mentionToken.toLowerCase();
    const list: { key: string; label: string; insert: string }[] = [];
    if ('all'.startsWith(token)) {
      list.push({ key: '@all', label: '@all — 提醒全體', insert: 'all' });
    }
    for (const u of users) {
      if (u.email === myEmail) continue;
      if (token === '' || u.display_name.toLowerCase().includes(token)) {
        list.push({ key: u.email, label: u.display_name, insert: u.display_name });
      }
    }
    return list.slice(0, 8);
  }, [mentionToken, users, myEmail]);

  function refreshToken(value: string, caret: number) {
    const m = /(^|\s)@([^\s@]{0,20})$/.exec(value.slice(0, caret));
    setMentionToken(m ? m[2] : null);
    setMentionIndex(0);
  }

  function pick(insert: string) {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,20})$/.exec(before);
    if (!m) return;
    const start = before.length - m[2].length;
    const next = `${text.slice(0, start)}${insert} ${text.slice(caret)}`;
    setText(next);
    setMentionToken(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insert.length + 1;
      el.setSelectionRange(pos, pos);
    });
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    const mentionAll = /(^|\s)@all(?=\s|$)/.test(trimmed);
    const mentions = users
      .filter((u) => u.email !== myEmail && trimmed.includes(`@${u.display_name}`))
      .map((u) => u.email);
    onSend(trimmed, mentions, mentionAll);
    setText('');
    setMentionToken(null);
    const el = inputRef.current;
    if (el) el.style.height = 'auto';
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (mentionToken !== null && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(candidates[mentionIndex].insert);
        return;
      }
      if (e.key === 'Escape') {
        setMentionToken(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function syncBackdropScroll() {
    const el = inputRef.current;
    const bd = backdropRef.current;
    if (el && bd) bd.scrollTop = el.scrollTop;
  }

  return (
    <div className="border-t border-ink-200 dark:border-ink-700 px-4 sm:px-0 pt-2 pb-3 sm:pb-5 relative">
      {reply && (
        <div className="flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400 border-l-2 border-accent pl-2 mb-1.5">
          <CornerUpLeft size={12} />
          <span className="truncate">
            回覆 <span className="font-medium">{reply.name}</span>:{reply.snippet}
          </span>
          <button
            aria-label="取消回覆"
            onClick={onCancelReply}
            className="ml-auto shrink-0 text-ink-400 hover:text-ink-600 dark:hover:text-ink-200"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {mentionToken !== null && candidates.length > 0 && (
        <div className="absolute bottom-full left-4 sm:left-0 mb-1 w-64 bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-600 rounded-lg shadow-lg py-1 z-20">
          {candidates.map((cand, i) => (
            <button
              key={cand.key}
              // onMouseDown so the pick lands before the textarea's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(cand.insert);
              }}
              onMouseEnter={() => setMentionIndex(i)}
              className={`w-full text-left px-3 py-1.5 text-sm ${
                i === mentionIndex
                  ? 'bg-ink-100 dark:bg-ink-700 text-ink-900 dark:text-ink-100'
                  : 'text-ink-700 dark:text-ink-300'
              }`}
            >
              {cand.label}
            </button>
          ))}
          {/^\d/.test(mentionToken) && (
            <div className="px-3 py-1.5 text-[11px] text-ink-400 dark:text-ink-500 border-t border-ink-100 dark:border-ink-700">
              題號直接輸入,如 @114-010 會自動變連結
            </div>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 relative rounded-lg border border-ink-200 dark:border-ink-600 bg-white dark:bg-ink-800 focus-within:border-accent transition-colors">
          {/* Highlight layer — identical metrics to the textarea */}
          <div
            ref={backdropRef}
            aria-hidden
            className="absolute inset-0 rounded-lg overflow-hidden px-3 py-2 text-sm leading-normal whitespace-pre-wrap break-words pointer-events-none text-ink-800 dark:text-ink-100"
          >
            {segments.map((seg, i) =>
              seg.kind === 'text' ? (
                <Fragment key={i}>{seg.value}</Fragment>
              ) : (
                <span key={i} className="bg-accent/15 text-accent rounded-sm">
                  {seg.value}
                </span>
              ),
            )}
            {'​'}
          </div>
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
            placeholder="傳訊息…(@人名 提及、@all 全體、@114-010 連結題目)"
            onChange={(e) => {
              setText(e.target.value);
              refreshToken(e.target.value, e.target.selectionStart ?? 0);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              syncBackdropScroll();
            }}
            onScroll={syncBackdropScroll}
            onKeyDown={onKeyDown}
            onBlur={() => window.setTimeout(() => setMentionToken(null), 150)}
            className="relative block w-full resize-none bg-transparent px-3 py-2 text-sm leading-normal whitespace-pre-wrap break-words text-transparent caret-ink-800 dark:caret-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500 focus:outline-none"
          />
        </div>
        <button
          aria-label="送出"
          onClick={handleSend}
          disabled={!connected || !text.trim()}
          className="shrink-0 w-10 h-10 grid place-items-center rounded-lg bg-accent text-white disabled:opacity-40 hover:bg-accent-dark transition"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
