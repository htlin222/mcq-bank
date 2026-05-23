import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';

type Mode = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'hema-2026:theme';

function apply(mode: Mode) {
  const wantsDark =
    mode === 'dark' ||
    (mode === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', wantsDark);
}

function read(): Mode {
  const stored = localStorage.getItem(STORAGE_KEY) as Mode | null;
  return stored === 'light' || stored === 'dark' || stored === 'system'
    ? stored
    : 'system';
}

// Apply the saved theme immediately on first import so there's no flash.
if (typeof window !== 'undefined') apply(read());

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(read);

  useEffect(() => {
    apply(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  function next() {
    setMode((m) => (m === 'light' ? 'dark' : m === 'dark' ? 'system' : 'light'));
  }

  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;

  return (
    <button
      onClick={next}
      className="w-9 h-9 grid place-items-center rounded-full hover:bg-ink-100 dark:hover:bg-ink-800 transition text-ink-600 dark:text-ink-300"
      title={`主題:${mode === 'light' ? '亮' : mode === 'dark' ? '暗' : '跟系統'}`}
      aria-label="切換主題"
    >
      <Icon size={18} />
    </button>
  );
}
