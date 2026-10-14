import { z } from 'zod'
import { bed, room } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { codeSchema, duplicate, GENDER_POLICIES, idSchema, loadBuilding, loadSite, nameSchema, optionalText, snap } from './shared'

const MAX_BEDS_AT_ONCE = 12

export const input = z.object({
  siteId: idSchema,
  /** Optional: a villa is Site -> Room -> Bed (D-12). */
  buildingId: idSchema.nullish().transform(v => v ?? null),
  floor: optionalText(40),
  unit: optionalText(40),
  name: nameSchema,
  genderPolicy: z.enum(GENDER_POLICIES).default('any'),
  /** Beds to create with the room. Codes are unique within the site, whatever building or room they are in. */
  bedCodes: z.array(codeSchema).max(MAX_BEDS_AT_ONCE, `At most ${MAX_BEDS_AT_ONCE} beds at once`).default([])
    .refine(l => new Set(l.map(x => x.toLowerCase())).size === l.length, 'Bed codes must be different from each other'),
})
export type CreateRoomInput = z.infer<typeof input>
export interface CreateRoomOut { id: string; name: string; beds: { id: string; code: string }[] }

/** Accommodation Admin or Super Admin inside their sites create rooms (and their beds). */
export function createRoom(rc: RequestContext, i: CreateRoomInput): Promise<Result<CreateRoomOut>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'rooms_beds.manage', { siteId: i.siteId })
    if (denied) return denied
    const s = await loadSite(c.tx, i.siteId, 'share')
    if (!s) return fail.notFound()
    if (s.archivedAt) return failure('conflict', `Site ${s.name} is archived`, { owner: 'Super Admin', next: 'Choose an active site' })

    if (i.buildingId) {
      // FOR SHARE: archiving the building takes FOR UPDATE, so the room is either seen by that archive or refused here.
      const b = await loadBuilding(c.tx, i.buildingId, 'share')
      if (!b || b.siteId !== s.id) return fail.invalid('That building is not part of this site', { buildingId: 'Not found in this site' })
      if (b.archivedAt) return failure('conflict', `Building ${b.name} is archived`, { owner: 'Super Admin', next: 'Choose an active building, or put the room directly in the site' })
    }

    const [r] = await c.tx.insert(room).values({
      siteId: s.id, buildingId: i.buildingId, floor: i.floor, unit: i.unit, name: i.name, genderPolicy: i.genderPolicy,
    }).onConflictDoNothing().returning()
    if (!r) return duplicate('name', `There is already a room "${i.name}" in that building, floor and unit (it may be archived)`, 'Use a different name, or add the beds to the existing room')

    const beds = i.bedCodes.length
      ? await c.tx.insert(bed).values(i.bedCodes.map(code => ({ siteId: s.id, roomId: r.id, code }))).onConflictDoNothing().returning()
      : []
    if (beds.length !== i.bedCodes.length) {
      const made = new Set(beds.map(b => b.code.toLowerCase()))
      const clash = i.bedCodes.filter(code => !made.has(code.toLowerCase()))
      return duplicate('bedCodes', `Bed code${clash.length > 1 ? 's' : ''} already in use at ${s.name}: ${clash.join(', ')} (it may be archived)`, 'Use different bed codes. Bed codes are unique within a site')
    }

    await audit(c, { action: 'property.room.created', entityType: 'room', entityId: r.id, siteId: s.id, after: { ...snap.room(r), beds: beds.map(b => b.code) } })
    for (const b of beds) await audit(c, { action: 'property.bed.created', entityType: 'bed', entityId: b.id, siteId: s.id, after: snap.bed(b) })
    return ok({ id: r.id, name: r.name, beds: beds.map(b => ({ id: b.id, code: b.code })) }, `Room ${r.name} created${beds.length ? ` with ${beds.length} bed${beds.length > 1 ? 's' : ''}` : ''}`)
  })
}
