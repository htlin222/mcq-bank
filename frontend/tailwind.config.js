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
        serif: ['"Source Serif Pro"', '"Noto Serif TC"', 'Georgia', 'serif'],
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
  plugins: [],
};
