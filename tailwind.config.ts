import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Paleta personalizada baseada em PANTONE 695C e 694C
        brand: {
          primary: '#B3838C', // PANTONE 695 C - Rosa principal
          secondary: '#C5949D', // PANTONE 694 C - Rosa claro
          dark: '#585858', // Cinza escuro
          light: '#FFFFFF', // Branco
          black: '#1D1D1D', // Preto
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        primary: ['var(--font-inter)', 'sans-serif'],
        secondary: ['var(--font-lato)', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
export default config
