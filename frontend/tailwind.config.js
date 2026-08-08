import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink: {
          50:  '#f7f5f2',
          100: '#ede9e2',
          200: '#d8d0c2',
          300: '#b8ac96',
          400: '#8a7d65',
          500: '#5d5240',
          600: '#3f3729',
          700: '#2a2419',
          800: '#1a160f',
          900: '#0c0a06',
        },
        accent: {
          DEFAULT: '#a8442a',  // muted brick red
          dark: '#7a2f1d',
          light: '#cb6845',
        },
      },
      fontFamily: {
        // Owner opted for an all-sans UI (2026-07): `serif` deliberately
        // aliases the sans stack so every existing `font-serif` heading
        // renders sans without touching component code.
        serif: ['"Inter"', '"Noto Sans TC"', 'system-ui', 'sans-serif'],
        sans: ['"Inter"', '"Noto Sans TC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '70ch',
          },
        },
      },
      boxShadow: {
        paper: '0 1px 2px rgba(60, 50, 30, 0.04), 0 4px 16px -8px rgba(60, 50, 30, 0.10)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      // 電子紙(1-bit 純黑白)模式的逐元件精修前綴:`eink:bg-black` 等。
      //
      // 重複四次的 `.eink` 是刻意的 specificity 加權,不是手滑。產出的規則是
      // (0,5,0),恆勝 styles.css 檔尾那層 1-bit 中和層的 (0,4,0) —— 所以精修
      // 不必用 !important 就能蓋過「全部塗白/塗黑」的通則。
      // 別「順手清理」成 `.eink &`:那是 (0,2,0),會輸給中和層,所有精修一次
      // 全部失效,而且是無聲的。
      addVariant('eink', '.eink.eink.eink.eink &');
    }),
  ],
};
