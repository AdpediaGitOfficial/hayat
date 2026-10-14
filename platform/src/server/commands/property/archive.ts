/**
 * Archiving a bed, a room or a building. Archive only, never delete (CLAUDE.md): `archived_at` is set, the bed state becomes
 * 'archived', and every row stays for the history and the audit trail.
 *
 * Atomic and race-safe (AT-029): inside ONE transaction the command takes FOR UPDATE locks on the target and all its active
 * descendants (building -> rooms -> beds), then runs the dependency checkers, then writes. A reservation created at the same
 * moment either committed first (the checker sees it and the archive is refused) or waits for the archive and is then refused
 * by the database guard on bed_claim (migration 0010). Nothing is half-archived: a refusal rolls everything back.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { bed, building, room } from '@/server/db/schema'
import { bedBlock } from '@/server/db/schema.property'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext, Tx } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { findBlockers, loadStructure, summarize, type StructureKind } from './dependencies'
import { idSchema, reasonSchema, snap } from './shared'

export const bedInput = z.object({ id: idSchema, reason: reasonSchema })
export const structureInput = z.object({
  id: idSchema,
  reason: reasonSchema,
  /** Archive the still-active rooms and beds below it together with it. Everything else that blocks an archive still blocks it. */
  cascade: z.boolean().default(false),
})
export type ArchiveBedInput = z.infer<typeof bedInput>
export type ArchiveStructureInput = z.infer<typeof structureInput>

export interface ArchiveOut { id: string; kind: StructureKind; archived: { buildings: number; rooms: number; beds: number } }

async function siteOf(tx: Tx, kind: StructureKind, id: string): Promise<string | undefined> {
  const t = kind === 'bed' ? bed : kind === 'room' ? room : building
  const [r] = await tx.select({ siteId: t.siteId }).from(t).where(eq(t.id, id))
  return r?.siteId
}

/** Archives these beds (all of them free: the checkers already refused anything else) and closes their open blocks. */
async function archiveBeds(tx: Tx, bedIds: string[], now: Date, byUser: string): Promise<void> {
  if (bedIds.length === 0) return
  await tx.update(bed).set({ state: 'archived', stateReason: null, stateSince: now, archivedAt: now }).where(inArray(bed.id, bedIds))
  await tx.update(bedBlock).set({ releasedAt: now, releasedBy: byUser }).where(and(inArray(bedBlock.bedId, bedIds), isNull(bedBlock.releasedAt)))
}

export function archiveStructure(rc: RequestContext, kind: StructureKind, i: ArchiveStructureInput): Promise<Result<ArchiveOut>> {
  return runCommand(rc, async c => {
    const siteId = await siteOf(c.tx, kind, i.id)
    if (!siteId) return fail.notFound()
    // Buildings belong to "Sites & buildings: manage" (Super Admin); rooms and beds to "Rooms & beds: manage" (AA and SA).
    const denied = authorize(c, kind === 'building' ? 'sites_buildings.manage' : 'rooms_beds.manage', { siteId })
    if (denied) return denied

    const scope = await loadStructure(c.tx, kind, i.id, { lock: true, cascade: kind !== 'bed' && i.cascade })
    if (!scope) return fail.notFound()
    if (scope.archived) return failure('conflict', `${scope.label} is already archived`, { owner: 'Accommodation Admin', next: 'Nothing to do' })

    // Re-checked here, under the locks: this is the answer that counts, whatever a screen showed a moment ago.
    const report = await findBlockers(c.tx, scope)
    if (report.total > 0) {
      return fail.conflict(
        `${scope.label} can't be archived: ${summarize(report)}`,
        'Accommodation Admin',
        'Resolve each item listed, then archive again. Nothing was changed',
        { blockers: report.blockers, total: report.total, truncated: report.truncated },
      )
    }

    const out = { buildings: 0, rooms: 0, beds: 0 }
    const why = { reason: i.reason }
    if (kind === 'bed') {
      const b = scope.beds[0]
      await archiveBeds(c.tx, [b.id], c.now, c.user.id)
      await audit(c, { action: 'property.bed.archived', entityType: 'bed', entityId: b.id, siteId, before: snap.bed(b), after: { ...snap.bed({ ...b, state: 'archived', stateReason: null }) }, ...why })
      out.beds = 1
    } else {
      // Children first, so the parent is never archived while something active still hangs under it.
      await archiveBeds(c.tx, scope.beds.map(b => b.id), c.now, c.user.id)
      for (const b of scope.beds) {
        await audit(c, { action: 'property.bed.archived', entityType: 'bed', entityId: b.id, siteId, before: snap.bed(b), after: { ...snap.bed({ ...b, state: 'archived', stateReason: null }), archivedWith: `${kind}:${i.id}` }, ...why })
      }
      out.beds = scope.beds.length
      if (kind === 'room') {
        const r = scope.rooms[0]
        await c.tx.update(room).set({ archivedAt: c.now }).where(eq(room.id, r.id))
        await audit(c, { action: 'property.room.archived', entityType: 'room', entityId: r.id, siteId, before: snap.room(r), after: { archived: true, beds: scope.beds.length }, ...why })
        out.rooms = 1
      } else {
        if (scope.rooms.length) await c.tx.update(room).set({ archivedAt: c.now }).where(inArray(room.id, scope.rooms.map(r => r.id)))
        for (const r of scope.rooms) {
          await audit(c, { action: 'property.room.archived', entityType: 'room', entityId: r.id, siteId, before: snap.room(r), after: { archived: true, archivedWith: `building:${i.id}` }, ...why })
        }
        out.rooms = scope.rooms.length
        await c.tx.update(building).set({ archivedAt: c.now }).where(eq(building.id, i.id))
        await audit(c, { action: 'property.building.archived', entityType: 'building', entityId: i.id, siteId, after: { archived: true, rooms: scope.rooms.length, beds: scope.beds.length }, ...why })
        out.buildings = 1
      }
    }
    const parts = [out.buildings && 'building', out.rooms && `${out.rooms} room${out.rooms > 1 ? 's' : ''}`, out.beds && `${out.beds} bed${out.beds > 1 ? 's' : ''}`].filter(Boolean)
    return ok({ id: i.id, kind, archived: out }, `${scope.label} archived (${parts.join(', ')}). Nothing was deleted`)
  })
}
