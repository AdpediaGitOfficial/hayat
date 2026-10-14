import { eq } from 'drizzle-orm'
import { bed, building, room } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import type { Actor } from '@/server/policy'
import { authorize } from '@/server/command/authorize'
import { fail, ok, type Result } from '@/server/command/result'
import { findBlockers, loadStructure, summarize, type Blocker, type StructureKind } from '@/server/commands/property/dependencies'
import { isUuid } from '@/server/commands/property/shared'

export interface ArchivePreview {
  kind: StructureKind
  id: string
  label: string
  alreadyArchived: boolean
  /** True when an archive would go ahead right now. The command re-checks under locks, so this is advice, not a promise. */
  archivable: boolean
  blockers: Blocker[]
  total: number
  truncated: boolean
  summary: string
  /** Active children that "archive together" would take along (only counted when cascade is asked for). */
  cascade: boolean
}

/**
 * "What would stop me archiving this?", read-only and without locks, so a screen can show the dependency list before anybody
 * clicks. Same checkers as the command (AT-029), and the same permission: buildings need "Sites & buildings: manage" (Super Admin),
 * rooms and beds "Rooms & beds: manage". Out of scope is 404, no grant is 403.
 */
export async function previewArchive(actor: Actor, kind: StructureKind, id: string, cascade = false): Promise<Result<ArchivePreview>> {
  if (!isUuid(id)) return fail.notFound()
  const db = getDb()
  const t = kind === 'bed' ? bed : kind === 'room' ? room : building
  const [r] = await db.select({ siteId: t.siteId }).from(t).where(eq(t.id, id))
  if (!r) {
    // Do not reveal existence: someone without the action gets 403 either way, everybody else 404.
    return authorize({ actor }, kind === 'building' ? 'sites_buildings.manage' : 'rooms_beds.manage') ?? fail.notFound()
  }
  const denied = authorize({ actor }, kind === 'building' ? 'sites_buildings.manage' : 'rooms_beds.manage', { siteId: r.siteId })
  if (denied) return denied
  const useCascade = kind !== 'bed' && cascade
  const scope = await loadStructure(db, kind, id, { lock: false, cascade: useCascade })
  if (!scope) return fail.notFound()
  const report = await findBlockers(db, scope)
  return ok({
    kind, id, label: scope.label, alreadyArchived: scope.archived, archivable: !scope.archived && report.total === 0,
    blockers: report.blockers, total: report.total, truncated: report.truncated, summary: summarize(report), cascade: useCascade,
  })
}
