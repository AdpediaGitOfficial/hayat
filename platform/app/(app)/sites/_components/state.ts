/**
 * Display rules for the inventory screens. Plain module (no 'use client'), usable from server and client components.
 * State values in the database are snake_case; the status chips and the design system use CamelCase keys
 * (src/ui/status.ts), so the mapping lives here.
 */
import type { BedStateDb } from '@/domain/enums'
import { fmtDateLong } from '@/domain/time'

/** Key understood by <Status s=...> (src/ui/status.ts). */
export const STATE_STATUS: Record<BedStateDb, string> = {
  available: 'Available', occupied: 'Occupied', needs_cleaning: 'NeedsCleaning', inspection_required: 'InspectionRequired',
  blocked: 'Blocked', under_maintenance: 'UnderMaintenance', archived: 'Archived',
}
export const STATE_NAME: Record<BedStateDb, string> = {
  available: 'Available', occupied: 'Occupied', needs_cleaning: 'Needs cleaning', inspection_required: 'Inspection required',
  blocked: 'Blocked', under_maintenance: 'Under maintenance', archived: 'Archived',
}
export const GENDER_LABEL = { any: 'Any gender', male: 'Male only', female: 'Female only' } as const
export const CLAIM_LABEL = { reservation: 'Reservation', offer_hold: 'Held for a bed offer', stay: 'Stay' } as const
export const SITE_KIND_LABEL = { villa: 'Villa', apartment: 'Apartment', other: 'Other' } as const

/** "Tue 20 Oct 2026 to Fri 30 Oct 2026 (departure day)" */
export function fmtClaimRange(from: string, to: string | null): string {
  return to ? `${fmtDateLong(from)} to ${fmtDateLong(to)} (departure day)` : `${fmtDateLong(from)}, open-ended`
}

/** Tile classes from the prototype: occupied / reserved / available / blocked. A dated claim is shown alongside the state. */
export function bedTileClass(state: BedStateDb, hasClaim: boolean): 'occupied' | 'reserved' | 'available' | 'blocked' {
  if (state === 'occupied') return 'occupied'
  if (state === 'available') return hasClaim ? 'reserved' : 'available'
  return 'blocked'
}

/** D-93: every blocked state explains itself with reason + owner + next action. */
export function stateExplanation(state: BedStateDb, o: { reason: string | null; until: string | null; today: string }): { why: string; owner: string; next: string } | undefined {
  switch (state) {
    case 'needs_cleaning': return { why: 'Vacant · needs cleaning', owner: 'Housekeeping', next: 'Assign cleaning, then final inspection' }
    case 'inspection_required': return { why: 'Vacant · awaiting final inspection', owner: 'Final Inspection holder', next: 'Inspect the bed to make it Available' }
    case 'under_maintenance': return { why: `Under maintenance${o.reason ? `: ${o.reason}` : ''}`, owner: 'Maintenance Coordinator', next: 'Finish and verify the work; the bed then goes to cleaning and inspection' }
    case 'blocked': {
      const ended = o.until !== null && o.until < o.today
      return {
        why: `Blocked${o.reason ? `: ${o.reason}` : ''}${o.until ? ` · until ${fmtDateLong(o.until)} (last blocked day)` : ' · until further notice'}${ended ? ' · the block period has ended' : ''}`,
        owner: 'Accommodation Admin or Maintenance Coordinator',
        next: ended ? 'The date has passed but nothing is released automatically: unblock the bed, then it needs cleaning and inspection' : 'Fix the cause, then unblock. The bed then needs cleaning and inspection before check-in',
      }
    }
    case 'archived': return { why: 'Archived: this bed is out of use for good', owner: 'Accommodation Admin', next: 'Nothing to do. Add a new bed if the space is needed again' }
    default: return undefined
  }
}
