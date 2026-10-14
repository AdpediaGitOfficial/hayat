/** Server-safe helpers for the request screens (no 'use client'): date ranges, chips and links that look like buttons. */
import Link from 'next/link'
import type { ReactNode } from 'react'
import { fmtDate, fmtDateLong } from '@/domain/time'
import { REQUEST_CHIP, RESERVATION_CHIP } from '@/domain/requests'
import type { RequestStatus, ReservationStatus } from '@/domain/enums'
import { Badge, Status } from '@/ui'

/** "Fri 23 Oct to Sat 21 Nov" (the second date is the departure day, D-103) or "from Fri 23 Oct, open-ended". */
export const range = (from: string, to: string | null) => (to ? `${fmtDate(from)} to ${fmtDate(to)}` : `from ${fmtDate(from)}, open-ended`)
export { fmtDate, fmtDateLong }
export const fmtStamp = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC'

export const RequestChip = ({ status }: { status: RequestStatus }) => <Status s={REQUEST_CHIP[status].key} label={REQUEST_CHIP[status].label} />
export const ReservationChip = ({ status }: { status: ReservationStatus }) => <Status s={RESERVATION_CHIP[status].key} label={RESERVATION_CHIP[status].label} />
export const UrgentChip = () => <Badge tone="danger">Urgent</Badge>

export function LinkButton({ href, variant = 'secondary', size, children }: { href: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm'; children: ReactNode }) {
  return <Link className={`btn ${variant} ${size ?? ''}`} href={href} style={{ textDecoration: 'none' }}>{children}</Link>
}
export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} style={{ color: 'inherit', textDecoration: 'none' }}>{children}</Link>
}
