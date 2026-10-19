/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/web/index.html', './src/web/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace']
      },
      colors: {
        // Mirrors the CSS custom properties so utilities and tokens never drift apart.
        ink: { DEFAULT: '#e9ecf6', muted: '#a2aabd', faint: '#6b7386' },
        surface: { DEFAULT: '#06070b', raised: '#0a0c13' },
        violet: { accent: '#7c5cff' },
        cyan: { accent: '#22d3ee' },
        pink: { accent: '#f472b6' }
      },
      borderRadius: {
        s: '12px',
        m: '18px',
        l: '26px',
        xl: '34px'
      }
    }
  },
  darkMode: 'class',
  plugins: []
}
