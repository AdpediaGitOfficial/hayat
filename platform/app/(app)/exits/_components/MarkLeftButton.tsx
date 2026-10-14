'use client'
/**
 * A button for the staff profile page: opens Mark as Left for this person (/exits/new?employeeId=...). Self-contained, so the staff
 * package can place it without knowing anything else about this package. Show it only to people who may mark someone as Left
 * (Super Admin and Accommodation Admin); the page behind it checks again and answers "not found" to anyone else.
 */
import Link from 'next/link'

export function MarkLeftButton({ employeeId, label = 'Mark as Left' }: { employeeId: string; label?: string }) {
  return (
    <Link href={`/exits/new?employeeId=${encodeURIComponent(employeeId)}`} className="btn secondary" style={{ textDecoration: 'none' }} data-testid="mark-left-button">
      {label}
    </Link>
  )
}

/** The way back for someone who left: opens Rehire for this person (/exits/rehire?employeeId=...). */
export function RehireButton({ employeeId, label = 'Rehire' }: { employeeId: string; label?: string }) {
  return (
    <Link href={`/exits/rehire?employeeId=${encodeURIComponent(employeeId)}`} className="btn secondary" style={{ textDecoration: 'none' }} data-testid="rehire-button">
      {label}
    </Link>
  )
}
