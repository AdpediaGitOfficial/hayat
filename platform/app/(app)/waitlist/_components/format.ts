/** Plain formatting helpers, usable from server and client components alike (no 'use client' here). */
export const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
export const fmtWhen = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`
export const dates = (from: string, to: string | null) => (to ? `${fmtDay(from)} to ${fmtDay(to)}` : `${fmtDay(from)}, open-ended`)
