import { useState, useEffect } from 'react';
import { useMe, type Me } from '../hooks/useMe';
import { Avatar } from '../components/Avatar';
import { api } from '../lib/api';

export function Profile() {
  const { me, loading, update } = useMe();
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (me) {
      setDisplayName(me.display_name);
      setBio(me.bio ?? '');
    }
  }, [me?.email]);

  if (loading || !me) {
    return <div className="p-8 text-center text-ink-400 dark:text-ink-500">載入中…</div>;
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await update({ display_name: displayName, bio });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  async function uploadAvatar(file: File) {
    if (uploading) return;
    setUploading(true);
    try {
      const r = await api.upload<{ avatar_key: string }>('/api/me/avatar', file);
      await update({ avatar_key: r.avatar_key });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="max-w-2xl md:max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-8">個人資料</h1>

      <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper">
        <div className="flex items-center gap-5 mb-8">
          <Avatar
            email={me.email}
            avatarKey={me.avatar_key}
            name={me.display_name}
            size={72}
          />
          <div>
            <label className="inline-block bg-ink-900 hover:bg-ink-700 dark:bg-ink-700 dark:hover:bg-ink-600 text-white px-4 py-2 rounded text-sm cursor-pointer transition">
              {uploading ? '上傳中…' : '更換頭像'}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadAvatar(f);
                  e.target.value = '';
                }}
              />
            </label>
            <p className="text-xs text-ink-400 dark:text-ink-500 mt-2">最大 2 MB,自動裁切</p>
          </div>
        </div>

        <div className="space-y-5">
          <Field label="Email">
            <input
              value={me.email}
              disabled
              className="w-full px-3 py-2 border border-ink-200 dark:border-ink-600 rounded bg-ink-50 dark:bg-ink-900 text-ink-500 dark:text-ink-400"
            />
          </Field>

          <Field label="顯示名稱">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded focus:outline-none focus:border-accent text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
            />
          </Field>

          <Field label="個人簡介">
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-ink-200 dark:border-ink-600 dark:bg-ink-900 rounded focus:outline-none focus:border-accent font-serif resize-y text-ink-900 dark:text-ink-100 placeholder:text-ink-400 dark:placeholder:text-ink-500"
              placeholder="e.g. Fellow 1, 2, 3, 某某醫院"
            />
          </Field>
        </div>

        <div className="mt-6 flex items-center gap-3 justify-end">
          {savedAt && (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">
              ✓ 已儲存 ({new Date(savedAt).toLocaleTimeString('zh-TW')})
            </span>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded font-medium disabled:opacity-40"
          >
            {saving ? '儲存中…' : '儲存'}
          </button>
        </div>
      </div>

      <McqKeyCard me={me} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-ink-600 dark:text-ink-300 mb-1.5 inline-block">{label}</span>
      {children}
    </label>
  );
}

// MCQ skill key: download a personalised .skill (key baked into .env) for the
// `/mcq` Claude Code skill, or rotate the key if it leaks.
function McqKeyCard({ me }: { me: Me }) {
  const [version, setVersion] = useState(me.mcq_key_version);
  const [rotating, setRotating] = useState(false);
  const [keyInfo, setKeyInfo] = useState<{ version: number; key: string } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);

  async function reveal() {
    if (keyInfo || revealing) return;
    setRevealing(true);
    try {
      const k = await api.get<{ version: number; key: string }>('/api/me/mcq-key');
      setKeyInfo(k);
      setVersion(k.version);
    } finally {
      setRevealing(false);
    }
  }

  async function rotate() {
    if (rotating) return;
    if (!confirm('重新產生金鑰會讓你先前下載的 .skill 立即失效,需要重新下載。確定要繼續?')) return;
    setRotating(true);
    try {
      const k = await api.post<{ version: number; key: string }>('/api/me/mcq-key/rotate');
      setKeyInfo(k);
      setVersion(k.version);
    } finally {
      setRotating(false);
    }
  }

  async function copyKey() {
    if (!keyInfo) return;
    await navigator.clipboard.writeText(keyInfo.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6">
      <h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">MCQ 小測驗金鑰</h2>
      <p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed mb-1">
        下載你的專屬 <code className="font-mono text-[0.85em]">.skill</code>,裝進 Claude Code 後即可用
        <code className="font-mono text-[0.85em] mx-1">/mcq 114-001</code>
        隨堂測驗。金鑰已寫進 <code className="font-mono text-[0.85em]">.env</code>,屬於你個人,請勿外流。
      </p>
      <p className="text-xs text-ink-400 dark:text-ink-500 mb-5">
        目前金鑰版本 <span className="font-mono">v{version}</span>。
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <a
          href="/api/me/mcq-skill"
          download="mcq.skill"
          className="inline-flex items-center gap-2 bg-ink-900 hover:bg-ink-700 dark:bg-ink-700 dark:hover:bg-ink-600 text-white px-4 py-2 rounded text-sm font-medium transition"
        >
          ⬇ 下載我的 .skill
        </a>
        <button
          onClick={rotate}
          disabled={rotating}
          className="inline-flex items-center gap-2 border border-ink-300 dark:border-ink-600 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700 px-4 py-2 rounded text-sm transition disabled:opacity-40"
        >
          {rotating ? '重新產生中…' : '↻ 重新產生金鑰'}
        </button>
        {!keyInfo && (
          <button
            onClick={reveal}
            disabled={revealing}
            className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent underline underline-offset-2 disabled:opacity-40"
          >
            {revealing ? '載入中…' : '查看金鑰'}
          </button>
        )}
      </div>

      <div className="mt-5 border-t border-ink-100 dark:border-ink-700 pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-2">
          安裝步驟
        </p>
        <ol className="list-decimal list-inside space-y-1.5 text-sm text-ink-600 dark:text-ink-300 leading-relaxed">
          <li>點上方「⬇ 下載我的 .skill」,存下 <code className="font-mono text-[0.85em]">mcq.skill</code>。</li>
          <li>
            開啟{' '}
            <a
              href="https://claude.ai/customize/skills"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:text-accent-dark underline underline-offset-2 break-all"
            >
              claude.ai/customize/skills
            </a>
            。
          </li>
          <li>點「Upload skill」,選剛下載的 <code className="font-mono text-[0.85em]">mcq.skill</code>。</li>
          <li>回到 Claude 對話,輸入 <code className="font-mono text-[0.85em]">/mcq 114-001</code> 開始測驗。</li>
        </ol>
        <p className="text-xs text-ink-400 dark:text-ink-500 mt-2.5">
          也可解壓 <code className="font-mono text-[0.85em]">.skill</code> 放進 Claude Code 的
          <code className="font-mono text-[0.85em] mx-1">.claude/skills/</code>;金鑰已寫在 <code className="font-mono text-[0.85em]">.env</code> 裡。
        </p>
      </div>

      {keyInfo && (
        <div className="mt-4 flex items-center gap-2">
          <code className="flex-1 min-w-0 truncate font-mono text-xs bg-ink-50 dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded px-3 py-2 text-ink-700 dark:text-ink-200">
            {keyInfo.key}
          </code>
          <button
            onClick={copyKey}
            className="shrink-0 text-xs border border-ink-300 dark:border-ink-600 text-ink-600 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-700 px-3 py-2 rounded transition"
          >
            {copied ? '✓ 已複製' : '複製'}
          </button>
        </div>
      )}
    </div>
  );
}
