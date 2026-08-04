import type { Metadata } from 'next'
import './globals.css'
import { CommandPalette } from '@/components/CommandPalette'
import { ToastRack } from '@/components/Card'

export const metadata: Metadata = {
  title: 'NaxionAI — Personal AI Assistant',
  description: 'NaxionAI (Naxie) — a personal assistant that plans, researches, and acts on your behalf.',
  keywords: ['AI', 'personal assistant', 'automation', 'voice assistant'],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Plus+Jakarta+Sans:wght@200..800&family=Playfair+Display:ital,wght@0,400..900;1,400..900&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-surface text-white antialiased min-h-screen">
        {children}
        <CommandPalette />
        <ToastRack />
      </body>
    </html>
  )
}
