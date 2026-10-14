/**
 * AT-036: the destination checks of a transfer and of a swap, table driven, across single-site, cross-site and both swap directions.
 * Every refusal names reason, owner and next action, and leaves the stays, their claims, both beds, the claims on them, the keys the
 * people hold and the cleaning tasks exactly as they were (a snapshot compared before and after), and a refused EXECUTION records
 * the failure (status failed, the reason, an audit row). Shipped state of every proposal (P-09 off, P-10 on).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import { mkItem } from '../fixtures3'
import { auditRows, claimRow, day, mkReservation, mkStay, person, residents, setBedState, setConfigValue, stayRow, transferRow, world } from './helpers'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { cross, twoStays, xreq } from './crossHelpers'

afterAll(closeAll)

const male = async (staffId: string): Promise<void> => { await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [staffId]) }
const female = async (staffId: string): Promise<void> => { await admin().query(`UPDATE staff_profile SET gender = 'female' WHERE id = $1`, [staffId]) }
const grade = async (staffId: string, g: number): Promise<void> => { await admin().query(`UPDATE staff_profile SET grade = $2 WHERE id = $1`, [staffId, g]) }
const left = async (staffId: string): Promise<void> => { await admin().query(`UPDATE staff_profile SET employment_status = 'left' WHERE id = $1`, [staffId]) }
const roomPolicy = async (siteId: string, p: 'female' | 'male'): Promise<void> => { await admin().query(`UPDATE room SET gender_policy = $2 WHERE site_id = $1`, [siteId, p]) }
const consent = { via: 'in_person' as const, note: null }
const none = { note: null }
const mkOffer = (bedId: string) => admin().query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'offer_hold', $2::daterange)`, [bedId, `[${day(1)},${day(60)})`])

interface Refusal { ok: boolean; code?: string; reason?: string; owner?: string; next?: string; detail?: unknown }
const complete = (r: Refusal) => !r.ok && !!r.reason && !!r.owner && !!r.next

async function snapshot(o: { stayIds: string[]; staffIds: string[]; bedIds: string[] }) {
  const q = async (sql: string, p: unknown[]) => (await admin().query(sql, p)).rows
  return {
    stays: await q(`SELECT id, bed_id, claim_id, status FROM stay WHERE id = ANY($1::uuid[]) ORDER BY id`, [o.stayIds]),
    stayClaims: await q(`SELECT id, released_at FROM bed_claim WHERE id IN (SELECT claim_id FROM stay WHERE id = ANY($1::uuid[])) ORDER BY id`, [o.stayIds]),
    beds: await q(`SELECT id, state FROM bed WHERE id = ANY($1::uuid[]) ORDER BY id`, [o.bedIds]),
    bedClaims: await q(`SELECT id, bed_id, kind, period::text FROM bed_claim WHERE bed_id = ANY($1::uuid[]) AND released_at IS NULL ORDER BY id`, [o.bedIds]),
    keys: await q(`SELECT id, status, holder_staff_id FROM handover_item WHERE holder_staff_id = ANY($1::uuid[]) ORDER BY id`, [o.staffIds]),
    keyEvents: await q(`SELECT count(*)::int AS n FROM handover_event WHERE item_id IN (SELECT id FROM handover_item WHERE holder_staff_id = ANY($1::uuid[]))`, [o.staffIds]),
    cleaning: await q(`SELECT count(*)::int AS n FROM cleaning_task WHERE bed_id = ANY($1::uuid[])`, [o.bedIds]),
  }
}

/* ============================== transfers ============================== */

type Mode = 'same-site transfer' | 'cross-site transfer'
interface TScene {
  stayId: string; staffId: string; srcBed: string; destBed: string; destSiteId: string
  request: () => ReturnType<typeof requestTransfer>
  approve: (id: string) => Promise<void>
  rec: Awaited<ReturnType<typeof person>>
}

async function transferScene(mode: Mode): Promise<TScene> {
  if (mode === 'same-site transfer') {
    const w = await world({ beds: 5 })
    const aa2 = await person('AA', { siteIds: [w.siteId] })
    const [res] = await residents(1)
    const s = await mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
    await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: res.staffId })
    return {
      stayId: s.stayId, staffId: res.staffId, srcBed: w.bedIds[0], destBed: w.bedIds[1], destSiteId: w.siteId,
      request: () => requestTransfer(res.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null }),
      approve: async id => { const r = await approveTransfer(aa2.rc, { id, destinationBedId: null, ...none }); if (!r.ok) throw new Error('approve: ' + r.reason) },
      rec: w.rec,
    }
  }
  const sc = await cross()
  await mkItem({ siteId: sc.src.siteId, bedId: sc.src.bedIds[0], holderStaffId: sc.res.staffId })
  return {
    stayId: sc.stayId, staffId: sc.res.staffId, srcBed: sc.src.bedIds[0], destBed: sc.dst.bedIds[1], destSiteId: sc.dst.siteId,
    request: () => requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1])),
    approve: async id => {
      const a = await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, ...none }); if (!a.ok) throw new Error('approve: ' + a.reason)
      const b = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId: null, ...none }); if (!b.ok) throw new Error('approve: ' + b.reason)
    },
    rec: sc.dst.rec,
  }
}

interface TCase {
  name: string
  when: 'early' | 'late'
  arrange: (s: TScene) => Promise<void>
  expect: Record<Mode, { at: 'request' | 'execute'; reason?: string }>
  owner: RegExp
  says: RegExp
  /** The error code of a refusal at the request (a bad field is `invalid`, a rule is `conflict`). */
  code?: 'invalid' | 'conflict'
}
const TCASES: TCase[] = [
  {
    name: 'gender: a male resident, a female-only destination room', when: 'early',
    arrange: async s => { await male(s.staffId); await admin().query(`UPDATE room SET gender_policy = 'female' WHERE id = (SELECT room_id FROM bed WHERE id = $1)`, [s.destBed]) },
    expect: { 'same-site transfer': { at: 'execute', reason: 'not_eligible' }, 'cross-site transfer': { at: 'request', reason: 'not_eligible' } },
    owner: /Policy Approver/, says: /female-only/,
  },
  {
    name: 'grade: below the minimum grade of the destination site (the source site\'s rules do not count)', when: 'early',
    arrange: async s => { await grade(s.staffId, 5); await setConfigValue('eligibility.min_grade', 6, s.destSiteId) },
    expect: { 'same-site transfer': { at: 'execute', reason: 'not_eligible' }, 'cross-site transfer': { at: 'request', reason: 'not_eligible' } },
    owner: /Policy Approver/, says: /needs grade 6\+/,
  },
  {
    name: 'left employee (never exceptionable)', when: 'late',
    arrange: async s => left(s.staffId),
    expect: { 'same-site transfer': { at: 'execute', reason: 'not_eligible' }, 'cross-site transfer': { at: 'execute', reason: 'not_eligible' } },
    owner: /Accommodation Admin/, says: /Employment status is Left/,
  },
  {
    name: 'archived destination bed', when: 'early',
    arrange: async s => { await admin().query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [s.destBed]) },
    expect: { 'same-site transfer': { at: 'request' }, 'cross-site transfer': { at: 'request' } },
    owner: /Accommodation Admin/, says: /archived/, code: 'invalid',
  },
  {
    name: 'blocked destination bed', when: 'late',
    arrange: async s => setBedState(s.destBed, 'blocked'),
    expect: { 'same-site transfer': { at: 'execute', reason: 'bed_unavailable' }, 'cross-site transfer': { at: 'execute', reason: 'bed_unavailable' } },
    owner: /Maintenance Coordinator/, says: /blocked/,
  },
  {
    name: 'destination bed under maintenance', when: 'late',
    arrange: async s => setBedState(s.destBed, 'under_maintenance'),
    expect: { 'same-site transfer': { at: 'execute', reason: 'bed_unavailable' }, 'cross-site transfer': { at: 'execute', reason: 'bed_unavailable' } },
    owner: /Maintenance Coordinator/, says: /under maintenance/,
  },
  {
    name: 'destination bed occupied by someone else', when: 'late',
    arrange: async s => { const [other] = await residents(1); await mkStay({ bedId: s.destBed, staffId: other.staffId, from: day(-1), to: day(50) }) },
    expect: { 'same-site transfer': { at: 'execute', reason: 'bed_taken' }, 'cross-site transfer': { at: 'execute', reason: 'bed_taken' } },
    owner: /Accommodation Admin/, says: /taken/,
  },
  {
    name: 'destination bed held by a bed offer', when: 'late',
    arrange: async s => { await mkOffer(s.destBed) },
    expect: { 'same-site transfer': { at: 'execute', reason: 'bed_held' }, 'cross-site transfer': { at: 'execute', reason: 'bed_held' } },
    owner: /offered resident/, says: /held by a bed offer/,
  },
  {
    name: 'destination bed still needs cleaning (check-in rule: an immediate move needs an Available bed)', when: 'late',
    arrange: async s => setBedState(s.destBed, 'needs_cleaning'),
    expect: { 'same-site transfer': { at: 'execute', reason: 'bed_not_ready' }, 'cross-site transfer': { at: 'execute', reason: 'bed_not_ready' } },
    owner: /Housekeeping/, says: /not ready/,
  },
  {
    name: 'destination bed waits for the final inspection', when: 'late',
    arrange: async s => setBedState(s.destBed, 'inspection_required'),
    expect: { 'same-site transfer': { at: 'execute', reason: 'bed_not_ready' }, 'cross-site transfer': { at: 'execute', reason: 'bed_not_ready' } },
    owner: /Housekeeping/, says: /not ready/,
  },
  {
    name: 'destination bed has a reservation that overlaps the rest of the stay', when: 'late',
    arrange: async s => { const [other] = await residents(1); await mkReservation({ bedId: s.destBed, staffId: other.staffId, from: day(2), to: day(9) }) },
    expect: { 'same-site transfer': { at: 'execute', reason: 'bed_taken' }, 'cross-site transfer': { at: 'execute', reason: 'bed_taken' } },
    owner: /Accommodation Admin/, says: /taken/,
  },
]

describe('AT-036 destination checks of a transfer, single-site and cross-site', () => {
  for (const mode of ['same-site transfer', 'cross-site transfer'] as const) {
    for (const k of TCASES) {
      it(`${mode}: ${k.name}`, async () => {
        const s = await transferScene(mode)
        const watch = { stayIds: [s.stayId], staffIds: [s.staffId], bedIds: [s.srcBed, s.destBed] }
        const want = k.expect[mode]
        if (k.when === 'early') await k.arrange(s)
        const pre = await snapshot(watch)
        const asked = await s.request()

        if (want.at === 'request') {
          expect(asked.ok).toBe(false)
          const r = asked as Refusal
          expect(complete(r)).toBe(true)
          expect(r.code).toBe(k.code ?? 'conflict')
          expect(r.owner).toMatch(k.owner)
          expect(r.reason).toMatch(k.says)
          if (want.reason) expect(r.detail).toMatchObject({ reason: want.reason })
          expect((await admin().query(`SELECT 1 FROM transfer_request WHERE stay_id = $1`, [s.stayId])).rowCount).toBe(0) // nothing stored
          expect(await snapshot(watch)).toEqual(pre)
          const stay = await stayRow(s.stayId)
          expect(stay).toMatchObject({ bed_id: s.srcBed, status: 'active' })
          expect((await claimRow(stay.claim_id)).released_at).toBeNull()
          expect((await admin().query(`SELECT count(*)::int AS n FROM handover_item WHERE holder_staff_id = $1 AND status = 'issued'`, [s.staffId])).rows[0].n).toBe(1)
          return
        }

        if (!asked.ok) throw new Error('request refused unexpectedly: ' + asked.reason)
        const id = asked.data.id
        await s.approve(id)
        expect((await transferRow(id)).status).toBe('approved') // both keys given while the destination was still fine, or a rule that is only judged at execution
        if (k.when === 'late') await k.arrange(s)
        const before = await snapshot(watch)
        const out = await executeTransfer(s.rec.rc, { id })
        expect(out.ok).toBe(false)
        expect(complete(out as Refusal)).toBe(true)
        if (out.ok) return
        expect(out.code).toBe('conflict')
        expect(out.detail).toMatchObject({ reason: want.reason, executionFailed: true })
        expect(out.owner).toMatch(k.owner)
        expect(out.reason).toMatch(k.says)
        expect(await snapshot(watch)).toEqual(before)
        const row = await transferRow(id)
        expect(row).toMatchObject({ status: 'failed', failure_count: 1, executed_at: null, new_claim_id: null })
        expect(row.failure_reason).toBe(out.reason)
        const actions = (await auditRows(id)).map(a => a.action)
        expect(actions).toContain('stays.transfer.failed')
        expect(actions).not.toContain('stays.transfer.executed')
        expect((await claimRow((await stayRow(s.stayId)).claim_id)).released_at).toBeNull()
      })
    }
  }

  it('cross-site: another site\'s rule is what counts. A strict SOURCE site does not hold the person back from a destination without that rule', async () => {
    const sc = await cross()
    await grade(sc.res.staffId, 5)
    await setConfigValue('eligibility.min_grade', 9, sc.src.siteId)
    const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, sc.dst.bedIds[1]))
    expect(r.ok).toBe(true)
  })
})

/* ============================== swaps ============================== */

type SMode = 'swap cross-site' | 'swap same-site'
interface Side { staffId: string; stayId: string; bed: string; siteId: string }
interface SScene {
  a: Side; b: Side
  request: () => ReturnType<typeof requestSwap>
  approveAll: (id: string) => Promise<void>
  rec: Awaited<ReturnType<typeof person>>
}

async function swapScene(mode: SMode): Promise<SScene> {
  if (mode === 'swap cross-site') {
    const sc = await twoStays()
    await mkItem({ siteId: sc.src.siteId, bedId: sc.src.bedIds[0], holderStaffId: sc.ra.staffId })
    await mkItem({ siteId: sc.dst.siteId, bedId: sc.dst.bedIds[0], holderStaffId: sc.rb.staffId })
    const rec = await person('Rec', { siteIds: [sc.src.siteId, sc.dst.siteId] })
    return {
      a: { staffId: sc.ra.staffId, stayId: sc.a.stayId, bed: sc.src.bedIds[0], siteId: sc.src.siteId },
      b: { staffId: sc.rb.staffId, stayId: sc.b.stayId, bed: sc.dst.bedIds[0], siteId: sc.dst.siteId },
      request: () => requestSwap(sc.src.aa.rc, { stayId: sc.a.stayId, otherStayId: sc.b.stayId, reason: 'Friends swap', neededBy: null, consentFirst: consent, consentSecond: consent }),
      approveAll: async id => {
        for (const who of [sc.srcAa2, sc.dstAa2]) { const r = await approveTransfer(who.rc, { id, destinationBedId: null, ...none }); if (!r.ok) throw new Error('approve: ' + r.reason) }
      },
      rec,
    }
  }
  const w = await world({ beds: 4 })
  const aa2 = await person('AA', { siteIds: [w.siteId] })
  const [ra, rb] = await residents(2)
  const a = await mkStay({ bedId: w.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
  const b = await mkStay({ bedId: w.bedIds[1], staffId: rb.staffId, from: day(-5), to: day(40) })
  await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: ra.staffId })
  await mkItem({ siteId: w.siteId, bedId: w.bedIds[1], holderStaffId: rb.staffId })
  return {
    a: { staffId: ra.staffId, stayId: a.stayId, bed: w.bedIds[0], siteId: w.siteId },
    b: { staffId: rb.staffId, stayId: b.stayId, bed: w.bedIds[1], siteId: w.siteId },
    request: () => requestSwap(w.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'Friends swap', neededBy: null, consentFirst: consent, consentSecond: consent }),
    approveAll: async id => { const r = await approveTransfer(aa2.rc, { id, destinationBedId: null, ...none }); if (!r.ok) throw new Error('approve: ' + r.reason) },
    rec: w.rec,
  }
}

type Dir = 'A moves into B\'s bed' | 'B moves into A\'s bed'
interface SCase {
  name: string
  dir: Dir
  when: 'early' | 'late'
  arrange: (s: SScene, mode: SMode) => Promise<void>
  expect: Record<SMode, { at: 'request' | 'approve' | 'execute'; reason: string }>
  owner: RegExp
  says: RegExp
}
const who = (s: SScene, d: Dir) => (d.startsWith('A') ? { mover: s.a, into: s.b, other: s.b } : { mover: s.b, into: s.a, other: s.a })

const SCASES: SCase[] = (['A moves into B\'s bed', 'B moves into A\'s bed'] as const).flatMap((dir): SCase[] => [
  {
    name: `gender: the mover is male, the room they would move into is female-only`, dir, when: 'early',
    arrange: async (s, mode) => {
      const { mover, into, other } = who(s, dir)
      await male(mover.staffId)
      if (mode === 'swap same-site') await female(other.staffId) // one shared room: only the male one fails
      await roomPolicy(into.siteId, 'female')
    },
    // same-site: the request is not pre-checked; the approval is held until the Policy Approver has decided (P-10 on); the swap is never executed
    expect: { 'swap cross-site': { at: 'request', reason: 'not_eligible' }, 'swap same-site': { at: 'approve', reason: 'waiting_for_exception' } },
    owner: /Policy Approver/, says: /female-only|waiting for a Policy Approver exception/,
  },
  {
    name: `grade: the mover is below the minimum grade of the site they would move into`, dir, when: 'early',
    arrange: async (s, mode) => {
      const { mover, into, other } = who(s, dir)
      await grade(mover.staffId, 5)
      if (mode === 'swap same-site') await grade(other.staffId, 9)
      await setConfigValue('eligibility.min_grade', 6, into.siteId)
    },
    expect: { 'swap cross-site': { at: 'request', reason: 'not_eligible' }, 'swap same-site': { at: 'approve', reason: 'waiting_for_exception' } },
    owner: /Policy Approver/, says: /needs grade 6\+|waiting for a Policy Approver exception/,
  },
  {
    name: `left employee (never exceptionable), after both approvals`, dir, when: 'late',
    arrange: async s => left(who(s, dir).mover.staffId),
    expect: { 'swap cross-site': { at: 'execute', reason: 'not_eligible' }, 'swap same-site': { at: 'execute', reason: 'not_eligible' } },
    owner: /Accommodation Admin/, says: /Employment status is Left/,
  },
  {
    name: `gender changed after both approvals`, dir, when: 'late',
    arrange: async (s, mode) => {
      const { mover, into, other } = who(s, dir)
      await male(mover.staffId)
      if (mode === 'swap same-site') await female(other.staffId)
      await roomPolicy(into.siteId, 'female')
    },
    expect: { 'swap cross-site': { at: 'execute', reason: 'not_eligible' }, 'swap same-site': { at: 'execute', reason: 'not_eligible' } },
    owner: /Policy Approver/, says: /female-only/,
  },
  {
    name: `grade rule introduced after both approvals`, dir, when: 'late',
    arrange: async (s, mode) => {
      const { mover, into, other } = who(s, dir)
      await grade(mover.staffId, 5)
      if (mode === 'swap same-site') await grade(other.staffId, 9)
      await setConfigValue('eligibility.min_grade', 6, into.siteId)
    },
    expect: { 'swap cross-site': { at: 'execute', reason: 'not_eligible' }, 'swap same-site': { at: 'execute', reason: 'not_eligible' } },
    owner: /Policy Approver/, says: /needs grade 6\+/,
  },
])

describe('AT-036 destination checks of a swap, single-site and cross-site, both directions', () => {
  for (const mode of ['swap cross-site', 'swap same-site'] as const) {
    for (const k of SCASES) {
      it(`${mode}, ${k.dir}: ${k.name}`, async () => {
        const s = await swapScene(mode)
        const watch = { stayIds: [s.a.stayId, s.b.stayId], staffIds: [s.a.staffId, s.b.staffId], bedIds: [s.a.bed, s.b.bed] }
        const want = k.expect[mode]
        if (k.when === 'early') await k.arrange(s, mode)
        const pre = await snapshot(watch)
        const asked = await s.request()

        if (want.at === 'request') {
          expect(asked.ok).toBe(false)
          const r = asked as Refusal
          expect(complete(r)).toBe(true)
          expect(r.detail).toMatchObject({ reason: want.reason })
          expect(r.owner).toMatch(k.owner)
          expect(r.reason).toMatch(k.says)
          expect((await admin().query(`SELECT 1 FROM transfer_request WHERE stay_id = ANY($1::uuid[])`, [[s.a.stayId, s.b.stayId]])).rowCount).toBe(0)
          expect(await snapshot(watch)).toEqual(pre)
          for (const side of [s.a, s.b]) expect((await stayRow(side.stayId)).bed_id).toBe(side.bed)
          return
        }
        if (!asked.ok) throw new Error('request refused unexpectedly: ' + asked.reason)
        const id = asked.data.id

        if (want.at === 'approve') {
          const before = await snapshot(watch)
          let refused: Refusal | undefined
          try { await s.approveAll(id) } catch (e) { refused = { ok: false, reason: (e as Error).message } }
          expect(refused, 'the approval is held back').toBeDefined()
          // the swap was never approved: nobody can execute it, and nothing changed
          const t = await transferRow(id)
          expect(t.status).toBe('requested')
          const direct = await approveTransfer((await person('AA', { siteIds: [s.a.siteId, s.b.siteId] })).rc, { id, destinationBedId: null, ...none })
          expect(complete(direct as Refusal)).toBe(true)
          expect(!direct.ok && direct.detail).toMatchObject({ reason: want.reason })
          expect(!direct.ok && direct.owner).toMatch(k.owner)
          expect(await snapshot(watch)).toEqual(before)
          const out = await executeTransfer(s.rec.rc, { id })
          expect(!out.ok && out.detail).toMatchObject({ reason: 'transfer_requested' }) // not approved, so not carried out
          expect(await snapshot(watch)).toEqual(before)
          return
        }

        await s.approveAll(id)
        expect((await transferRow(id)).status).toBe('approved')
        if (k.when === 'late') await k.arrange(s, mode)
        const before = await snapshot(watch)
        const out = await executeTransfer(s.rec.rc, { id })
        expect(out.ok).toBe(false)
        expect(complete(out as Refusal)).toBe(true)
        if (out.ok) return
        expect(out.detail).toMatchObject({ reason: want.reason, executionFailed: true })
        expect(out.owner).toMatch(k.owner)
        expect(out.reason).toMatch(k.says)
        expect(await snapshot(watch)).toEqual(before) // BOTH residents are where they were, both claims live, keys unchanged
        const row = await transferRow(id)
        expect(row).toMatchObject({ status: 'failed', failure_count: 1, executed_at: null, new_claim_id: null, other_new_claim_id: null })
        expect(row.failure_reason).toBe(out.reason)
        const actions = (await auditRows(id)).map(a => a.action)
        expect(actions).toContain('stays.swap.failed')
        expect(actions).not.toContain('stays.swap.executed')
        for (const side of [s.a, s.b]) {
          const stay = await stayRow(side.stayId)
          expect(stay.bed_id).toBe(side.bed)
          expect((await claimRow(stay.claim_id)).released_at).toBeNull()
        }
      })
    }
  }

  it('cross-site swap: the other site\'s rules are what count for each person, and a strict site does not hold back someone moving OUT of it', async () => {
    const s = await swapScene('swap cross-site')
    await grade(s.a.staffId, 5)
    await grade(s.b.staffId, 5)
    await setConfigValue('eligibility.min_grade', 9, s.a.siteId) // only B would move into the strict site
    const r = await s.request()
    expect(r.ok).toBe(false)
    expect(!r.ok && r.detail).toMatchObject({ reason: 'not_eligible', failed: ['grade'] })
    expect(!r.ok && r.reason).toMatch(/needs grade 9\+/)
  })

  it('cross-site swap: the destination site archived after both approvals fails safely with the reason, and both residents stay put', async () => {
    const s = await swapScene('swap cross-site')
    const r = await s.request()
    if (!r.ok) throw new Error(r.reason)
    await s.approveAll(r.data.id)
    await admin().query(`UPDATE site SET archived_at = now() WHERE id = $1`, [s.b.siteId])
    const before = await snapshot({ stayIds: [s.a.stayId, s.b.stayId], staffIds: [s.a.staffId, s.b.staffId], bedIds: [s.a.bed, s.b.bed] })
    const out = await executeTransfer(s.rec.rc, { id: r.data.id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'site_archived', executionFailed: true })
    expect(complete(out as Refusal)).toBe(true)
    expect(await snapshot({ stayIds: [s.a.stayId, s.b.stayId], staffIds: [s.a.staffId, s.b.staffId], bedIds: [s.a.bed, s.b.bed] })).toEqual(before)
  })

  it('a swap whose destination beds are occupied by each other is the normal case; one stay ended after approval makes it stale and nobody moves', async () => {
    const s = await swapScene('swap same-site')
    const r = await s.request()
    if (!r.ok) throw new Error(r.reason)
    await s.approveAll(r.data.id)
    await admin().query(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1`, [s.b.stayId])
    const out = await executeTransfer(s.rec.rc, { id: r.data.id })
    expect(!out.ok && out.detail).toMatchObject({ reason: 'stale', executionFailed: true })
    expect(complete(out as Refusal)).toBe(true)
    expect((await stayRow(s.a.stayId)).bed_id).toBe(s.a.bed)
  })
})
