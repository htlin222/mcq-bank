import { Users, ScrollText, Scale, ChevronRight } from 'lucide-react';

/**
 * Public landing page shown when the visitor isn't authenticated.
 *
 * The 「登入」 button navigates to /login. That path is NOT in the CF Access
 * bypass policy, so the browser hits CF Access first, completes the email-OTP
 * challenge, then CF Access redirects back to /login with the auth cookie
 * set. The SPA's /login route (a small redirect component) then sends the
 * user to /, where useMe() now succeeds and App.tsx renders the dashboard.
 */
export function Landing() {
  return (
    <div className="min-h-screen bg-ink-50 dark:bg-ink-900 text-ink-800 dark:text-ink-200 flex flex-col">
      <main className="flex-1 max-w-4xl w-full mx-auto px-6 py-12 sm:py-20">
        {/* Hero */}
        <header className="text-center mb-12">
          <div className="inline-flex items-baseline gap-3 mb-4">
            <h1 className="font-serif text-5xl sm:text-6xl text-ink-900 dark:text-ink-100">
              血專衝衝衝
            </h1>
            <span className="font-serif text-4xl sm:text-5xl text-accent">2026</span>
          </div>
          <p className="text-base sm:text-lg text-ink-600 dark:text-ink-400">
            血液腫瘤次專科考試 · 共筆詳解 · 全真模擬 · 答案挑戰
          </p>
        </header>

        {/* Login CTA */}
        <div className="flex justify-center mb-16">
          <a
            href="/login"
            className="inline-flex items-center gap-2 bg-accent hover:bg-accent-dark text-white font-medium px-8 py-3 rounded-lg shadow-paper transition"
          >
            登入
            <ChevronRight size={18} />
          </a>
        </div>

        {/* Features */}
        <section className="grid sm:grid-cols-3 gap-4 mb-12">
          <FeatureCard
            Icon={ScrollText}
            iconColor="text-accent"
            title="共筆詳解"
            body="一千題十年題庫，整組共寫解析；TipTap 編輯器、樂觀鎖、版本歷史。"
          />
          <FeatureCard
            Icon={Users}
            iconColor="text-amber-700 dark:text-amber-300"
            title="全真模擬"
            body="百題計時、自動評分、錯題回顧。題目順序按原卷，答完看分數與詳解。"
          />
          <FeatureCard
            Icon={Scale}
            iconColor="text-emerald-700 dark:text-emerald-300"
            title="答案挑戰"
            body="覺得官方答案有誤？提交挑戰，社群投票通過後自動翻案，保留審計軌跡。"
          />
        </section>

        {/* Dashboard preview mock */}
        <section className="mb-12">
          <h2 className="font-serif text-lg text-ink-700 dark:text-ink-300 mb-4 text-center">
            登入後的主畫面
          </h2>
          <DashboardPreviewMock />
        </section>

        {/* Footer */}
        <footer className="text-center text-xs text-ink-500 dark:text-ink-400 space-y-1">
          <p>限 20 位內測使用者 · 透過 Cloudflare Zero Trust 驗證 Email</p>
          <p>無密碼，登入收信箱 OTP 即可</p>
        </footer>
      </main>
    </div>
  );
}

function FeatureCard({
  Icon,
  iconColor,
  title,
  body,
}: {
  Icon: typeof ScrollText;
  iconColor: string;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 shadow-paper">
      <Icon size={22} className={`${iconColor} mb-3`} />
      <h3 className="font-serif text-lg text-ink-900 dark:text-ink-100 mb-2">{title}</h3>
      <p className="text-sm text-ink-600 dark:text-ink-400 leading-relaxed">{body}</p>
    </div>
  );
}

/**
 * Stylized SVG mock of the dashboard. Not a real screenshot — a deliberate
 * abstraction (no real data, fully responsive, no PNG dependency, dark-mode
 * friendly via currentColor and Tailwind utility classes on wrapper).
 */
function DashboardPreviewMock() {
  return (
    <div className="bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 shadow-paper">
      <svg
        viewBox="0 0 800 360"
        className="w-full h-auto"
        role="img"
        aria-label="Dashboard preview"
      >
        {/* Greeting */}
        <text x="20" y="34" fontFamily="serif" fontSize="22" fill="currentColor" className="text-ink-900 dark:text-ink-100">
          午安 <tspan fill="#a8442a">林彥廷</tspan>
        </text>
        {/* Countdown card */}
        <rect x="20" y="50" width="760" height="60" rx="6" className="fill-amber-50 dark:fill-amber-900/10 stroke-amber-300/40" strokeWidth="1" />
        <text x="36" y="76" fontSize="10" fill="currentColor" className="text-ink-500" letterSpacing="1">
          血液腫瘤次專科考試倒數
        </text>
        <text x="36" y="100" fontFamily="serif" fontSize="22" fill="#a8442a" fontWeight="600">
          96 <tspan fontSize="13" fill="currentColor" className="text-ink-600">天</tspan>
          <tspan fontFamily="monospace" fontSize="13" fill="currentColor" className="text-ink-600" dx="6">14:23:08</tspan>
        </text>
        {/* Heatmap grid */}
        <g transform="translate(20, 128)">
          <text x="0" y="-6" fontSize="9" fill="currentColor" className="text-ink-500" letterSpacing="1">
            最近 3 個月活動
          </text>
          {Array.from({ length: 13 }).map((_, col) =>
            Array.from({ length: 7 }).map((_, row) => {
              const intensity = ((col * 7 + row) * 31) % 5;
              const fills = ['#e8e3d8', '#d8c4a0', '#c89c66', '#a8442a', '#7a2f1d'];
              return (
                <rect
                  key={`${col}-${row}`}
                  x={col * 12}
                  y={row * 12}
                  width="10"
                  height="10"
                  rx="1.5"
                  fill={fills[intensity]}
                />
              );
            }),
          )}
        </g>
        {/* Stats row */}
        <g transform="translate(20, 230)">
          {['總題數 1000', '已複習 412', '準確率 67%'].map((label, i) => (
            <g key={label} transform={`translate(${i * 260}, 0)`}>
              <rect width="240" height="60" rx="6" className="fill-ink-50 dark:fill-ink-700/30 stroke-ink-200 dark:stroke-ink-700" strokeWidth="1" />
              <text x="120" y="36" fontFamily="serif" fontSize="20" textAnchor="middle" fill="currentColor" className="text-ink-900 dark:text-ink-100">
                {label}
              </text>
            </g>
          ))}
        </g>
        {/* Year cards (mini) */}
        <g transform="translate(20, 305)">
          {[114, 113, 112, 111, 110, 109, 108, 107, 106, 105].map((y, i) => (
            <g key={y} transform={`translate(${i * 76}, 0)`}>
              <rect width="68" height="40" rx="4" className="fill-white dark:fill-ink-800 stroke-ink-200 dark:stroke-ink-700" strokeWidth="1" />
              <text x="34" y="18" fontFamily="serif" fontSize="13" textAnchor="middle" fill="currentColor" className="text-ink-900 dark:text-ink-100">
                {y}
              </text>
              <rect x="6" y="28" width="56" height="3" rx="1.5" fill="#e8e3d8" />
              <rect x="6" y="28" width={6 + (i * 5) % 50} height="3" rx="1.5" fill="#a8442a" />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
