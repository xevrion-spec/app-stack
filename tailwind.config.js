/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', 'src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      spacing: {
        4.5: '1.125rem',
        5.5: '1.375rem',
      },
      colors: {
        ink: {
          950: '#08090e',
          900: '#0b0d14',
          850: '#0f1118',
          800: '#141621',
          700: '#1c1f2e',
          600: '#262a3d',
          500: '#353a52',
        },
        accent: {
          50: '#e6f0ff',
          100: '#c5dbff',
          200: '#9bc1ff',
          300: '#6ba1ff',
          400: '#4a8cff',
          500: '#2563eb',
          600: '#1d4fd0',
          700: '#1a41a8',
          800: '#1a3a85',
          900: '#1b3468',
        },
        emerald2: {
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
        },
        amber2: {
          400: '#fbbf24',
          500: '#f59e0b',
        },
        rose2: {
          400: '#fb7185',
          500: '#f43f5e',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 24px -4px rgba(37, 99, 235, 0.45)',
        'glow-sm': '0 0 12px -2px rgba(37, 99, 235, 0.35)',
        'glow-emerald': '0 0 24px -4px rgba(16, 185, 129, 0.4)',
        'glow-amber': '0 0 24px -4px rgba(245, 158, 11, 0.35)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          '0%': { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-glow': {
          from: { opacity: '1' },
          to: { opacity: '0.55' },
        },
        blink: {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.35s ease-out',
        'slide-in': 'slide-in 0.3s ease-out',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        blink: 'blink 1.1s step-end infinite',
      },
    },
  },
  plugins: [],
};
