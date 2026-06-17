/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#4ec9b0', dark: '#1a1a2e', card: '#1e1e2e', border: '#2a2a3e' },
      },
    },
  },
  plugins: [],
};
