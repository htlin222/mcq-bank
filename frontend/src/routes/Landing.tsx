import { Users, ScrollText, Scale, ChevronRight } from 'lucide-react';
import { config } from '../config';

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
              {config.brand.short_name}
            </h1>
            <span className="font-serif text-4xl sm:text-5xl text-accent">{config.brand.year}</span>
          </div>
          <p className="text-base sm:text-lg text-ink-600 dark:text-ink-400">
            {config.brand.subtitle}
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

        {/* Footer */}
        <footer className="text-center text-xs text-ink-500 dark:text-ink-400">
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
