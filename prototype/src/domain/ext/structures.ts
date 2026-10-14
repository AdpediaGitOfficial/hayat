/* Property structure: blocking and archiving rooms and buildings with dependency checks (P-10, D-19),
   and date-ranged bed blocks (P-11). Blocking never moves an occupant: they are flagged for the admin. */
import type { Bed, Persona, State } from '../types'
import { fail, guard, log, notify, ok, openCleaning, registerTick, run, setBed, uid } from '../core'
import { bedById, deny, outOfScope, roomOf, buildingOf } from '../rules'
import { dateStr, nowMs, today } from '../time'

/** Everything that stops a structure being archived: occupants, reservations, keys, open work orders. */
export function bedDependencies(d: State, beds: Bed[]) {
  const ids = new Set(beds.map(b => b.id))
  const why: string[] = []
  const occ = d.stays.filter(s => s.status === 'Active' && ids.has(s.bedId)).length
  const res = d.reservations.filter(r => r.status === 'Reserved' && ids.has(r.bedId)).length
  const held = beds.filter(b => b.heldBy).length
  const keys = d.keys.filter(k => k.status === 'Issued' && ids.has(k.bedId)).length
  const wos = d.workOrders.filter(w => w.status !== 'Verified' && ids.has(w.bedId)).length
  if (occ) why.push(`${occ} occupied bed${occ > 1 ? 's' : ''}`)
  if (res) why.push(`${res} reservation${res > 1 ? 's' : ''}`)
  if (held) why.push(`${held} bed${held > 1 ? 's' : ''} held by offers`)
  if (keys) why.push(`${keys} key${keys > 1 ? 's' : ''} still issued`)
  if (wos) why.push(`${wos} open work order${wos > 1 ? 's' : ''}`)
  return why
}
/** Residents who live under a blocked room or building: flagged for human action, never auto-moved. */
export function flaggedStays(d: State) {
  return d.stays.filter(s => {
    if (s.status !== 'Active') return false
    const room = roomOf(d, bedById(d, s.bedId)!)
    return !!(room.blocked ?? buildingOf(d, room)?.blocked)
  })
}

export const structureActions = {
  blockStructure(actor: Persona, f: { kind: 'room' | 'building'; id: string; reason: string }) {
    return run(d => {
      const room = f.kind === 'room' ? d.rooms.find(r => r.id === f.id) : undefined
      const bld = f.kind === 'building' ? d.buildings.find(b => b.id === f.id) : undefined
      const target = room ?? bld
      if (!target) return fail('Not found')
      const siteId = room ? room.siteId : bld!.siteId
      const e = guard(deny(actor, 'structure.block', 'block rooms and buildings'), outOfScope(actor, siteId))
      if (e) return e
      if (!f.reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      target.blocked = { reason: f.reason, at: nowMs(), by: actor.name }
      const beds = d.beds.filter(b => (room ? b.roomId === room.id : roomOf(d, b).buildingId === bld!.id))
      const flagged = d.stays.filter(s => s.status === 'Active' && beds.some(b => b.id === s.bedId)).length
      const future = d.reservations.filter(r => r.status === 'Reserved' && beds.some(b => b.id === r.bedId)).length
      log(d, actor, 'Structure blocked', `${room ? room.name : bld!.name}: ${f.reason}`)
      if (flagged || future) notify(d, { toRole: 'AA', text: `${room ? room.name : bld!.name} is blocked. ${flagged} resident(s) are flagged for you to move or confirm, and ${future} future reservation(s) need reallocation. Nobody is moved automatically.` })
      return ok(`Blocked. New allocations to ${beds.length} beds stop now${flagged ? `; ${flagged} current resident(s) are flagged, not moved` : ''}`)
    })
  },
  unblockStructure(actor: Persona, f: { kind: 'room' | 'building'; id: string }) {
    return run(d => {
      const target = f.kind === 'room' ? d.rooms.find(r => r.id === f.id) : d.buildings.find(b => b.id === f.id)
      if (!target) return fail('Not found')
      const e = guard(deny(actor, 'structure.block', 'unblock rooms and buildings'), outOfScope(actor, target.siteId))
      if (e) return e
      delete target.blocked
      log(d, actor, 'Structure unblocked', ('name' in target ? target.name : ''))
      return ok('Unblocked')
    })
  },
  archiveRoom(actor: Persona, roomId: string) {
    return run(d => {
      const room = d.rooms.find(r => r.id === roomId)
      if (!room) return fail('Not found')
      const e = guard(deny(actor, 'structure.archive', 'archive rooms'), outOfScope(actor, room.siteId))
      if (e) return e
      const beds = d.beds.filter(b => b.roomId === room.id)
      const why = bedDependencies(d, beds)
      if (why.length) return fail(`${room.name} can't be archived: ${why.join(', ')}`, 'Accommodation Admin', 'Resolve these first. Archiving never deletes history')
      room.archived = true; beds.forEach(b => setBed(d, b, 'Archived'))
      log(d, actor, 'Room archived', `${room.name} and ${beds.length} beds (history retained)`)
      return ok(`${room.name} archived with ${beds.length} beds. History is kept`)
    })
  },
  archiveBuilding(actor: Persona, buildingId: string) {
    return run(d => {
      const bld = d.buildings.find(b => b.id === buildingId)
      if (!bld) return fail('Not found')
      const e = guard(deny(actor, 'structure.archive', 'archive buildings'), outOfScope(actor, bld.siteId))
      if (e) return e
      const rooms = d.rooms.filter(r => r.buildingId === bld.id)
      const beds = d.beds.filter(b => rooms.some(r => r.id === b.roomId))
      const why = bedDependencies(d, beds)
      if (why.length) return fail(`${bld.name} can't be archived: ${why.join(', ')}`, 'Accommodation Admin', 'Resolve these first. Archiving never deletes history')
      bld.archived = true; rooms.forEach(r => { r.archived = true }); beds.forEach(b => setBed(d, b, 'Archived'))
      log(d, actor, 'Building archived', `${bld.name}: ${rooms.length} rooms, ${beds.length} beds (history retained)`)
      return ok(`${bld.name} archived. History is kept`)
    })
  },

  /** A block covers a date range. One that starts today takes the bed out of use now; a later one only stops allocations that overlap it. */
  blockBed(actor: Persona, bedId: string, reason: string, range: { from?: string; to?: string } = {}) {
    return run(d => {
      const bed = bedById(d, bedId)!
      const e = guard(deny(actor, 'bed.block', 'block beds'), outOfScope(actor, bed.siteId))
      if (e) return e
      if (!reason.trim()) return fail('A reason is required', 'You', 'Enter the reason')
      const T = today()
      const from = range.from || T
      if (range.to && range.to < from) return fail('The block ends before it starts')
      const startsNow = from <= T
      if (startsNow && bed.state === 'Occupied') return fail(`${bed.code} is occupied. Existing residents are flagged, never auto-moved`, 'Accommodation Admin', 'Transfer or check out the resident first, or schedule the block for later')
      ;(bed.blocks ??= []).push({ id: uid(d, 'BK'), from, to: range.to || undefined, reason, by: actor.name })
      if (startsNow) setBed(d, bed, 'Blocked', reason)
      const overlapping = d.reservations.filter(r => r.bedId === bed.id && r.status === 'Reserved' && r.from <= (range.to ?? '9999-12-31') && (r.to ?? '9999-12-31') >= from)
      if (overlapping.length) notify(d, { toRole: 'AA', text: `${bed.code} is blocked (${reason}). ${overlapping.length} reservation(s) overlap and need reallocation.` })
      log(d, actor, 'Bed blocked', `${bed.code}: ${reason} (${from} to ${range.to ?? 'further notice'})`)
      return ok(startsNow ? `${bed.code} blocked${overlapping.length ? `. ${overlapping.length} reservation(s) flagged for reallocation` : ''}` : `${bed.code} will be blocked from ${from}`)
    })
  },
  unblockBed(actor: Persona, bedId: string) {
    return run(d => {
      const bed = bedById(d, bedId)!
      const e = guard(deny(actor, 'bed.block', 'unblock beds'), outOfScope(actor, bed.siteId))
      if (e) return e
      const T = today()
      const yesterday = dateStr(Date.parse(T + 'T00:00:00Z') - 86400000)
      ;(bed.blocks ?? []).forEach(k => { if (k.from <= T && (!k.to || k.to >= T)) k.to = yesterday })
      if (bed.state === 'Blocked' || bed.state === 'UnderMaintenance') { setBed(d, bed, 'NeedsCleaning'); openCleaning(d, bed.id) }
      log(d, actor, 'Bed unblocked', `${bed.code} → Needs cleaning`)
      return ok(`${bed.code} unblocked. It needs cleaning and inspection before it's Available`)
    })
  },
}

/* scheduled blocks start and end by date */
registerTick(({ d, now, note, touch }) => {
  const T = dateStr(now)
  for (const bed of d.beds) {
    const active = (bed.blocks ?? []).some(k => k.from <= T && (!k.to || k.to >= T))
    if (active && bed.state !== 'Blocked' && bed.state !== 'Occupied' && bed.state !== 'UnderMaintenance' && bed.state !== 'Archived') {
      const k = bed.blocks!.find(x => x.from <= T && (!x.to || x.to >= T))!
      setBed(d, bed, 'Blocked', k.reason); touch()
    } else if (active && bed.state === 'Occupied') {
      note({ toRole: 'AA', text: `A scheduled block started on ${bed.code} but a resident is still there. They are flagged, not moved.`, dedupeKey: 'blkocc:' + bed.id })
    } else if (!active && bed.state === 'Blocked' && (bed.blocks ?? []).length > 0 && bed.blocks!.every(k => k.to && k.to < T)) {
      setBed(d, bed, 'NeedsCleaning'); openCleaning(d, bed.id); touch()
    }
  }
})
