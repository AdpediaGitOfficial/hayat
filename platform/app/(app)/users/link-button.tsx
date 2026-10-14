import Link from 'next/link'
import type { ReactNode } from 'react'

/** A link that looks like the shared Button (the browser's link underline and colour would otherwise show). */
export function LinkButton({ href, variant = 'secondary', size, children }: { href: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm'; children: ReactNode }) {
  return <Link className={`btn ${variant} ${size ?? ''}`} href={href} style={{ textDecoration: 'none' }}>{children}</Link>
}

/** An in-table link: the text colour of its row, no underline. */
export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} style={{ color: 'inherit', textDecoration: 'none' }}>{children}</Link>
}
