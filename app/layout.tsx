import type { Metadata } from 'next'
import './globals.css'
import { AuthProvider } from './contexts/AuthContext'
import { CacheProvider } from './contexts/CacheContext'
import LayoutWrapper from './components/LayoutWrapper'
import { Inter, Lato } from 'next/font/google'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const lato = Lato({
  weight: ['300', '400', '700'],
  subsets: ['latin'],
  variable: '--font-lato',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Liebe Controladoria - DRE',
  description: 'Sistema de DRE e Indicadores - Liebe Controladoria',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${lato.variable}`}>
      <body className={inter.className}>
        <AuthProvider>
          <CacheProvider>
            <LayoutWrapper>{children}</LayoutWrapper>
          </CacheProvider>
        </AuthProvider>
      </body>
    </html>
  )
}
