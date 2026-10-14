/**
 * Hardening round, WP-N, S-22 (AT-037), the SHIPPED state of each proposal (the other states, which change global settings, are in
 * hardening-flags.test.ts on a private database):
 *   P-13 offers on beds that are not ready: ON, lead time 1 day   (proposed, pending client sign-off; aligns with AT-021 and SPEC-AMENDMENTS C-6)
 *   P-14 a cleaning task opened by hand for a bed with no record: ON (proposed, pending client sign-off)
 * plus the generic helper Stage 4 will call (markBedNeedsWork), the housekeeper picker, and the readiness rule across every workflow.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll, grantCapability, makeUser, call } from '../harness'
import { rcFor } from '../rc'
import { mkReservation, mkStay as mkStayRaw } from '../stays/helpers'
import { auditActions, bedRow, cleaningTasks, day, FULL, housekeeper, inspector, mkProperty, mkStaff, newClock, NOW, scene, setBedState, staffAt, taskRow, vacate } from './helpers'
import { getDb } from '@/server/db/client'
import { assignCleaning } from '@/server/commands/readiness/assign'
import { completeCleaning } from '@/server/commands/readiness/clean'
import { passInspection } from '@/server/commands/readiness/inspect'
import { manualInput, NO_RECORD_NOTE, openCleaningTaskManual } from '@/server/commands/readiness/manual'
import { markBedNeedsWork } from '@/server/readiness/work'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { createOffer, offerToNext } from '@/server/commands/waitlist/offer'
import { acceptOffer } from '@/server/commands/waitlist/respond'
import { matchFreedBed, notifyFreedBed } from '@/server/commands/waitlist/queue'
import { offerCandidates } from '@/server/queries/waitlist/queue'
import { readinessBoard } from '@/server/queries/readiness/board'
import { listHousekeepers, RECENT_DAYS } from '@/server/queries/readiness/housekeepers'
import { checkIn, bulkCheckIn } from '@/server/commands/stays/checkIn'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { approveRequest } from '@/server/commands/requests/approve'
import { previewBulkAllocation, confirmBulkAllocation } from '@/server/commands/allocation-admin/bulk'
import { requestTransfer } from '@/server/commands/stays/requestTransfer'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { mkRequest } from '../fixtures2'
import { person, residents, world } from '../stays/helpers'
import { POST as openTaskRoute } from '../../../app/api/v1/readiness/beds/[id]/open-task/route'

afterAll(closeAll)

const STATES = ['available', 'needs_cleaning', 'inspection_required', 'blocked', 'under_maintenance', 'occupied'] as const
type State = (typeof STATES)[number]
const NOT_READY = ['needs_cleaning', 'inspection_required', 'occupied'] as const
const OWNER: Record<string, RegExp> = { needs_cleaning: /Housekeeping/, inspection_required: /Final Inspection holder/, occupied: /Reception/ }

/** Puts a bed into the state. `occupied` gets a resident whose stay ends today, so a hold from today does not overlap it but the bed is still occupied. */
async function arm(bedId: string, state: State) {
  if (state === 'available') return
  if (state === 'occupied') { const o = await mkStaff(); await mkStayRaw({ bedId, staffId: o.id, from: day(-5), to: day(0) }); return }
  await setBedState(bedId, state)
}

/** One site with Reception and an Accommodation Admin, one bed in the state, one waitlisted person who wants it from `n` days from today. */
async function offerRig(state: State, n: number, waiting?: { id: string }) {
  const p = await mkProperty({ beds: 1 })
  const rec = await staffAt('Rec', p.siteId), aa = await staffAt('AA', p.siteId)
  const who = waiting ?? await mkStaff()
  const wl = await addToWaitlist(rec.rc, { staffId: who.id, siteId: p.siteId, arrival: day(n), end: day(n + 30) })
  if (!wl.ok) throw new Error('waitlist: ' + wl.reason)
  await arm(p.bedIds[0], state)
  return { ...p, rec, aa, who, bedId: p.bedIds[0], entryId: wl.data.entryId }
}
const holds = async (bedId: string) => (await admin().query(`SELECT 1 FROM bed_claim WHERE bed_id = $1 AND released_at IS NULL AND kind = 'offer_hold'`, [bedId])).rowCount
const offers = async (bedId: string) => (await admin().query(`SELECT 1 FROM bed_offer WHERE bed_id = $1`, [bedId])).rowCount
const complete = (r: { ok: boolean; reason?: string; owner?: string; next?: string }) => !r.ok && !!r.reason && !!r.owner && !!r.next

/* ====================================================================== P-13 ====================================================================== */

describe('AT-037 P-13 (proposed, pending client sign-off): offers on beds that are not ready, lead time 1 day as shipped', () => {
  for (const state of STATES) {
    for (const n of [0, 1, 2] as const) {
      const label = n === 0 ? 'starting today (before the boundary)' : n === 1 ? 'starting tomorrow (at the boundary)' : 'starting the day after tomorrow (after it)'
      it(`createOffer on a bed that is ${state.replace('_', ' ')}, ${label}`, async () => {
        const rig = await offerRig(state, n)
        const out = await createOffer(rig.aa.rc, { entryId: rig.entryId, bedId: rig.bedId })
        const refusedByRule = (NOT_READY as readonly string[]).includes(state) && n === 0
        const unavailable = state === 'blocked' || state === 'under_maintenance'
        if (!refusedByRule && !unavailable) {
          expect(out.ok, JSON.stringify(out)).toBe(true)
          expect(await holds(rig.bedId)).toBe(1)
          return
        }
        expect(out.ok).toBe(false)
        expect(complete(out)).toBe(true)
        if (out.ok) return
        expect(out.code).toBe('conflict')
        if (unavailable) {
          expect(out.detail).toMatchObject({ reason: 'bed_unavailable' })
          expect(out.owner).toBe('Maintenance Coordinator')
        } else {
          expect(out.detail).toMatchObject({ reason: 'bed_not_ready', state, from: day(0), earliest: day(1), leadDays: 1, proposal: 'P-13' })
          expect(out.owner).toMatch(OWNER[state])
          expect(out.next).toMatch(/later date|wait for/i)
          expect(out.reason).toMatch(/proposed policy, pending client sign-off/)
        }
        // a refusal leaves nothing: no hold, no offer, the person keeps waiting, nobody is told
        expect(await holds(rig.bedId)).toBe(0)
        expect(await offers(rig.bedId)).toBe(0)
        expect((await admin().query(`SELECT status FROM waitlist_entry WHERE id = $1`, [rig.entryId])).rows[0].status).toBe('waiting')
        expect((await admin().query(`SELECT 1 FROM notification WHERE ref_type = 'bed_offer' AND to_staff_id = $1`, [rig.who.id])).rowCount).toBe(0)
        expect((await bedRow(rig.bedId)).state).toBe(state === 'occupied' ? 'occupied' : state)
      })
    }
  }

  for (const state of ['available', 'needs_cleaning', 'inspection_required', 'occupied'] as const) {
    for (const n of [0, 1] as const) {
      it(`offerToNext ("offer to the next in the queue") on a bed that is ${state.replace('_', ' ')}, starting ${n === 0 ? 'today' : 'tomorrow'}`, async () => {
        const rig = await offerRig(state, n)
        const out = await offerToNext(rig.aa.rc, { bedId: rig.bedId })
        if (state === 'available' || n === 1) {
          expect(out.ok, JSON.stringify(out)).toBe(true)
          expect(out.ok && out.data.created).toBe(true)
          return
        }
        expect(complete(out)).toBe(true)
        expect(!out.ok && out.detail).toMatchObject({ reason: 'bed_not_ready', state, proposal: 'P-13' })
        expect(!out.ok && out.owner).toMatch(OWNER[state])
        expect(await holds(rig.bedId)).toBe(0)
      })
    }
  }

  it('a freed bed that is not ready is shown with the reason: the match carries it, the notice says it, the list of beds for a person marks it; a ready bed or a later start carries none', async () => {
    const rig = await offerRig('needs_cleaning', 0)
    const now = newClock().now()
    const match = await matchFreedBed(getDb(), rig.bedId, now)
    expect(match?.entryId).toBe(rig.entryId)
    expect(match?.notReady).toMatchObject({ owner: 'Housekeeping' })
    expect(match?.notReady?.reason).toMatch(/needs cleaning.*cannot be offered from/)
    const told = await getDb().transaction(tx => notifyFreedBed(tx, rig.bedId, now, 'at037-freed'))
    expect(told).toBe(true)
    const note = (await admin().query(`SELECT text FROM notification WHERE dedupe_key = $1`, [`waitlist:bed:${rig.bedId}:at037-freed:next`])).rows[0].text as string
    expect(note).toMatch(/not ready yet/)
    expect(note).toMatch(/Owner: Housekeeping/)
    expect(note).toMatch(/Next: Offer it for a later date/)

    const cands = await offerCandidates(getDb(), rig.aa.rc.actor, rig.entryId, now)
    expect(cands?.find(c => c.bedId === rig.bedId)?.blocked).toMatchObject({ owner: 'Housekeeping' })

    const later = await offerRig('needs_cleaning', 2)
    expect((await matchFreedBed(getDb(), later.bedId, now))?.notReady).toBeUndefined()
    expect((await offerCandidates(getDb(), later.aa.rc.actor, later.entryId, now))?.find(c => c.bedId === later.bedId)?.blocked).toBeNull()
    const ready = await offerRig('available', 0)
    expect((await matchFreedBed(getDb(), ready.bedId, now))?.notReady).toBeUndefined()
  })

  it('a hold for tomorrow on a bed that is not ready is accepted into a reservation, which is NOT a check-in: the bed stays as it is, no stay exists', async () => {
    const account = await makeUser({ roles: [{ role: 'Res' }] })
    const rig = await offerRig('needs_cleaning', 1, { id: account.staffId })
    expect((await createOffer(rig.aa.rc, { entryId: rig.entryId, bedId: rig.bedId })).ok).toBe(true)
    const offer = (await admin().query<{ id: string }>(`SELECT id FROM bed_offer WHERE bed_id = $1`, [rig.bedId])).rows[0].id
    const accepted = await acceptOffer(rcFor(account.id, { role: 'Res', sites: [], caps: [], staffId: account.staffId }, newClock()), { offerId: offer })
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true)
    expect((await admin().query(`SELECT status FROM reservation WHERE bed_id = $1`, [rig.bedId])).rows[0].status).toBe('reserved')
    expect((await admin().query(`SELECT 1 FROM stay WHERE staff_id = $1`, [account.staffId])).rowCount).toBe(0)
    expect((await bedRow(rig.bedId)).state).toBe('needs_cleaning')
  })
})

describe('AT-021 / AT-037 end to end: checkout makes the bed not ready; it is not offered inside the lead time, not checked into, and only a passed inspection by someone else makes it Available', () => {
  it('real checkout, real cleaning, real inspection', async () => {
    const s = await scene({ beds: 1 })
    const aa = await staffAt('AA', s.siteId)
    const bedId = s.bedIds[0]
    const waiting = await mkStaff()
    const wl = await addToWaitlist(s.rec.rc, { staffId: waiting.id, siteId: s.siteId, arrival: day(0), end: day(60) })
    if (!wl.ok) throw new Error(wl.reason)

    // 1. checkout opens exactly one task and the bed Needs cleaning
    const { taskId } = await vacate(s, bedId)
    expect((await bedRow(bedId)).state).toBe('needs_cleaning')
    expect((await cleaningTasks(bedId)).map(t => t.status)).toEqual(['open'])

    // 2. not offered (start today), not checked into
    const early = await createOffer(aa.rc, { entryId: wl.data.entryId, bedId })
    expect(complete(early)).toBe(true)
    expect(!early.ok && early.detail).toMatchObject({ reason: 'bed_not_ready', state: 'needs_cleaning' })
    const guest = await mkStaff()
    const rv = await mkReservation({ bedId, staffId: guest.id, from: day(0), to: day(10) })
    const blocked = await checkIn(s.rec.rc, { reservationId: rv.reservationId })
    expect(!blocked.ok && blocked.detail).toMatchObject({ reason: 'bed_not_ready', state: 'needs_cleaning' })

    // 3. cleaned: still not offered, still not checked into
    await assignCleaning(s.rec.rc, { taskId, housekeeperStaffId: s.hk.staffId, note: null })
    expect((await completeCleaning(s.hk.rc, { taskId, checklist: FULL, notes: null })).ok).toBe(true)
    expect((await bedRow(bedId)).state).toBe('inspection_required')
    const stillEarly = await createOffer(aa.rc, { entryId: wl.data.entryId, bedId })
    expect(!stillEarly.ok && stillEarly.detail).toMatchObject({ reason: 'bed_not_ready', state: 'inspection_required' })
    expect(!stillEarly.ok && stillEarly.owner).toMatch(/Final Inspection holder/)
    expect((await checkIn(s.rec.rc, { reservationId: rv.reservationId })).ok).toBe(false)

    // 4. the cleaner cannot inspect their own work; a different inspector passes it
    const cleanerInspector = await inspector(s.siteId)
    await admin().query(`UPDATE cleaning_task SET cleaned_by_staff = $2 WHERE id = $1`, [taskId, cleanerInspector.staffId]) // pretend this inspector cleaned it
    const own = await passInspection(cleanerInspector.rc, { taskId, note: null })
    expect(!own.ok && own.code).toBe('separation_of_duties')
    expect((await bedRow(bedId)).state).toBe('inspection_required')
    await admin().query(`UPDATE cleaning_task SET cleaned_by_staff = $2 WHERE id = $1`, [taskId, s.hk.staffId])
    expect((await passInspection(s.insp.rc, { taskId, note: null })).ok).toBe(true)
    expect((await bedRow(bedId)).state).toBe('available')

    // 5. now it can be checked into (and, with nothing booked on it, offered: see the Available rows of the matrix)
    expect((await checkIn(s.rec.rc, { reservationId: rv.reservationId })).ok).toBe(true)
    void aa
  })
})

/* ====================================================================== P-14 ====================================================================== */

describe('AT-037 P-14 (proposed, pending client sign-off): a cleaning task opened by hand for a bed with no record', () => {
  async function noRecord(state: 'needs_cleaning' | 'inspection_required') {
    const s = await scene({ beds: 1 })
    await setBedState(s.bedIds[0], state)
    expect(await cleaningTasks(s.bedIds[0])).toHaveLength(0)
    return { s, bedId: s.bedIds[0] }
  }

  it('Needs cleaning: a normal open task, assigned and cleaned like any other; audited with the reason; Reception is told; the bed stays Needs cleaning', async () => {
    const { s, bedId } = await noRecord('needs_cleaning')
    const out = await openCleaningTaskManual(s.rec.rc, { bedId, reason: 'Migrated from the old spreadsheet, no cleaning task exists' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    if (!out.ok) return
    expect(out.data).toMatchObject({ bedState: 'needs_cleaning', taskStatus: 'open' })
    const row = await taskRow(out.data.taskId)
    expect(row).toMatchObject({ status: 'open', cleaned_by_staff: null, assigned_to_staff: null })
    expect(row.reason).toBe('Opened by hand: Migrated from the old spreadsheet, no cleaning task exists')
    expect((await bedRow(bedId)).state).toBe('needs_cleaning')
    const a = (await admin().query(`SELECT action, actor_role, reason, after FROM audit_event WHERE entity_id = $1 AND action = 'readiness.cleaning.opened_manually'`, [out.data.taskId])).rows
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ actor_role: 'Rec', reason: 'Migrated from the old spreadsheet, no cleaning task exists' })
    expect(a[0].after).toMatchObject({ bed: 'needs_cleaning', task: 'open', proposal: 'P-14, pending client sign-off' })
    // from here on it is the normal path
    expect((await assignCleaning(s.rec.rc, { taskId: out.data.taskId, housekeeperStaffId: s.hk.staffId, note: null })).ok).toBe(true)
    expect((await completeCleaning(s.hk.rc, { taskId: out.data.taskId, checklist: FULL, notes: null })).ok).toBe(true)
    expect((await passInspection(s.insp.rc, { taskId: out.data.taskId, note: null })).ok).toBe(true)
    expect((await bedRow(bedId)).state).toBe('available')
  })

  it('Inspection required: the task is created already cleaned, with the "no cleaning record" note and NO cleaner; the final inspection can proceed; the opener cannot inspect it', async () => {
    const { s, bedId } = await noRecord('inspection_required')
    const out = await openCleaningTaskManual(s.sa.rc, { bedId, reason: 'Seeded as inspection required, nobody cleaned it' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    if (!out.ok) return
    expect(out.data).toMatchObject({ bedState: 'inspection_required', taskStatus: 'cleaned' })
    const row = await taskRow(out.data.taskId)
    expect(row).toMatchObject({ status: 'cleaned', cleaned_by_staff: null, assigned_to_staff: null, inspected_by_staff: null })
    expect(row.checklist).toMatchObject({ version: 1, notes: NO_RECORD_NOTE, issue: false, lines: [], attachmentIds: [] })
    expect(NO_RECORD_NOTE).toBe('Readiness restored without a cleaning record (migrated or seeded data)')
    expect((await bedRow(bedId)).state).toBe('inspection_required')
    expect((await auditActions(out.data.taskId)).map(a => a.action)).toContain('readiness.cleaning.opened_manually')
    expect((await admin().query(`SELECT to_role, text FROM notification WHERE dedupe_key = $1`, [`cleaning:${out.data.taskId}:cleaned`])).rows[0]).toMatchObject({ to_role: 'FinalInspection' })

    // the Super Admin who vouched for the room is not the one who inspects it, even holding the capability
    const sameHands = rcFor(s.sa.userId, { role: 'SA', sites: 'all', caps: ['FinalInspection'], staffId: s.sa.staffId }, newClock())
    const own = await passInspection(sameHands, { taskId: out.data.taskId, note: null })
    expect(!own.ok && own.code).toBe('separation_of_duties')
    expect((await bedRow(bedId)).state).toBe('inspection_required')

    // an independent inspector passes it; no cleaner is recorded, and the database check is not tripped
    const done = await passInspection(s.insp.rc, { taskId: out.data.taskId, note: null })
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect(await taskRow(out.data.taskId)).toMatchObject({ status: 'passed', cleaned_by_staff: null, inspected_by_staff: s.insp.staffId })
    expect((await bedRow(bedId)).state).toBe('available')
  })

  it('refused with a clear message when the bed is Available, Occupied, Blocked, Under maintenance, archived, or already has an open task; unknown beds are not found', async () => {
    const s = await scene({ beds: 6 })
    const [freeBed, occupied, blockedBed, maint, archivedBed, withTask] = s.bedIds
    await mkStayRaw({ bedId: occupied, staffId: (await mkStaff()).id, from: day(-3), to: day(20) })
    await setBedState(blockedBed, 'blocked')
    await setBedState(maint, 'under_maintenance')
    await admin().query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [archivedBed])
    await vacate(s, withTask) // a real checkout: Needs cleaning WITH a task
    const reason = 'Trying it by hand'
    const cases: [string, string, RegExp, RegExp][] = [
      [freeBed, 'bed_state', /Available/, /Nothing to do/],
      [occupied, 'bed_state', /occupied/, /checks out/],
      [blockedBed, 'bed_state', /blocked/, /Unblock/],
      [maint, 'bed_state', /under maintenance/, /Finish the work/],
      [archivedBed, 'bed_state', /archived/, /out of use/],
      [withTask, 'task_exists', /already has a cleaning task/, /Assign it/],
    ]
    for (const [bedId, why, says, next] of cases) {
      const before = (await admin().query(`SELECT count(*)::int AS n FROM cleaning_task WHERE bed_id = $1`, [bedId])).rows[0].n
      const r = await openCleaningTaskManual(s.rec.rc, { bedId, reason })
      expect(complete(r), `${bedId}: ${JSON.stringify(r)}`).toBe(true)
      expect(!r.ok && r.code).toBe('conflict')
      expect(!r.ok && r.detail).toMatchObject({ reason: why })
      expect(!r.ok && r.reason).toMatch(says)
      expect(!r.ok && r.next).toMatch(next)
      expect((await admin().query(`SELECT count(*)::int AS n FROM cleaning_task WHERE bed_id = $1`, [bedId])).rows[0].n).toBe(before)
      expect((await admin().query(`SELECT 1 FROM audit_event WHERE action = 'readiness.cleaning.opened_manually' AND after->>'bedId' = $1`, [bedId])).rowCount).toBe(0) // a refusal writes nothing
    }
    // a bed that waits for inspection WITH a cleaned task already has a task too
    const cleaned = await scene({ beds: 1 })
    const v = await vacate(cleaned, cleaned.bedIds[0])
    await assignCleaning(cleaned.rec.rc, { taskId: v.taskId, housekeeperStaffId: cleaned.hk.staffId, note: null })
    await completeCleaning(cleaned.hk.rc, { taskId: v.taskId, checklist: FULL, notes: null })
    const dup = await openCleaningTaskManual(cleaned.rec.rc, { bedId: cleaned.bedIds[0], reason })
    expect(!dup.ok && dup.reason).toMatch(/already has a cleaned task/)
    expect(await openCleaningTaskManual(s.rec.rc, { bedId: '00000000-0000-4000-8000-000000000000', reason })).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('who may: Reception and the Super Admin at the bed\'s site; not the Accommodation Admin, a resident, or Reception of another site (not found); a reason is mandatory', async () => {
    const { s, bedId } = await noRecord('needs_cleaning')
    const aa = await staffAt('AA', s.siteId), res = await staffAt('Res', null), otherRec = await staffAt('Rec', (await mkProperty({ beds: 1 })).siteId)
    const reason = 'Opened by hand for the test'
    expect(await openCleaningTaskManual(aa.rc, { bedId, reason })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await openCleaningTaskManual(res.rc, { bedId, reason })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await openCleaningTaskManual(otherRec.rc, { bedId, reason })).toMatchObject({ ok: false, code: 'not_found' })
    expect(manualInput.safeParse({ bedId, reason: '' }).success).toBe(false)
    expect(manualInput.safeParse({ bedId, reason: '  ' }).success).toBe(false)
    expect(await openCleaningTaskManual(s.rec.rc, { bedId, reason: '' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await cleaningTasks(bedId)).toHaveLength(0)
    expect((await openCleaningTaskManual(s.rec.rc, { bedId, reason })).ok).toBe(true)
  })

  it('the board flags the bed with no record and names the action; after the hand task the row shows the task', async () => {
    const { s, bedId } = await noRecord('inspection_required')
    const now = newClock().now()
    const before = (await readinessBoard(getDb(), s.rec.rc.actor, now))!.rows!.find(r => r.bedId === bedId)!
    expect(before.task).toBeNull()
    expect(before.owner).toBe('Reception')
    expect(before.next).toMatch(/Open a task by hand with a reason/)
    expect((await openCleaningTaskManual(s.rec.rc, { bedId, reason: 'Seeded data without a task' })).ok).toBe(true)
    const after = (await readinessBoard(getDb(), s.rec.rc.actor, now))!.rows!.find(r => r.bedId === bedId)!
    expect(after.task).toMatchObject({ status: 'cleaned', cleanedByName: null })
    expect(after.owner).toBe('Final Inspection holder')
  })

  it('through the route: Reception 200, a resident 403, a missing reason 422, an unknown bed 404', async () => {
    const { s, bedId } = await noRecord('needs_cleaning')
    const rec = await staffAt('Rec', s.siteId)
    const res = await staffAt('Res', null)
    const post = (cookie: string | undefined, id: string, body: unknown) => call(openTaskRoute, { method: 'POST', body, cookie, params: { id }, path: `/api/v1/readiness/beds/${id}/open-task` })
    expect((await post(undefined, bedId, { reason: 'x y z' })).status).toBe(401)
    expect((await post(await res.cookie(), bedId, { reason: 'Just trying' })).status).toBe(403)
    expect((await post(await rec.cookie(), bedId, { reason: '' })).status).toBe(422)
    expect((await post(await rec.cookie(), '00000000-0000-4000-8000-000000000000', { reason: 'Just trying' })).status).toBe(404)
    const ok = await post(await rec.cookie(), bedId, { reason: 'Seeded data, no task' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data).toMatchObject({ bedState: 'needs_cleaning', taskStatus: 'open' })
  })
})

describe('AT-037 markBedNeedsWork (Stage 4 calls it when work finishes): under maintenance goes back to Needs cleaning with a task, idempotent, and never makes a bed Available', () => {
  const run = <T,>(fn: (tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]) => Promise<T>) => getDb().transaction(fn)

  it('moves under_maintenance to needs_cleaning (a legal transition) and opens ONE cleaning task through openCleaningTask; calling it again changes nothing', async () => {
    const s = await scene({ beds: 1 })
    const bedId = s.bedIds[0]
    await setBedState(bedId, 'under_maintenance')
    const first = await run(tx => markBedNeedsWork(tx, bedId, 'Window replaced', newClock().now()))
    expect(first).toMatchObject({ outcome: 'moved', state: 'needs_cleaning' })
    expect((await bedRow(bedId)).state).toBe('needs_cleaning')
    expect((await bedRow(bedId)).state_reason).toMatch(/Work finished: Window replaced/)
    const tasks = await cleaningTasks(bedId)
    expect(tasks.map(t => t.status)).toEqual(['open'])
    expect(tasks[0].reason).toMatch(/Work finished: Window replaced/)
    expect(first.outcome === 'moved' && first.taskId).toBe(tasks[0].id)
    expect((await admin().query(`SELECT to_role FROM notification WHERE dedupe_key = $1`, [`cleaning:${tasks[0].id}:opened`])).rows[0].to_role).toBe('Rec')

    const again = await run(tx => markBedNeedsWork(tx, bedId, 'Window replaced', newClock().now()))
    expect(again).toMatchObject({ outcome: 'already', state: 'needs_cleaning', taskId: tasks[0].id })
    expect(await cleaningTasks(bedId)).toHaveLength(1)
    expect((await bedRow(bedId)).state).toBe('needs_cleaning') // never Available from here
  })

  it('a bed already in Needs cleaning without a task gets one; every other state is left alone with the reason', async () => {
    const s = await scene({ beds: 6 })
    const [needs, free, occupied, insp, blocked, archived] = s.bedIds
    await setBedState(needs, 'needs_cleaning')
    await mkStayRaw({ bedId: occupied, staffId: (await mkStaff()).id, from: day(-3), to: day(20) })
    await setBedState(insp, 'inspection_required')
    await setBedState(blocked, 'blocked')
    await admin().query(`UPDATE bed SET state = 'archived', archived_at = now() WHERE id = $1`, [archived])
    const now = newClock().now()
    const n = await run(tx => markBedNeedsWork(tx, needs, 'Work done', now))
    expect(n.outcome).toBe('already')
    expect(await cleaningTasks(needs)).toHaveLength(1)
    for (const [bedId, state, why] of [[free, 'available', /already Available/], [occupied, 'occupied', /occupied/], [insp, 'inspection_required', /already waiting/], [blocked, 'blocked', /unblocking/], [archived, 'archived', /archived/]] as const) {
      const before = (await bedRow(bedId)).state
      const r = await run(tx => markBedNeedsWork(tx, bedId, 'Work done', now))
      expect(r).toMatchObject({ outcome: 'left_alone', state })
      expect(r.outcome === 'left_alone' && r.why).toMatch(why)
      expect((await bedRow(bedId)).state).toBe(before)
      expect(await cleaningTasks(bedId)).toHaveLength(0)
    }
    expect(await run(tx => markBedNeedsWork(tx, '00000000-0000-4000-8000-000000000000', 'x', now))).toEqual({ outcome: 'not_found' })
  })

  it('two calls at once leave exactly one task and one state change', async () => {
    const s = await scene({ beds: 1 })
    await setBedState(s.bedIds[0], 'under_maintenance')
    const now = newClock().now()
    const out = await Promise.all([run(tx => markBedNeedsWork(tx, s.bedIds[0], 'Work done', now)), run(tx => markBedNeedsWork(tx, s.bedIds[0], 'Work done', now))])
    expect(out.map(o => o.outcome).sort()).toEqual(['already', 'moved'])
    expect(await cleaningTasks(s.bedIds[0])).toHaveLength(1)
  })
})

/* ====================================================================== the picker ====================================================================== */

describe('AT-037 the housekeeper picker is ordered by relevance to the site (the Housekeeping capability carries no site; the assignment is the scope)', () => {
  it('recent assignments at this site first, then fewest open tasks, then name; employee ID is listed with the name; nobody is hidden; assignment rules unchanged', async () => {
    const s = await scene({ beds: 3 })
    const other = await mkProperty({ beds: 1 })
    const [hkA, hkB, hkC, hkD] = [await housekeeper(), await housekeeper(), await housekeeper(), await housekeeper()]
    for (const [hk, name] of [[hkA, 'Aaa Cleaner'], [hkB, 'Bbb Cleaner'], [hkC, 'Ccc Cleaner'], [hkD, 'Ddd Cleaner']] as const) {
      await admin().query(`UPDATE staff_profile SET full_name = $2 WHERE id = $1`, [hk.staffId, `${name} ${s.siteId.slice(0, 6)}`])
    }
    const taskFor = async (hk: { staffId: string }, siteId: string, bedId: string, status: string, assignedAt: Date) => {
      await admin().query(`INSERT INTO cleaning_task (bed_id, site_id, reason, status, assigned_to_staff, assigned_at) VALUES ($1, $2, 'seed', $3, $4, $5)`, [bedId, siteId, status, hk.staffId, assignedAt])
    }
    const nowMs = NOW
    // B worked this site 5 days ago (passed, so no open task); C worked ANOTHER site; D worked this site 90 days ago (not recent); A never
    await taskFor(hkB, s.siteId, s.bedIds[1], 'passed', new Date(nowMs - 5 * 86_400_000))
    await taskFor(hkC, other.siteId, other.bedIds[0], 'passed', new Date(nowMs - 2 * 86_400_000))
    await taskFor(hkD, s.siteId, s.bedIds[2], 'passed', new Date(nowMs - (RECENT_DAYS + 30) * 86_400_000))
    // C also has two OPEN tasks elsewhere, A none
    const o2 = await mkProperty({ beds: 2 })
    await setBedState(o2.bedIds[0], 'needs_cleaning'); await setBedState(o2.bedIds[1], 'needs_cleaning')
    await taskFor(hkC, o2.siteId, o2.bedIds[0], 'open', new Date(nowMs)); await taskFor(hkC, o2.siteId, o2.bedIds[1], 'open', new Date(nowMs))

    // the task this picker is for
    await setBedState(s.bedIds[0], 'needs_cleaning')
    const t = (await admin().query<{ id: string }>(`INSERT INTO cleaning_task (bed_id, site_id, reason) VALUES ($1, $2, 'seed') RETURNING id`, [s.bedIds[0], s.siteId])).rows[0].id
    const list = (await listHousekeepers(getDb(), s.rec.rc.actor, newClock().now(), { taskId: t }))!
    const mine = list.filter(p => [hkA, hkB, hkC, hkD].some(h => h.staffId === p.staffId))
    expect(mine.map(p => p.staffId)).toEqual([hkB.staffId, hkA.staffId, hkD.staffId, hkC.staffId])
    expect(mine.map(p => p.recentAtSite)).toEqual([true, false, false, false])
    expect(mine.map(p => p.openTasks)).toEqual([0, 0, 0, 2])
    expect(mine.every(p => /^E-/.test(p.employeeId) || p.employeeId.length > 0)).toBe(true)
    // the whole list obeys the same order, whoever else is in the shared database
    const key = (p: (typeof list)[number]) => [Number(!p.recentAtSite), p.openTasks, p.name, p.employeeId] as const
    const sorted = [...list].sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]) || x[3].localeCompare(y[3]) })
    expect(list.map(p => p.staffId)).toEqual(sorted.map(p => p.staffId))

    // nobody is hidden because they work elsewhere, and the assignment rules are unchanged: an active grant is still required, the room they live in is refused
    expect((await assignCleaning(s.rec.rc, { taskId: t, housekeeperStaffId: hkC.staffId, note: null })).ok).toBe(true)
    const nobody = await housekeeper({ grant: false })
    const reassign = await assignCleaning(s.rec.rc, { taskId: t, housekeeperStaffId: nobody.staffId, note: 'Changed my mind' })
    expect(!reassign.ok && reassign.code).toBe('invalid')
    // without a task there is no site to rank by: still ordered (open tasks, name), nobody marked recent
    const plain = (await listHousekeepers(getDb(), s.rec.rc.actor, newClock().now()))!
    expect(plain.every(p => !p.recentAtSite)).toBe(true)
  })
})

/* ====================================================================== readiness across workflows ====================================================================== */

describe('AT-037 readiness validation across workflows: workflow x bed state, each refusal with reason, owner and next action', () => {
  const CHECKIN_EXPECT: Record<State, { reason?: string; owner?: RegExp }> = {
    available: {},
    needs_cleaning: { reason: 'bed_not_ready', owner: /Housekeeping/ },
    inspection_required: { reason: 'bed_not_ready', owner: /Final inspection holder/ },
    blocked: { reason: 'bed_unavailable', owner: /Maintenance Coordinator/ },
    under_maintenance: { reason: 'bed_unavailable', owner: /Maintenance Coordinator/ },
    occupied: { reason: 'bed_occupied', owner: /Reception/ },
  }

  /** A reservation starting today on a bed that is Available when made and then goes into the state. */
  async function reservedToday(state: State) {
    const p = await mkProperty({ beds: 1 })
    const rec = await staffAt('Rec', p.siteId)
    const guest = await mkStaff()
    const rv = await mkReservation({ bedId: p.bedIds[0], staffId: guest.id, from: day(0), to: day(10) })
    if (state === 'occupied') { await admin().query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [p.bedIds[0]]) } else await arm(p.bedIds[0], state)
    return { ...p, rec, guest, rv }
  }

  for (const state of STATES) {
    it(`check-in on a bed that is ${state.replace('_', ' ')}`, async () => {
      const r = await reservedToday(state)
      const out = await checkIn(r.rec.rc, { reservationId: r.rv.reservationId })
      const want = CHECKIN_EXPECT[state]
      if (!want.reason) {
        expect(out.ok, JSON.stringify(out)).toBe(true)
        expect((await admin().query(`SELECT state FROM bed WHERE id = $1`, [r.bedIds[0]])).rows[0].state).toBe('occupied')
        return
      }
      expect(complete(out)).toBe(true)
      expect(!out.ok && out.detail).toMatchObject({ reason: want.reason })
      expect(!out.ok && out.owner).toMatch(want.owner!)
      expect((await admin().query(`SELECT 1 FROM stay WHERE staff_id = $1`, [r.guest.id])).rowCount).toBe(0)
      expect((await admin().query(`SELECT status FROM reservation WHERE id = $1`, [r.rv.reservationId])).rows[0].status).toBe('reserved')
    })

    it(`bulk check-in on a bed that is ${state.replace('_', ' ')}: that row says why, the others are not held up`, async () => {
      const r = await reservedToday(state)
      const out = await bulkCheckIn(r.rec.rc, { reservationIds: [r.rv.reservationId] })
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const row = out.data.rows[0]
      const want = CHECKIN_EXPECT[state]
      if (!want.reason) { expect(row.outcome).toBe('checked_in'); return }
      expect(row.outcome).toBe('failed')
      if (row.outcome !== 'failed') return
      expect(row.reason && row.owner && row.next).toBeTruthy()
      expect(row.detail).toMatchObject({ reason: want.reason })
    })
  }

  it('bulk check-in: a mixed batch checks in the ready bed and reports the others one by one', async () => {
    const a = await reservedToday('available'), b = await reservedToday('needs_cleaning')
    const outA = await bulkCheckIn(a.rec.rc, { reservationIds: [a.rv.reservationId] })
    expect(outA.ok && outA.data.checkedIn).toBe(1)
    const outB = await bulkCheckIn(b.rec.rc, { reservationIds: [b.rv.reservationId] })
    expect(outB.ok && outB.data.failed).toBe(1)
  })

  const EMERGENCY_EXPECT: Record<State, { reason?: string; owner?: RegExp }> = {
    available: {},
    needs_cleaning: { reason: 'bed_not_ready', owner: /Housekeeping/ },
    inspection_required: { reason: 'bed_not_ready', owner: /Housekeeping/ },
    blocked: { reason: 'bed_unavailable', owner: /Maintenance Coordinator/ },
    under_maintenance: { reason: 'bed_unavailable', owner: /Maintenance Coordinator/ },
    occupied: { reason: 'bed_taken', owner: /Accommodation Admin/ },
  }
  for (const state of STATES) {
    it(`emergency check-in on a bed that is ${state.replace('_', ' ')}`, async () => {
      const p = await mkProperty({ beds: 1 })
      const user = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
      await grantCapability(user.id, 'EmergencyCheckin')
      const rc = rcFor(user.id, { role: 'Rec', sites: [p.siteId], caps: ['EmergencyCheckin'], staffId: user.staffId }, newClock())
      const guest = await mkStaff()
      await arm(p.bedIds[0], state)
      const out = await initiateEmergency(rc, { staffId: guest.id, bedId: p.bedIds[0], reason: 'Flood in the staff block, needs a bed tonight' })
      const want = EMERGENCY_EXPECT[state]
      if (!want.reason) {
        expect(out.ok, JSON.stringify(out)).toBe(true)
        return
      }
      expect(complete(out)).toBe(true)
      expect(!out.ok && out.detail).toMatchObject({ reason: want.reason })
      expect(!out.ok && out.owner).toMatch(want.owner!)
      expect((await admin().query(`SELECT 1 FROM stay WHERE staff_id = $1`, [guest.id])).rowCount).toBe(0)
    })
  }

  // Reservations (a request's approval, bulk allocation) do NOT wait for readiness: that is D-18 (readiness gates check-in, not the reservation).
  // They refuse what can never be slept in (blocked, under maintenance) and what is taken for the dates.
  const RESERVE_EXPECT: Record<State, { ok: boolean; reason?: string }> = {
    available: { ok: true },
    needs_cleaning: { ok: true },
    inspection_required: { ok: true },
    blocked: { ok: false, reason: 'bed_unavailable' },
    under_maintenance: { ok: false, reason: 'bed_unavailable' },
    occupied: { ok: true }, // the occupant leaves today, so the dates do not overlap
  }
  for (const state of STATES) {
    it(`a request's approval (the path bulk allocation confirms through) on a bed that is ${state.replace('_', ' ')}: ${RESERVE_EXPECT[state].ok ? 'reserved' : 'refused'}`, async () => {
      const p = await mkProperty({ beds: 1 })
      const aa = await staffAt('AA', p.siteId)
      const guest = await mkStaff()
      const requestId = await mkRequest({ staffId: guest.id, siteId: p.siteId, arrival: day(1), end: day(30) })
      await arm(p.bedIds[0], state)
      const out = await approveRequest(aa.rc, { requestId, bedId: p.bedIds[0] })
      const want = RESERVE_EXPECT[state]
      if (want.ok) {
        expect(out.ok, JSON.stringify(out)).toBe(true)
        expect((await admin().query(`SELECT state FROM bed WHERE id = $1`, [p.bedIds[0]])).rows[0].state).toBe(state === 'available' ? 'available' : state)
        return
      }
      expect(complete(out)).toBe(true)
      expect(!out.ok && out.detail).toMatchObject({ reason: want.reason })
      expect(!out.ok && out.owner).toBe('Maintenance Coordinator')
    })
  }

  it('bulk allocation: a bed that is not ready is matched for a later arrival (D-18); a blocked bed is never matched; the confirmed reservation is not a check-in', async () => {
    const p = await mkProperty({ beds: 2 })
    const aa = await staffAt('AA', p.siteId)
    await setBedState(p.bedIds[0], 'needs_cleaning')
    await setBedState(p.bedIds[1], 'blocked')
    const guest = await mkStaff()
    const requestId = await mkRequest({ staffId: guest.id, siteId: p.siteId, arrival: day(3), end: day(40) })
    const prev = await previewBulkAllocation(aa.rc, { siteId: p.siteId, requestIds: [requestId] })
    expect(prev.ok, JSON.stringify(prev)).toBe(true)
    if (!prev.ok) return
    const row = prev.data.batch.rows[0]
    expect(row.bedId).toBe(p.bedIds[0])
    const done = await confirmBulkAllocation(aa.rc, { batchId: prev.data.batchId })
    expect(done.ok, JSON.stringify(done)).toBe(true)
    expect((await admin().query(`SELECT status FROM reservation WHERE staff_id = $1`, [guest.id])).rows[0].status).toBe('reserved')
    expect((await admin().query(`SELECT 1 FROM stay WHERE staff_id = $1`, [guest.id])).rowCount).toBe(0)
    expect((await bedRow(p.bedIds[0])).state).toBe('needs_cleaning')
  })

  const TRANSFER_EXPECT: Record<State, { reason?: string; owner?: RegExp }> = {
    available: {},
    needs_cleaning: { reason: 'bed_not_ready', owner: /Housekeeping/ },
    inspection_required: { reason: 'bed_not_ready', owner: /Housekeeping/ },
    blocked: { reason: 'bed_unavailable', owner: /Maintenance Coordinator/ },
    under_maintenance: { reason: 'bed_unavailable', owner: /Maintenance Coordinator/ },
    occupied: { reason: 'bed_taken', owner: /Accommodation Admin/ },
  }
  for (const state of STATES) {
    it(`a transfer into a bed that is ${state.replace('_', ' ')} (an immediate move needs an Available bed)`, async () => {
      const w = await world({ beds: 3 })
      const aa2 = await person('AA', { siteIds: [w.siteId] })
      const [res] = await residents(1)
      const s = await mkStayRaw({ bedId: w.bedIds[0], staffId: res.staffId, from: day(-5), to: day(30) })
      const r = await requestTransfer(res.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null })
      if (!r.ok) throw new Error(r.reason)
      await approveTransfer(aa2.rc, { id: r.data.id, destinationBedId: null, note: null })
      if (state === 'occupied') { const o = await mkStaff(); await mkStayRaw({ bedId: w.bedIds[1], staffId: o.id, from: day(-1), to: day(50) }) } else await arm(w.bedIds[1], state)
      const out = await executeTransfer(w.rec.rc, { id: r.data.id })
      const want = TRANSFER_EXPECT[state]
      if (!want.reason) { expect(out.ok, JSON.stringify(out)).toBe(true); return }
      expect(complete(out)).toBe(true)
      expect(!out.ok && out.detail).toMatchObject({ reason: want.reason, executionFailed: true })
      expect(!out.ok && out.owner).toMatch(want.owner!)
      expect((await admin().query(`SELECT bed_id FROM stay WHERE id = $1`, [s.stayId])).rows[0].bed_id).toBe(w.bedIds[0])
    })
  }
})

describe('AT-037 only a passed final inspection makes a bed Available (the sources are scanned by boundary.test.ts; here the new paths are exercised)', () => {
  it('neither the hand task, nor markBedNeedsWork, nor a cancelled task, nor an offer or its acceptance makes a bed Available', async () => {
    const s = await scene({ beds: 3 })
    const [a, b, c] = s.bedIds
    await setBedState(a, 'needs_cleaning'); await setBedState(b, 'inspection_required'); await setBedState(c, 'under_maintenance')
    expect((await openCleaningTaskManual(s.rec.rc, { bedId: a, reason: 'No task on record' })).ok).toBe(true)
    expect((await openCleaningTaskManual(s.rec.rc, { bedId: b, reason: 'No task on record' })).ok).toBe(true)
    await getDb().transaction(tx => markBedNeedsWork(tx, c, 'Work finished', newClock().now()))
    for (const id of s.bedIds) expect((await bedRow(id)).state).not.toBe('available')
  })
})
