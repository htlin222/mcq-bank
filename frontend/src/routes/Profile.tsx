import { useState, useEffect } from 'react';
import { useMe } from '../hooks/useMe';
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
    return <div className="p-8 text-center text-ink-400">載入中…</div>;
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
      <h1 className="font-serif text-3xl text-ink-900 mb-8">個人資料</h1>

      <div className="bg-white border border-ink-200 rounded-lg p-6 sm:p-8 shadow-paper">
        <div className="flex items-center gap-5 mb-8">
          <Avatar
            email={me.email}
            avatarKey={me.avatar_key}
            name={me.display_name}
            size={72}
          />
          <div>
            <label className="inline-block bg-ink-900 hover:bg-ink-700 text-white px-4 py-2 rounded text-sm cursor-pointer transition">
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
            <p className="text-xs text-ink-400 mt-2">最大 2 MB,自動裁切</p>
          </div>
        </div>

        <div className="space-y-5">
          <Field label="Email">
            <input
              value={me.email}
              disabled
              className="w-full px-3 py-2 border border-ink-200 rounded bg-ink-50 text-ink-500"
            />
          </Field>

          <Field label="顯示名稱">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 border border-ink-200 rounded focus:outline-none focus:border-accent"
            />
          </Field>

          <Field label="個人簡介">
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-ink-200 rounded focus:outline-none focus:border-accent font-serif resize-y"
              placeholder="e.g. Fellow 1, 2, 3, 某某醫院"
            />
          </Field>
        </div>

        <div className="mt-6 flex items-center gap-3 justify-end">
          {savedAt && (
            <span className="text-xs text-emerald-700">
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
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-ink-600 mb-1.5 inline-block">{label}</span>
      {children}
    </label>
  );
}
