import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { LogOut, RefreshCw, Send } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useMe, type Me } from '../hooks/useMe';
import { Avatar } from '../components/Avatar';
import { AiKeyCard } from '../components/profile/AiKeyCard';
import { AttemptLogCard } from '../components/profile/AttemptLogCard';
import { BackupCard } from '../components/profile/BackupCard';
import { ProfileToc, type TocItem } from '../components/profile/ProfileToc';
import { api } from '../lib/api';
import { invalidateTgStatus, tgStatus, type TgStatus } from '../lib/telegramApi';
import { signOut, reloadFresh } from '../lib/signOut';

// 側欄導覽的項目。id 對應各卡片外層的 id + scroll-mt-[calc(var(--header-h)+1.5rem)];順序就是頁面順序,
// 兩邊要一起改。AiKeyCard 的 id 在它自己的檔案裡。
const SECTIONS: TocItem[] = [
  { id: 'profile-basic', label: '基本資料' },
  { id: 'profile-attempts', label: '答題狀態分析' },
  { id: 'profile-backup', label: '備份我的紀錄' },
  { id: 'profile-telegram', label: 'Telegram 推播' },
  { id: 'profile-ai', label: 'AI 助手' },
  { id: 'profile-mcq', label: 'MCQ 金鑰' },
  { id: 'profile-account', label: '帳號' },
];

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
    // lg 以上讓出左欄給 TOC,所以容器要比原本的 max-w-3xl 寬;lg 以下維持
    // 原本的單欄閱讀寬度不變。
    <div className="max-w-2xl md:max-w-3xl lg:max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="font-serif text-3xl text-ink-900 dark:text-ink-100 mb-8">個人資料</h1>

      <div className="lg:flex lg:items-start lg:gap-10">
        <ProfileToc items={SECTIONS} />

        <div className="min-w-0 flex-1">
          <div id="profile-basic" className="scroll-mt-[calc(var(--header-h)+1.5rem)] bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper">
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

          <AttemptLogCard />
          <BackupCard />
          <TelegramCard />
          <AiKeyCard />
          <McqKeyCard me={me} />
          <AccountCard email={me.email} />
        </div>
      </div>
    </div>
  );
}

// 帳號區:登出,以及「只清快取不登出」。後者是給那個典型症狀用的 —— 一般視窗
// 顯示壞掉、無痕視窗正常,代表卡住的是這台裝置的 Service Worker 快取,不是帳號。
function AccountCard({ email }: { email: string }) {
  const [busy, setBusy] = useState<null | 'cache' | 'signout'>(null);

  return (
    <div id="profile-account" className="scroll-mt-[calc(var(--header-h)+1.5rem)] bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6">
      <h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">帳號</h2>
      <p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed mb-5">
        目前登入身分 <span className="font-mono text-[0.9em]">{email}</span>。
        登入由 Cloudflare Access 管理,登出後要再用 Email 收驗證碼才能回來。
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={async () => {
            setBusy('signout');
            await signOut();
          }}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 bg-ink-900 hover:bg-ink-700 dark:bg-ink-700 dark:hover:bg-ink-600 text-white px-4 py-2 rounded text-sm font-medium transition disabled:opacity-40"
        >
          <LogOut size={15} /> {busy === 'signout' ? '登出中…' : '登出'}
        </button>
        <button
          onClick={async () => {
            setBusy('cache');
            await reloadFresh();
          }}
          disabled={busy !== null}
          title="註銷 Service Worker、倒掉離線快取後重新載入。不會登出,也不會動到你的畫記或筆記。"
          className="inline-flex items-center gap-2 border border-ink-300 dark:border-ink-600 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700 px-4 py-2 rounded text-sm transition disabled:opacity-40"
        >
          <RefreshCw size={15} /> {busy === 'cache' ? '清除中…' : '清除本機快取並重新載入'}
        </button>
      </div>

      <p className="text-xs text-ink-400 dark:text-ink-500 mt-3 leading-relaxed">
        頁面顯示不正常、但無痕視窗開起來正常 —— 那是這台裝置的離線快取卡住了,
        按「清除本機快取並重新載入」即可,不必登出。
        登出則會一併清掉本機快取與偏好設定;畫記與筆記存在伺服器上,不受影響。
      </p>
    </div>
  );
}

// Telegram 出題機器人綁定。產生一次性 deep link,使用者在 Telegram 開啟即可
// 把該裝置的 chat 綁到目前登入的 email;之後每日推題與作答都計入同一份進度。
// 狀態型別與快取在 lib/telegramApi.ts —— 選字工具列的「存到 Telegram」共用同
// 一份,所以這裡綁定/解綁後要記得作廢快取。
function TelegramCard() {
  const [status, setStatus] = useState<TgStatus | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    tgStatus().then(setStatus);
  }, []);

  // 綁定的最後一步發生在 Telegram 裡(按 START),app 這頭收不到通知 —— 產生
  // 連結後就開始輪詢,卡片才會自己翻成「已綁定」,選字工具列的按鈕也才會在
  // 不重整的情況下出現。
  useEffect(() => {
    if (!link || status?.linked) return;
    const t = window.setInterval(async () => {
      const s = await tgStatus(true);
      if (s) setStatus(s);
    }, 3000);
    return () => window.clearInterval(t);
  }, [link, status?.linked]);

  // bot 未設定(無 token / username)時整張卡片不顯示。
  if (!status || !status.configured) return null;

  async function genLink() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ deep_link: string }>('/api/telegram/link-code');
      setLink(r.deep_link);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (busy) return;
    if (!confirm('解除綁定後,這個 Telegram 帳號將停止收到每日推題。確定?')) return;
    setBusy(true);
    try {
      await api.post('/api/telegram/unlink');
      setStatus((s) => (s ? { ...s, linked: false, subscribed: false } : s));
      invalidateTgStatus();
      setLink(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="profile-telegram" className="scroll-mt-[calc(var(--header-h)+1.5rem)] bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6">
      <h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">Telegram 推播</h2>
      <p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed mb-5">
        綁定 Telegram 後,機器人會在你設定的時段每天推一題(優先複習到期題),
        也能用 <code className="font-mono text-[0.85em]">/quiz</code> 挑年份做小測驗。
        在聊天裡的作答會計入你在這裡的複習進度。
      </p>

      {status.linked ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-ink-700 dark:text-ink-200">
            <Send size={15} className="text-accent" />
            已綁定{status.username ? ` · @${status.username}` : ''}
            <span className="text-ink-400 dark:text-ink-500">
              (每日推播{status.subscribed ? '開' : '關'})
            </span>
          </span>
          <button
            onClick={unlink}
            disabled={busy}
            className="inline-flex items-center gap-2 border border-ink-300 dark:border-ink-600 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-700 px-4 py-2 rounded text-sm transition disabled:opacity-40"
          >
            解除綁定
          </button>
        </div>
      ) : link ? (
        <div className="flex flex-col sm:flex-row sm:items-center gap-5">
          {/* QR:桌機用手機 Telegram 掃碼綁定;白底 + 內距確保暗色模式也掃得到 */}
          <div className="shrink-0 self-start bg-white p-3 rounded-lg border border-ink-200">
            <QRCodeSVG value={link} size={148} level="M" />
          </div>
          <div className="flex flex-col gap-3">
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 bg-accent hover:bg-accent-dark text-white px-5 py-2 rounded text-sm font-medium transition self-start"
            >
              <Send size={15} /> 在 Telegram 開啟以完成綁定
            </a>
            <p className="text-xs text-ink-500 dark:text-ink-400 leading-relaxed">
              <b>手機</b>:直接按上面按鈕。<br />
              <b>電腦</b>:用手機的 Telegram 掃左邊 QR。<br />
              開啟後在機器人對話按「START」即完成綁定。
            </p>
            <p className="text-xs text-ink-400 dark:text-ink-500 leading-relaxed">
              連結 15 分鐘內有效、僅能使用一次。沒反應就回來重新產生。
            </p>
          </div>
        </div>
      ) : (
        <button
          onClick={genLink}
          disabled={busy}
          className="inline-flex items-center gap-2 bg-ink-900 hover:bg-ink-700 dark:bg-ink-700 dark:hover:bg-ink-600 text-white px-4 py-2 rounded text-sm font-medium transition disabled:opacity-40"
        >
          <Send size={15} /> {busy ? '產生中…' : '產生綁定連結'}
        </button>
      )}
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
  // 冪等:同一次 rotate 動作沿用同一個 key,避免網路重試把 version 多推一版。
  const rotateIdemKey = useRef<string | null>(null);
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
    if (!rotateIdemKey.current) rotateIdemKey.current = crypto.randomUUID();
    try {
      const k = await api.post<{ version: number; key: string }>(
        '/api/me/mcq-key/rotate',
        undefined,
        rotateIdemKey.current,
      );
      setKeyInfo(k);
      setVersion(k.version);
      rotateIdemKey.current = null;
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
    <div id="profile-mcq" className="scroll-mt-[calc(var(--header-h)+1.5rem)] bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-6 sm:p-8 shadow-paper mt-6">
      <h2 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-2">MCQ 小測驗金鑰</h2>
      <p className="text-sm text-ink-600 dark:text-ink-300 leading-relaxed mb-1">
        下載你的專屬 <code className="font-mono text-[0.85em]">.skill</code>,上傳到 Claude 或 ChatGPT 後即可用
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
            開啟技能上傳頁 — Claude:{' '}
            <a
              href="https://claude.ai/customize/skills"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:text-accent-dark underline underline-offset-2 break-all"
            >
              claude.ai/customize/skills
            </a>
            ;ChatGPT:{' '}
            <a
              href="https://chatgpt.com/skills"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:text-accent-dark underline underline-offset-2 break-all"
            >
              chatgpt.com/skills
            </a>
            。
          </li>
          <li>點「Upload skill」,選剛下載的 <code className="font-mono text-[0.85em]">mcq.skill</code>。</li>
          <li>回到 Claude 或 ChatGPT 對話,輸入 <code className="font-mono text-[0.85em]">/mcq 114-001</code> 開始測驗。</li>
        </ol>
        <p className="text-xs text-ink-400 dark:text-ink-500 mt-2.5">
          也可解壓 <code className="font-mono text-[0.85em]">.skill</code> 放進 Claude Code 的
          <code className="font-mono text-[0.85em] mx-1">.claude/skills/</code>;金鑰已寫在 <code className="font-mono text-[0.85em]">.env</code> 裡。
        </p>
      </div>

      <div className="mt-5 border-t border-ink-100 dark:border-ink-700 pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-400 dark:text-ink-500 mb-3">
          指令用法
        </p>
        <dl className="space-y-3 text-sm text-ink-600 dark:text-ink-300 leading-relaxed">
          <div className="sm:flex sm:gap-3">
            <dt className="shrink-0 sm:w-56 mb-0.5 sm:mb-0">
              <code className="font-mono text-[0.85em] bg-ink-50 dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded px-1.5 py-0.5">
                /mcq 114-001
              </code>
            </dt>
            <dd>出題作答:先顯示題幹與選項,你回答字母後才揭曉。這是預設的「隨堂測驗」模式。</dd>
          </div>
          <div className="sm:flex sm:gap-3">
            <dt className="shrink-0 sm:w-56 mb-0.5 sm:mb-0">
              <code className="font-mono text-[0.85em] bg-ink-50 dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded px-1.5 py-0.5">
                /mcq 114-001 answer
              </code>
            </dt>
            <dd>
              直接看答案:一次給出正解、共筆詳解,以及你自己在網站寫過的個人筆記
              <span className="text-ink-500 dark:text-ink-400">
                {' '}(一題有好幾則的話會全部列出,各自標上編號)
              </span>
              。
            </dd>
          </div>
          <div className="sm:flex sm:gap-3">
            <dt className="shrink-0 sm:w-56 mb-0.5 sm:mb-0">
              <code className="font-mono text-[0.85em] bg-ink-50 dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded px-1.5 py-0.5">
                /mcq search: CML
              </code>
            </dt>
            <dd>
              關鍵字搜尋題目,列出符合的年-題號讓你挑。
              <span className="text-ink-500 dark:text-ink-400">
                {' '}建議用縮寫(CML、CMV、AML、DIC…),別打全名 — 搜尋是逐詞比對,全名反而不易命中。
              </span>
            </dd>
          </div>
          <div className="sm:flex sm:gap-3">
            <dt className="shrink-0 sm:w-56 mb-0.5 sm:mb-0">
              <code className="font-mono text-[0.85em] bg-ink-50 dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded px-1.5 py-0.5">
                /mcq note 114-001: 內容
              </code>
            </dt>
            <dd>把「內容」附加到這題的個人筆記(接在既有筆記後面,只有你看得到)。</dd>
          </div>
          <div className="sm:flex sm:gap-3">
            <dt className="shrink-0 sm:w-56 mb-0.5 sm:mb-0">
              <code className="font-mono text-[0.85em] bg-ink-50 dark:bg-ink-900 border border-ink-200 dark:border-ink-700 rounded px-1.5 py-0.5">
                /mcq note 114-001 #2: 內容
              </code>
            </dt>
            <dd>
              一題可以有好幾則筆記,這樣寫進指定的那一則(編號看
              <code className="font-mono text-[0.85em] mx-1">answer</code>
              的輸出);
              <code className="font-mono text-[0.85em] mx-1">#2</code>
              換成
              <code className="font-mono text-[0.85em] mx-1">new</code>
              就另開一則。不指定就是第一則。
            </dd>
          </div>
        </dl>
        <p className="text-xs text-ink-400 dark:text-ink-500 mt-3">
          題號 <code className="font-mono text-[0.85em]">114-1</code> 也接受;
          <code className="font-mono text-[0.85em] mx-1">answer</code> 可換成
          <code className="font-mono text-[0.85em] mx-1">答案</code>/<code className="font-mono text-[0.85em] mx-1">看答案</code>。
          進階(限定年份搜尋、覆寫筆記、匯入圖文詳解)請看 skill 內的
          <code className="font-mono text-[0.85em] mx-1">SKILL.md</code>。
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

      {/* 2048 —— 刻意低調:讀累了才會來找它,不該在導覽列上分心。 */}
      <p className="mt-10 text-xs text-ink-400 dark:text-ink-500">
        <Link to="/play" className="hover:text-accent underline underline-offset-2">
          休息一下
        </Link>
      </p>
    </div>
  );
}
