import type { BedStateDb, ClaimKind, ReservationStatus, StayStatus } from './enums'

/**
 * Allowed state moves. This is the pure twin of the state_transition table (db/migrations/0006):
 * the domain layer checks it to give friendly errors, the database trigger enforces it regardless.
 * tests/db/transitions.test.ts asserts the two are identical.
 */
type Machine<S extends string> = Readonly<Record<S, readonly S[]>>

export const BED_TRANSITIONS: Machine<BedStateDb> = {
  available: ['occupied', 'blocked', 'under_maintenance', 'archived'],
  occupied: ['needs_cleaning', 'inspection_required'],
  needs_cleaning: ['inspection_required', 'blocked', 'under_maintenance'],
  inspection_required: ['available', 'needs_cleaning', 'blocked', 'under_maintenance'],
  blocked: ['needs_cleaning', 'under_maintenance', 'archived'],
  under_maintenance: ['needs_cleaning', 'inspection_required', 'blocked'],
  archived: [],
}

export const STAY_TRANSITIONS: Machine<StayStatus> = {
  provisional: ['active', 'resolution_pending', 'checked_out'],
  active: ['checked_out'],
  resolution_pending: ['active', 'checked_out'],
  checked_out: ['closed'],
  closed: [],
}

export const RESERVATION_TRANSITIONS: Machine<ReservationStatus> = {
  reserved: ['checked_in', 'cancelled', 'no_show', 'expired'],
  checked_in: [],
  cancelled: [],
  no_show: [],
  expired: [],
}

export const CLAIM_KIND_TRANSITIONS: Machine<ClaimKind> = {
  offer_hold: ['reservation'],
  reservation: ['stay'],
  stay: [],
}

export function canTransition<S extends string>(machine: Machine<S>, from: S, to: S): boolean {
  return machine[from]?.includes(to) ?? false
}

/** Keys match state_transition.entity ('<table>.<column>'). */
export const MACHINES = {
  'bed.state': BED_TRANSITIONS,
  'stay.status': STAY_TRANSITIONS,
  'reservation.status': RESERVATION_TRANSITIONS,
  'bed_claim.kind': CLAIM_KIND_TRANSITIONS,
} as const
