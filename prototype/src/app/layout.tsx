import type { Metadata, Viewport } from 'next'
import '../styles/base.css'
import '../styles/components.css'

export const metadata: Metadata = {
  title: 'Grand Hyatt Staff Accommodation (Prototype)',
  description: 'Clickable prototype of the Grand Hyatt staff accommodation platform, Phase 1. Dummy data only.',
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body>{children}</body>
    </html>
  )
}
