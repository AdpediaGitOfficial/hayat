import { afterAll, describe, expect, it } from 'vitest'
import { closeAll } from '../harness'
import {
  as, auditRows, claimRow, day, DAY_MS, liveClaims, mkReservation, mkStay, newClock, notificationsFor, person, residents, stayRow, transferRow, world,
} from './helpers'
import { approveExtension, rejectExtension, requestExtension } from '@/server/commands/stays/extension'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestTransfer } from '@/server/commands/stays/requestTransfer'
import { listPendingRequests } from '@/server/queries/stays/transfers'
import { admin } from '../harness'

afterAll(closeAll)

const ask = (stayId: string, newEnd: string, reason: string | null = null) => ({ stayId, newEnd, reason })
const ok = (id: string, note: string | null = null) => ({ id, note })

async function scene() {
  const w = await world({ beds: 4 })
  const aa2 = await person('AA', { siteIds: [w.siteId] })
  const [res] = await residents(1)
  const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
  return { ...w, aa2, res, ...s }
}

describe('extension within policy (D-57)', () => {
  it('the resident asks, an Accommodation Admin approves, and the stay\'s claim now ends on the new day', async () => {
    const sc = await scene()
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(45)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({ status: 'requested', addedDays: 15, beyondPolicy: false, route: 'accommodation_admin', clash: null, transferSuggestion: null })
    // a request alone changes nothing
    expect((await liveClaims(sc.bedIds[0]))[0].period).toBe(`[${day(-5)},${day(30)})`)

    const approved = await approveExtension(sc.aa.rc, ok(r.data.id))
    expect(approved.ok).toBe(true)
    expect((await liveClaims(sc.bedIds[0]))[0].period).toBe(`[${day(-5)},${day(45)})`)
    expect((await stayRow(sc.stayId)).status).toBe('active')
    expect((await auditRows(r.data.id)).map(a => a.action)).toEqual(['stays.extension.requested', 'stays.extension.approved'])
    expect((await notificationsFor(sc.stayId)).map(n => n.kind)).toContain('extension.approved')
  })

  it('validates the dates: after the current end, not in the past, and an open-ended stay has nothing to extend', async () => {
    const sc = await scene()
    const same = await requestExtension(sc.res.rc, ask(sc.stayId, day(30)))
    expect(!same.ok && same.fields).toHaveProperty('newEnd')
    const open = await mkStay({ bedId: sc.bedIds[1], staffId: (await residents(1))[0].staffId, from: day(-1), to: null })
    const openRes = await person('AA', { siteIds: [sc.siteId] })
    const r = await requestExtension(openRes.rc, ask(open.stayId, day(60)))
    expect(!r.ok && r.detail).toMatchObject({ reason: 'open_ended' })
  })

  it('rejecting needs a reason and leaves the end date alone', async () => {
    const sc = await scene()
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(40)))
    if (!r.ok) throw new Error('setup')
    const rej = await rejectExtension(sc.aa.rc, { id: r.data.id, reason: 'Needed for incoming trainees' })
    expect(rej.ok).toBe(true)
    expect((await liveClaims(sc.bedIds[0]))[0].period).toBe(`[${day(-5)},${day(30)})`)
    const twice = await approveExtension(sc.aa.rc, ok(r.data.id))
    expect(!twice.ok && twice.code).toBe('conflict')
  })

  it('same-day turnover: a booking that starts on the NEW end day does not clash; one that starts on the current end day does', async () => {
    const a = await scene()
    await mkReservation({ bedId: a.bedIds[0], staffId: (await residents(1))[0].staffId, from: day(45), to: day(60) })
    const fine = await requestExtension(a.res.rc, ask(a.stayId, day(45)))
    expect(fine.ok && fine.data.clash).toBeNull()
    expect((await approveExtension(a.aa.rc, ok(fine.ok ? fine.data.id : ''))).ok).toBe(true)

    const b = await scene()
    await mkReservation({ bedId: b.bedIds[0], staffId: (await residents(1))[0].staffId, from: day(30), to: day(40) })
    const clash = await requestExtension(b.res.rc, ask(b.stayId, day(35)))
    expect(clash.ok && clash.data.clash).not.toBeNull()
  })
})

describe('extension beyond policy: the Policy Approver, with a reason', () => {
  it('needs a reason; an Accommodation Admin cannot approve it; a Policy Approver can', async () => {
    const sc = await scene()
    const far = day(30 + 120)
    const noReason = await requestExtension(sc.res.rc, ask(sc.stayId, far))
    expect(!noReason.ok && noReason.fields).toHaveProperty('reason')
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, far, 'Long project assignment'))
    expect(r.ok && r.data).toMatchObject({ beyondPolicy: true, route: 'policy_approver' })
    if (!r.ok) return
    expect((await notificationsFor(r.data.id)).find(n => n.kind === 'extension.requested')?.to_role).toBe('PolicyApprover')

    const aa = await approveExtension(sc.aa.rc, ok(r.data.id))
    expect(!aa.ok && aa.code).toBe('forbidden')
    expect((await liveClaims(sc.bedIds[0]))[0].period).toBe(`[${day(-5)},${day(30)})`)

    const pa = await person('AA', { siteIds: [sc.siteId], caps: ['PolicyApprover'] })
    const decided = await approveExtension(pa.rc, ok(r.data.id, 'Approved for the project'))
    expect(decided.ok).toBe(true)
    expect((await liveClaims(sc.bedIds[0]))[0].period).toBe(`[${day(-5)},${day(150)})`)
  })

  it('a Policy Approver of another site cannot see it (404)', async () => {
    const sc = await scene()
    const other = await world({ beds: 1 })
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(200), 'x project'))
    if (!r.ok) throw new Error('setup')
    const pa = await person('AA', { siteIds: [other.siteId], caps: ['PolicyApprover'] })
    const out = await approveExtension(pa.rc, ok(r.data.id))
    expect(!out.ok && out.code).toBe('not_found')
  })

  it('the backup approver may decide an item only after it was routed to the backup level (2 business days); never before', async () => {
    const clock = newClock()
    const w = await world({ beds: 2 })
    const [res] = await residents(1)
    const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
    const r = await requestExtension(as(res, 'Res', { clock }).rc, ask(s.stayId, day(40)))
    if (!r.ok) throw new Error('setup')
    const backup = await person('Rec', { siteIds: [w.siteId], caps: ['BackupApprover'], clock })
    const early = await approveExtension(backup.rc, ok(r.data.id))
    expect(!early.ok && early.code).toBe('forbidden')
    expect(!early.ok && early.reason).toMatch(/waiting for the Accommodation Admin/)
    clock.advance(2 * DAY_MS) // Wed 14 Oct to Fri 16 Oct: two business days
    const late = await approveExtension(backup.rc, ok(r.data.id))
    expect(late.ok).toBe(true)
  })
})

describe('extension: separation of duties (D-26)', () => {
  it('nobody approves an extension for their own stay or one they raised', async () => {
    const sc = await scene()
    const asAdmin = await requestExtension(sc.aa.rc, ask(sc.stayId, day(40)))
    if (!asAdmin.ok) throw new Error('setup')
    const self = await approveExtension(sc.aa.rc, ok(asAdmin.data.id))
    expect(!self.ok && self.code).toBe('separation_of_duties')
    // the resident, in an Accommodation Admin session, is still the person it is about
    const dual = as(sc.res, 'AA', { siteIds: [sc.siteId] })
    const own = await approveExtension(dual.rc, ok(asAdmin.data.id))
    expect(!own.ok && own.code).toBe('separation_of_duties')
    const reject = await rejectExtension(dual.rc, { id: asAdmin.data.id, reason: 'no thanks' })
    expect(!reject.ok && reject.code).toBe('separation_of_duties')
    expect((await approveExtension(sc.aa2.rc, ok(asAdmin.data.id))).ok).toBe(true)
  })

  it('a resident cannot approve, and cannot ask for someone else\'s stay', async () => {
    const sc = await scene()
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(40)))
    if (!r.ok) throw new Error('setup')
    const [other] = await residents(1)
    expect((await approveExtension(sc.res.rc, ok(r.data.id))).ok).toBe(false)
    const foreign = await requestExtension(other.rc, ask(sc.stayId, day(50)))
    expect(!foreign.ok && foreign.code).toBe('not_found')
  })

  it('Reception cannot decide an extension', async () => {
    const sc = await scene()
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(40)))
    if (!r.ok) throw new Error('setup')
    const out = await approveExtension(sc.rec.rc, ok(r.data.id))
    expect(!out.ok && out.code).toBe('forbidden')
  })
})

describe('extension clash: offer a transfer instead of rejecting (D-57)', () => {
  it('keeps the request, suggests beds that are free for the whole stay, refuses the approval on the clashing bed, and works after the transfer', async () => {
    const sc = await scene()
    const other = (await residents(1))[0]
    await mkReservation({ bedId: sc.bedIds[0], staffId: other.staffId, from: day(32), to: day(60) })
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(45)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.clash).toMatchObject({ reason: 'next_booking' })
    expect(r.data.clash?.conflicts[0]).toMatchObject({ kind: 'reservation', from: day(32) })
    expect(r.data.transferSuggestion?.stayId).toBe(sc.stayId)
    const suggested = r.data.transferSuggestion!.beds.map(b => b.bedId)
    expect(suggested.length).toBeGreaterThan(0)
    expect(suggested).not.toContain(sc.bedIds[0])

    // the approval is refused on this bed, with the next action: open a transfer
    const blocked = await approveExtension(sc.aa2.rc, ok(r.data.id))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) { expect(blocked.detail).toMatchObject({ reason: 'bed_clash' }); expect(blocked.next).toMatch(/transfer/i) }
    expect((await liveClaims(sc.bedIds[0])).find(c => c.kind === 'stay')?.period).toBe(`[${day(-5)},${day(30)})`)

    // the Accommodation Admin opens the suggested transfer, linked to the extension
    const t = await requestTransfer(sc.aa.rc, { stayId: sc.stayId, destinationBedId: suggested[0], reason: 'Next booking on this bed', neededBy: null, linkedExtensionId: r.data.id })
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect((await transferRow(t.data.id)).linked_extension_id).toBe(r.data.id)
    expect((await approveTransfer(sc.aa2.rc, { id: t.data.id, destinationBedId: null, note: null })).ok).toBe(true)
    expect((await executeTransfer(sc.rec.rc, { id: t.data.id })).ok).toBe(true)

    // now the extension can be approved, on the new bed
    const done = await approveExtension(sc.aa2.rc, ok(r.data.id))
    expect(done.ok).toBe(true)
    const s = await stayRow(sc.stayId)
    expect(s.bed_id).toBe(suggested[0])
    expect((await claimRow(s.claim_id)).period).toBe(`[${day(0)},${day(45)})`)
  })

  it('a clash found only at approval time (a booking made after the request) is refused with the same help and changes nothing', async () => {
    const sc = await scene()
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(40)))
    if (!r.ok) throw new Error('setup')
    expect(r.data.clash).toBeNull()
    await mkReservation({ bedId: sc.bedIds[0], staffId: (await residents(1))[0].staffId, from: day(35), to: day(50) })
    const out = await approveExtension(sc.aa.rc, ok(r.data.id))
    expect(!out.ok && out.detail).toMatchObject({ reason: 'bed_clash' })
    expect((await liveClaims(sc.bedIds[0])).find(c => c.kind === 'stay')?.period).toBe(`[${day(-5)},${day(30)})`)
    expect(await admin().query(`SELECT status FROM extension_request WHERE id = $1`, [r.data.id]).then(q => q.rows[0].status)).toBe('requested')
  })

  it('a request is stale if the end date changed in the meantime', async () => {
    const sc = await scene()
    const r1 = await requestExtension(sc.res.rc, ask(sc.stayId, day(40)))
    if (!r1.ok) throw new Error('setup')
    await admin().query(`UPDATE bed_claim SET period = $2::daterange WHERE id = $1`, [sc.claimId, `[${day(-5)},${day(33)})`])
    const out = await approveExtension(sc.aa.rc, ok(r1.data.id))
    expect(!out.ok && out.detail).toMatchObject({ reason: 'stale' })
  })

  it('approving the same extension twice at once extends once', async () => {
    const sc = await scene()
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(40)))
    if (!r.ok) throw new Error('setup')
    const results = await Promise.all([approveExtension(sc.aa.rc, ok(r.data.id)), approveExtension(sc.aa2.rc, ok(r.data.id))])
    expect(results.filter(x => x.ok)).toHaveLength(1)
    expect((await auditRows(r.data.id)).filter(a => a.action === 'stays.extension.approved')).toHaveLength(1)
  })
})

describe('extension requests in the staff worklists', () => {
  it('open extensions appear for the site\'s Accommodation Admin with the clash, and not for another site', async () => {
    const sc = await scene()
    const other = await world({ beds: 1 })
    await mkReservation({ bedId: sc.bedIds[0], staffId: (await residents(1))[0].staffId, from: day(31), to: day(60) })
    const r = await requestExtension(sc.res.rc, ask(sc.stayId, day(45)))
    if (!r.ok) throw new Error('setup')
    const mine = await listPendingRequests(sc.aa.rc.actor)
    expect(mine.extensions.find(e => e.id === r.data.id)).toMatchObject({ canDecide: true, clash: { reason: 'next_booking' } })
    const theirs = await listPendingRequests(other.aa.rc.actor)
    expect(theirs.extensions.find(e => e.id === r.data.id)).toBeUndefined()
  })
})
