/** Plain data shapes returned by the property queries and the API. No Date objects: everything is JSON-safe. */
import type { BedStateDb, ClaimKind } from '@/domain/enums'

/** Beds by physical state. `total` counts every bed that is not archived. */
export type StateCounts = Record<Exclude<BedStateDb, 'archived'>, number> & { total: number }

export const emptyCounts = (): StateCounts => ({
  total: 0, available: 0, occupied: 0, needs_cleaning: 0, inspection_required: 0, blocked: 0, under_maintenance: 0,
})

export interface SiteSummary {
  id: string
  code: string
  name: string
  kind: 'villa' | 'apartment' | 'other'
  timeZone: string
  archived: boolean
  /** Left out when the actor may see the site but not its rooms and beds (for example Security). */
  buildings?: number
  rooms?: number
  beds?: StateCounts
}

export interface ClaimSummary {
  claimId: string
  kind: ClaimKind
  /** First night. */
  from: string
  /** Departure day (end-exclusive, D-103); null = open-ended. */
  to: string | null
}

export interface TreeBed {
  id: string
  code: string
  state: BedStateDb
  stateReason: string | null
  /** ISO timestamp the bed entered its current state. */
  stateSince: string
  /** Last blocked day, when the bed is blocked with an end date. */
  blockedUntil: string | null
  archived: boolean
  /** Number of live claims that have not ended yet, and the first of them. Dated reservations sit ALONGSIDE the state (D-17). */
  upcomingCount: number
  nextClaim: ClaimSummary | null
}

export interface TreeRoom {
  id: string
  name: string
  floor: string | null
  unit: string | null
  genderPolicy: 'any' | 'male' | 'female'
  buildingId: string | null
  archived: boolean
  beds: TreeBed[]
  counts: StateCounts
}

export interface TreeBuilding {
  id: string
  code: string
  name: string
  archived: boolean
  rooms: TreeRoom[]
  counts: StateCounts
}

export interface TreeFilter {
  /** One physical state, or all. */
  state?: BedStateDb
  /** Only beds that have a live claim that has not ended. */
  reserved?: boolean
  /** Matches bed code, room name, building name or code. */
  q?: string
  includeArchived?: boolean
}

export interface SiteTree {
  site: SiteSummary
  buildings: TreeBuilding[]
  /** Rooms that sit directly in the site (a villa: Site -> Room -> Bed). */
  directRooms: TreeRoom[]
  /** Counts for the whole site, ignoring the filter, so the chips never change when you filter. */
  counts: StateCounts
  /** Today in the site's time zone, 'YYYY-MM-DD'. */
  today: string
  filter: TreeFilter
}

export interface BedDetail {
  id: string
  code: string
  state: BedStateDb
  stateReason: string | null
  stateSince: string
  archived: boolean
  site: { id: string; code: string; name: string; timeZone: string }
  building: { id: string; code: string; name: string } | null
  room: { id: string; name: string; floor: string | null; unit: string | null; genderPolicy: 'any' | 'male' | 'female'; archived: boolean }
  /** The block in force, if the bed is blocked. */
  block: { reason: string; until: string | null; blockedAt: string; blockedByName: string | null } | null
  /** Today in the site's time zone: lets the screen say "block ended, unblock it" without guessing. */
  today: string
  claims: (ClaimSummary & {
    /** Who the claim is for. Only present when the actor may see the staff directory for this site. */
    holder?: { staffId: string; name: string; employeeId: string } | null
  })[]
  history: { reason: string; until: string | null; blockedAt: string; releasedAt: string | null }[]
}

export interface RoomDetail {
  id: string
  name: string
  floor: string | null
  unit: string | null
  genderPolicy: 'any' | 'male' | 'female'
  archived: boolean
  site: { id: string; code: string; name: string }
  building: { id: string; code: string; name: string } | null
  beds: TreeBed[]
  counts: StateCounts
}

export interface BuildingDetail {
  id: string
  code: string
  name: string
  archived: boolean
  site: { id: string; code: string; name: string }
  rooms: { id: string; name: string; floor: string | null; unit: string | null; genderPolicy: 'any' | 'male' | 'female'; counts: StateCounts }[]
  counts: StateCounts
}
