/**
 * Closed value sets shared by the domain, the policy module and the Drizzle schema.
 * The database mirrors each list in a CHECK constraint (db/migrations); tests/db/schema-sync.test.ts
 * fails if a list here and its CHECK drift apart.
 */

export const ROLES = ['SA', 'AA', 'Rec', 'Res', 'MC', 'Tech', 'Vend', 'Sec', 'Mgr', 'Aud'] as const
export type Role = (typeof ROLES)[number]

export const CAPABILITIES = [
  'Housekeeping', 'FinalInspection', 'EmergencyCheckin', 'BuildingCreation', 'NightKeys',
  'BackupApprover', 'PolicyApprover', 'OutageExport', 'StaffMaster',
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Physical bed state only (D-17). Dated reservations are bed_claim rows, not bed states. */
export const BED_STATES = ['available', 'occupied', 'needs_cleaning', 'inspection_required', 'blocked', 'under_maintenance', 'archived'] as const
export type BedStateDb = (typeof BED_STATES)[number]

export const STAY_STATUSES = ['provisional', 'active', 'resolution_pending', 'checked_out', 'closed'] as const
export type StayStatus = (typeof STAY_STATUSES)[number]
/** Statuses in which the person still occupies a bed (one such stay per person). */
export const OCCUPYING_STAY_STATUSES: readonly StayStatus[] = ['provisional', 'active', 'resolution_pending']

export const RESERVATION_STATUSES = ['reserved', 'checked_in', 'cancelled', 'no_show', 'expired'] as const
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number]

export const CLAIM_KINDS = ['reservation', 'offer_hold', 'stay'] as const
export type ClaimKind = (typeof CLAIM_KINDS)[number]

export const REQUEST_STATUSES = ['draft', 'submitted', 'pending_approval', 'approved', 'rejected', 'cancelled', 'waitlisted', 'closed'] as const
export type RequestStatus = (typeof REQUEST_STATUSES)[number]

export const OFFER_STATUSES = ['pending', 'accepted', 'declined', 'expired', 'withdrawn'] as const
export type OfferStatus = (typeof OFFER_STATUSES)[number]

export const WAITLIST_STATUSES = ['waiting', 'offered', 'closed'] as const
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number]

export const STAY_TYPES = ['permanent', 'contract', 'trainee'] as const
export type StayTypeDb = (typeof STAY_TYPES)[number]

export const SCOPE_KINDS = ['all', 'site', 'building', 'own', 'job'] as const
export type ScopeKind = (typeof SCOPE_KINDS)[number]

export const GRANT_STATUSES = ['pending', 'active', 'rejected', 'revoked'] as const
export type GrantStatus = (typeof GRANT_STATUSES)[number]
