import { useEffect, useState } from 'react';
import { Sun, Moon, Contrast, Monitor } from 'lucide-react';
import { applyTheme, readTheme, writeTheme, type Theme } from '../lib/theme';

// 循環順序:三個「我要這個外觀」的選項在前,`system`(「我不選」)收尾。
// eink 緊接 dark —— 兩者都是為特定螢幕挑的,放一起比夾在 light/system 中間好找。
const ORDER: Theme[] = ['light', 'dark', 'eink', 'system'];

const LABEL: Record<Theme, string> = {
  light: '亮',
  dark: '暗',
  eink: '電子紙',
  system: '跟系統',
};

const ICON: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  eink: Contrast,
  system: Monitor,
};

export function ThemeToggle() {
  const [mode, setMode] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(mode);
    writeTheme(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  function next() {
    setMode((m) => ORDER[(ORDER.indexOf(m) + 1) % ORDER.length]);
  }

  const Icon = ICON[mode];

  return (
    <button
      onClick={next}
      className="w-9 h-9 grid place-items-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800 transition text-ink-600 dark:text-ink-300"
      title={`主題:${LABEL[mode]}`}
      aria-label={`切換主題(目前:${LABEL[mode]})`}
    >
      <Icon size={18} />
    </button>
  );
}
