/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      // Dock palette: one dark, one paper, one rule colour, one secondary
      // text colour that still clears WCAG AA at 10–11px, and three status
      // colours. Everything in the UI is built from these.
      colors: {
        ink: '#1a1a1a',
        paper: '#f4f4f4',
        line: '#e0e0e0',
        muted: '#525252',
        blue: { DEFAULT: '#0F62FE', deep: '#0353E9' },
        green: { DEFAULT: '#4a7a30', deep: '#3b6226' },
        red: { DEFAULT: '#a83232', deep: '#8a2828' }
      },
      fontFamily: {
        sans: ["'IBM Plex Sans'", 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ["'IBM Plex Mono'", 'ui-monospace', 'Menlo', 'Courier New', 'monospace']
      }
    },
  },
  plugins: [],
}
