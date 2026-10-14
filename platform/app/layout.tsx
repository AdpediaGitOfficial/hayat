import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '@/styles/base.css'
import '@/styles/components.css'
import '@/styles/app.css'

export const metadata: Metadata = {
  title: 'Grand Hyatt Staff Accommodation',
  description: 'Staff housing management platform',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
