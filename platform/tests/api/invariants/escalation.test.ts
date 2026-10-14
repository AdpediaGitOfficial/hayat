/// <reference types="vite/client" />
/**
 * AT-033: escalation backup (P-01, S-14). PROPOSED, pending client sign-off: the setting `approvals.escalation_backup` ships ON and
 * both states are tested here.
 *
 * The agreement test is generated from the registered approval sources: for EVERY source, at EVERY level of the approval clock, in
 * BOTH states of the setting, and for every role and capability combination (plus the person the record is about and the person who
 * raised it), the inbox "mine" flag must equal "the command would not refuse this person for authorization or separation-of-duties
 * reasons". The commands are probed with a body that fails AFTER authorization (a bed that does not exist, a swap nobody agreed to, a
 * bed that is booked next), so a probe never changes anything.
 *
 * Runs against a private database because it changes a global setting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIsolated, useClock, call } from '../access/isolated'
import { T0, atDays, invKit, day, type Cast } from './kit'
import { FixedClock } from '@/server/clock'
import { getDb } from '@/server/db/client'
import { listInbox } from '@/server/approvals/inbox'
import { approvalSources } from '@/server/approvals/registry'
import '@/server/approvals/sources'
import type { Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { approveRequest } from '@/server/commands/requests/approve'
import { rejectRequest, requestChanges } from '@/server/commands/requests/decide'
import { declineException, grantException } from '@/server/commands/requests/exceptions'
import { confirmBulkAllocation, previewBulkAllocation } from '@/server/commands/allocation-admin/bulk'
import { approveTransfer, rejectTransfer } from '@/server/commands/stays/decideTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { approveExtension, rejectExtension, requestExtension } from '@/server/commands/stays/extension'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { approveEmergency } from '@/server/commands/emergency/decide'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { decidePriority, requestPriority } from '@/server/commands/waitlist/priority'
import { POST as approveRoute } from '../../../app/api/v1/requests/[id]/approve/route'
import { POST as rejectRoute } from '../../../app/api/v1/requests/[id]/reject/route'
import { POST as changesRoute } from '../../../app/api/v1/requests/[id]/changes/route'
import type { Capability, Role } from '@/domain/enums'

const iso = await createIsolated()
afterAll(() => iso.close())
const k = invKit(iso)
const uuid = () => crypto.randomUUID()

/* ---------------- who ---------------- */

interface Spec { key: string; role: Role; caps: Capability[]; at: 'home' | 'other' }
const SPECS: Spec[] = [
  { key: 'SA', role: 'SA', caps: [], at: 'home' },
  { key: 'AA', role: 'AA', caps: [], at: 'home' },
  { key: 'AA+PA', role: 'AA', caps: ['PolicyApprover'], at: 'home' },
  { key: 'AA+BA', role: 'AA', caps: ['BackupApprover'], at: 'home' },
  { key: 'Rec', role: 'Rec', caps: [], at: 'home' },
  { key: 'Rec+PA', role: 'Rec', caps: ['PolicyApprover'], at: 'home' },
  { key: 'Rec+BA', role: 'Rec', caps: ['BackupApprover'], at: 'home' },
  { key: 'Mgr', role: 'Mgr', caps: [], at: 'home' },
  { key: 'Mgr+PA', role: 'Mgr', caps: ['PolicyApprover'], at: 'home' },
  { key: 'Mgr+BA', role: 'Mgr', caps: ['BackupApprover'], at: 'home' },
  { key: 'Mgr+PA+BA', role: 'Mgr', caps: ['PolicyApprover', 'BackupApprover'], at: 'home' },
  { key: 'MC', role: 'MC', caps: [], at: 'home' },
  { key: 'MC+BA', role: 'MC', caps: ['BackupApprover'], at: 'home' },
  { key: 'Aud', role: 'Aud', caps: [], at: 'home' },
  { key: 'Sec', role: 'Sec', caps: [], at: 'home' },
  { key: 'Res', role: 'Res', caps: [], at: 'home' },
  { key: 'Res+PA', role: 'Res', caps: ['PolicyApprover'], at: 'home' },
  { key: 'AA@other', role: 'AA', caps: [], at: 'other' },
  { key: 'Mgr+PA@other', role: 'Mgr', caps: ['PolicyApprover'], at: 'other' },
  { key: 'Mgr+BA@other', role: 'Mgr', caps: ['BackupApprover'], at: 'other' },
]

let home: Awaited<ReturnType<typeof k.property>>
let other: Awaited<ReturnType<typeof k.property>>
const crowd = new Map<string, Cast>()

beforeAll(async () => {
  home = await k.property({ beds: 60 })
  other = await k.property({ beds: 10 })
  for (const s of SPECS) crowd.set(s.key, await k.cast(s.role, { siteId: s.at === 'home' ? home.siteId : other.siteId, caps: s.caps }))
  await k.setConfig('eligibility.priority_categories', ['Medical'])
})

/* ---------------- one item per kind, with a probe that fails after authorization ---------------- */

type Probe = (rc: RequestContext) => Promise<Result<unknown>>
interface Item {
  /** The inbox kinds this item shows under (a cross-site transfer shows once per missing key). */
  kinds: string[]
  ref: string
  /** The site that decides it (the sites of the other keys of a cross-site move are named in the test). */
  siteId: string
  probe: Probe
  /** People the item is about and the ones who raised it, in the roles that WOULD otherwise let them decide. */
  involved: Cast[]
  /** 'clock': the level comes from the approval clock; 'escalation': from the emergency case's own counter. */
  levels: 'clock' | 'escalation'
}
let bedCursor = 0
const nextBeds = (n: number) => { const b = home.bedIds.slice(bedCursor, bedCursor + n); bedCursor += n; if (b.length < n) throw new Error('out of beds'); return b }

/** The person the item is about, in the roles that would let them decide it if the rule did not stop them. */
const asDeciders = (u: Cast, siteId = home.siteId): Cast[] => [
  k.castOf({ id: u.userId, staffId: u.staffId, username: u.username, password: u.password }, 'AA', [], siteId),
  k.castOf({ id: u.userId, staffId: u.staffId, username: u.username, password: u.password }, 'Mgr', ['PolicyApprover'], siteId),
  k.castOf({ id: u.userId, staffId: u.staffId, username: u.username, password: u.password }, 'Mgr', ['BackupApprover'], siteId),
]

const MAKERS: Record<string, () => Promise<Item>> = {
  request: async () => {
    const subject = await k.cast('Res'), raiser = await k.cast('Rec', { siteId: home.siteId })
    const id = await k.request({ staffId: subject.staffId, siteId: home.siteId, raisedByUserId: raiser.userId })
    return { kinds: ['request'], ref: id, siteId: home.siteId, levels: 'clock', involved: [...asDeciders(subject), ...asDeciders(raiser)], probe: rc => approveRequest(rc, { requestId: id, bedId: uuid() }) }
  },
  waitlist_priority: async () => {
    const subject = await k.cast('Res'), raiser = await k.cast('AA', { siteId: home.siteId })
    const e = await addToWaitlist(raiser.rc(), { staffId: subject.staffId, siteId: home.siteId, arrival: day(5) })
    if (!e.ok) throw new Error('waitlist: ' + e.reason)
    const p = await requestPriority(raiser.rc(), { entryId: e.data.entryId, category: 'Medical', reason: 'needs a ground floor', evidence: 'doctor letter' })
    if (!p.ok) throw new Error('priority: ' + p.reason)
    const id = p.data.priorityRequestId
    return { kinds: ['waitlist_priority'], ref: id, siteId: home.siteId, levels: 'clock', involved: [...asDeciders(subject), ...asDeciders(raiser)], probe: rc => decidePriority(rc, { priorityRequestId: id, decision: 'reject' }) }
  },
  transfer: async () => {
    const subject = await k.cast('Res'), raiser = await k.cast('AA', { siteId: home.siteId })
    const [b0, b1] = nextBeds(2)
    const s = await k.stay({ bedId: b0, staffId: subject.staffId, from: day(-5), to: day(30) })
    const r = await requestTransfer(raiser.rc(), { stayId: s.stayId, destinationBedId: b1, destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null })
    if (!r.ok) throw new Error('transfer: ' + r.reason)
    const id = r.data.id
    return { kinds: ['transfer'], ref: id, siteId: home.siteId, levels: 'clock', involved: [...asDeciders(subject), ...asDeciders(raiser)], probe: rc => approveTransfer(rc, { id, destinationBedId: uuid(), note: null }) }
  },
  swap: async () => {
    const a = await k.cast('Res'), b = await k.cast('Res'), raiser = await k.cast('AA', { siteId: home.siteId })
    const [b0, b1] = nextBeds(2)
    const sa = await k.stay({ bedId: b0, staffId: a.staffId, from: day(-5), to: day(30) })
    const sb = await k.stay({ bedId: b1, staffId: b.staffId, from: day(-3), to: day(40) })
    // No consent recorded: an approval that gets past authorization is refused for that, and nothing changes.
    const r = await requestSwap(raiser.rc(), { stayId: sa.stayId, otherStayId: sb.stayId, reason: 'Friends want to swap', neededBy: null, consentFirst: null, consentSecond: null })
    if (!r.ok) throw new Error('swap: ' + r.reason)
    const id = r.data.id
    return { kinds: ['swap'], ref: id, siteId: home.siteId, levels: 'clock', involved: [...asDeciders(a), ...asDeciders(b), ...asDeciders(raiser)], probe: rc => approveTransfer(rc, { id, destinationBedId: null, note: null }) }
  },
  transfer_cross_site: async () => {
    const subject = await k.cast('Res'), raiser = await k.cast('AA', { siteId: home.siteId })
    const [b0] = nextBeds(1)
    const s = await k.stay({ bedId: b0, staffId: subject.staffId, from: day(-5), to: day(30) })
    const dest = other.bedIds.shift()!
    const r = await requestTransfer(raiser.rc(), { stayId: s.stayId, destinationBedId: dest, destinationSiteId: null, reason: 'New project at the other site', neededBy: null, linkedExtensionId: null })
    if (!r.ok) throw new Error('cross transfer: ' + r.reason)
    const id = r.data.id
    return { kinds: ['transfer', 'transfer_in'], ref: id, siteId: home.siteId, levels: 'clock', involved: [...asDeciders(subject), ...asDeciders(raiser)], probe: rc => approveTransfer(rc, { id, destinationBedId: uuid(), note: null }) }
  },
  extension: async () => extensionItem(false),
  extension_beyond: async () => extensionItem(true),
  emergency_aa_route: async () => emergencyItem('AA'),
  emergency_pa_route: async () => emergencyItem('PA'),
}

async function extensionItem(beyond: boolean): Promise<Item> {
  const subject = await k.cast('Res'), raiser = await k.cast('AA', { siteId: home.siteId })
  const [b0] = nextBeds(1)
  const s = await k.stay({ bedId: b0, staffId: subject.staffId, from: day(-5), to: day(30) })
  // Someone else is booked right after: the request is kept (with a transfer suggestion) and an approval that gets past authorization is
  // refused for the clash, so a probe never extends anything.
  const other2 = await k.staff()
  await k.reservation({ bedId: b0, staffId: other2.id, from: day(31), to: day(400) })
  const r = await requestExtension(raiser.rc(), { stayId: s.stayId, newEnd: beyond ? day(200) : day(40), reason: 'Project runs on' })
  if (!r.ok) throw new Error('extension: ' + r.reason)
  const id = r.data.id
  return { kinds: ['extension'], ref: id, siteId: home.siteId, levels: 'clock', involved: [...asDeciders(subject), ...asDeciders(raiser)], probe: rc => approveExtension(rc, { id, note: null }) }
}

async function emergencyItem(route: 'AA' | 'PA'): Promise<Item> {
  // A male resident in a female-only room: the rules "would have failed", so an approval without a note is refused AFTER authorization.
  const prop = await k.property({ beds: 1, gender: 'female' })
  const subject = await k.cast('Res')
  const initiator = route === 'AA' ? await k.cast('Rec', { siteId: prop.siteId, caps: ['EmergencyCheckin'] }) : await k.cast('AA', { siteId: prop.siteId, caps: ['EmergencyCheckin'] })
  const r = await initiateEmergency(initiator.rc(), { staffId: subject.staffId, bedId: prop.bedIds[0], reason: 'Flood in block B, relocated overnight' })
  if (!r.ok) throw new Error('emergency: ' + r.reason)
  const id = r.data.caseId
  return {
    kinds: ['emergency'], ref: id, siteId: prop.siteId, levels: 'escalation', involved: [...asDeciders(subject, prop.siteId), ...asDeciders(initiator, prop.siteId)],
    probe: rc => approveEmergency(rc, { caseId: id, note: null }),
  }
}

/* ---------------- the agreement test ---------------- */

// "Still with the Policy Approver" (waitlist priority, before the backup level) is an authorization refusal that answers 409, not 403.
const refusedForAuthorization = (r: Result<unknown>) => !r.ok && (r.code === 'forbidden' || r.code === 'not_found' || (r.detail as { reason?: string } | undefined)?.reason === 'not_yet_routed')
const refusedForDuty = (r: Result<unknown>) => !r.ok && r.code === 'separation_of_duties'
const LEVEL_CLOCK = [0, 2, 5] // days after T0: 0 = within SLA, 2 = backup level (two business days), 5 = escalated (three)

async function inboxMine(actor: Cast, now: Date, item: Item): Promise<boolean | undefined> {
  const list = await listInbox(getDb(), actor.actor, now, actor.userId)
  const hits = list.filter(i => i.ref === item.ref && item.kinds.includes(i.kind))
  return hits.length ? hits.some(h => h.mine) : undefined
}

/** The people of `home` are re-seated at the site that decides this item (the emergency cases live at their own site). */
function sitedFor(spec: Spec, item: Item): Cast {
  const base = crowd.get(spec.key)!
  if (spec.at === 'other' || item.siteId === home.siteId) return base
  return k.castOf({ id: base.userId, staffId: base.staffId, username: base.username, password: base.password }, spec.role, spec.caps, item.siteId)
}

describe('AT-033 registered approval sources', () => {
  it('every approval source in the registry is covered by this test', () => {
    const covered = new Set(['request', 'exception', 'waitlist_priority', 'transfer', 'transfer_in', 'swap', 'swap_in', 'extension', 'emergency'])
    expect(approvalSources().map(s => s.kind).sort()).toEqual([...covered].sort())
  })
})

describe.each([true, false])('AT-033 the inbox "mine" flag equals what the command allows (approvals.escalation_backup = %s, proposed, pending client sign-off)', on => {
  beforeAll(async () => { await k.setConfig('approvals.escalation_backup', on) })

  for (const [name, make] of Object.entries(MAKERS)) {
    it(`${name}: every role and capability, at every level of the clock`, async () => {
      const item = await make()
      const mismatches: string[] = []
      const matrix: Record<string, boolean[]> = {}
      const levels = [0, 1, 2] as const
      for (const level of levels) {
        if (item.levels === 'escalation') await iso.admin.query(`UPDATE emergency_checkin SET escalation = $1 WHERE id = $2`, [level, item.ref])
        const clock = item.levels === 'clock' ? atDays(LEVEL_CLOCK[level]) : new FixedClock(T0.getTime())
        const people: { key: string; who: Cast }[] = [
          ...SPECS.map(s => ({ key: s.key, who: sitedFor(s, item) })),
          ...item.involved.map((who, n) => ({ key: `involved#${n}:${who.role}${who.caps.length ? '+' + who.caps.join('+') : ''}`, who })),
        ]
        for (const { key, who } of people) {
          const mine = await inboxMine(who, clock.now(), item)
          const r = await item.probe(who.rc(clock))
          const mayAct = !refusedForAuthorization(r) && !refusedForDuty(r)
          ;(matrix[key] ??= []).push(mine ?? false)
          if ((mine ?? false) !== mayAct) mismatches.push(`level ${level} ${key}: inbox mine=${mine ?? 'absent'} but command ${r.ok ? 'ok' : `${r.code}: ${r.reason}`}`)
          if (key.startsWith('involved') && mayAct) mismatches.push(`level ${level} ${key}: the person it is about or who raised it was not stopped`)
          if (key.startsWith('involved') && mine) mismatches.push(`level ${level} ${key}: the inbox offers it to the person it is about or who raised it`)
        }
      }
      expect(mismatches).toEqual([])

      // The shape of the rule, spelled out (not just "they agree"): the matrix of who decides at levels 0, 1, 2.
      const row = (key: string) => matrix[key]
      const crossSite = name === 'transfer_cross_site'
      for (const never of ['Rec', 'Mgr', 'MC', 'Aud', 'Sec', 'Res', 'Res+PA', ...(crossSite ? [] : ['AA@other', 'Mgr+PA@other', 'Mgr+BA@other'])]) expect(row(never), never).toEqual([false, false, false])
      if (crossSite) {
        // the destination site holds the second key: its own Accommodation Admin decides at any time, its backup approvers from the backup level
        expect(row('AA@other')).toEqual([true, true, true])
        expect(row('Mgr+PA@other')).toEqual(on ? [false, true, true] : [false, false, false])
        expect(row('Mgr+BA@other')).toEqual(on ? [false, true, true] : [false, false, false])
      }
      if (item.levels === 'clock' && name !== 'extension_beyond' && name !== 'waitlist_priority') {
        expect(row('SA')).toEqual([true, true, true])
        expect(row('AA')).toEqual([true, true, true])
        for (const backup of ['Mgr+PA', 'Mgr+BA', 'Mgr+PA+BA', 'Rec+PA', 'Rec+BA', 'MC+BA']) expect(row(backup), backup).toEqual(on ? [false, true, true] : [false, false, false])
      }
      if (name === 'extension_beyond') {
        expect(row('AA')).toEqual([false, false, false])
        expect(row('SA')).toEqual([false, false, false])
        expect(row('Mgr+PA')).toEqual([true, true, true]) // the Policy Approver is the primary decider here
        expect(row('Mgr+BA')).toEqual(on ? [false, true, true] : [false, false, false])
      }
      if (name === 'waitlist_priority') {
        expect(row('Mgr+PA')).toEqual([true, true, true])
        expect(row('Mgr+BA')).toEqual([false, true, true]) // the named backup of D-53 / APPROVALS.md: not governed by the P-01 switch
      }
      if (name === 'emergency_aa_route') {
        expect(row('AA')).toEqual([true, true, true])
        expect(row('Mgr+PA')).toEqual([false, true, true]) // D-107: decided, not proposed; the escalation level decides
        expect(row('Mgr+BA')).toEqual([false, true, true])
        expect(row('SA')).toEqual([false, false, false]) // alerted, never decides (D-107)
      }
      if (name === 'emergency_pa_route') {
        expect(row('AA')).toEqual([false, false, false]) // an AA started it, so it goes to a Policy Approver (D-68)
        expect(row('Mgr+PA')).toEqual([true, true, true])
        expect(row('Mgr+BA')).toEqual([false, true, true])
      }
    })
  }

  it('exception: the Policy Approver decides at any level, never the person it is about or who asked', async () => {
    const mismatches: string[] = []
    for (const s of SPECS) {
      const subject = await k.cast('Res'), raiser = await k.cast('AA', { siteId: home.siteId })
      const asker = await k.cast('AA', { siteId: home.siteId })
      const id = await k.request({ staffId: subject.staffId, siteId: home.siteId, raisedByUserId: raiser.userId, status: 'pending_approval' })
      await iso.admin.query(`INSERT INTO request_exception_ask (request_id, site_id, asked_by, kinds, reason, created_at) VALUES ($1, $2, $3, '{gender}', 'Needs this room', $4)`, [id, home.siteId, asker.userId, T0])
      const who = crowd.get(s.key)!
      const mine = await inboxMine(who, T0, { kinds: ['exception'], ref: id } as Item)
      const r = await declineException(who.rc(), { requestId: id, reason: 'Not needed' })
      const mayAct = !refusedForAuthorization(r) && !refusedForDuty(r)
      if ((mine ?? false) !== mayAct) mismatches.push(`${s.key}: inbox mine=${mine ?? 'absent'} but command ${r.ok ? 'ok' : r.code}`)
    }
    expect(mismatches).toEqual([])
    // the subject and the raiser, as Policy Approvers
    for (const role of ['subject', 'raiser'] as const) {
      const subject = await k.cast('Res'), raiser = await k.cast('Mgr', { siteId: home.siteId, caps: ['PolicyApprover'] })
      const id = await k.request({ staffId: subject.staffId, siteId: home.siteId, raisedByUserId: raiser.userId, status: 'pending_approval' })
      await iso.admin.query(`INSERT INTO request_exception_ask (request_id, site_id, asked_by, kinds, reason, created_at) VALUES ($1, $2, $3, '{gender}', 'Needs this room', $4)`, [id, home.siteId, raiser.userId, T0])
      const who = role === 'subject' ? k.castOf({ id: subject.userId, staffId: subject.staffId, username: subject.username, password: subject.password }, 'Mgr', ['PolicyApprover'], home.siteId) : raiser
      expect((await inboxMine(who, T0, { kinds: ['exception'], ref: id } as Item)) ?? false).toBe(false)
      const r = await grantException(who.rc(), { requestId: id, kinds: ['gender'], reason: 'ok', evidence: 'letter' })
      expect(!r.ok && r.code).toBe('separation_of_duties')
    }
  })
})

/* ---------------- the rule in words: refusals say who and what is next, successes are audited ---------------- */

describe('AT-033 the Policy Approver and the request (setting ON)', () => {
  beforeAll(async () => { await k.setConfig('approvals.escalation_backup', true) })

  it('is refused before the backup level with the reason and the owner, and nothing changes', async () => {
    const subject = await k.cast('Res')
    const id = await k.request({ staffId: subject.staffId, siteId: home.siteId })
    const pa = crowd.get('Mgr+PA')!
    for (const op of ['approve', 'reject', 'changes'] as const) {
      const clock = atDays(1)
      const r = op === 'approve' ? await approveRequest(pa.rc(clock), { requestId: id, bedId: home.bedIds[59] })
        : op === 'reject' ? await rejectRequest(pa.rc(clock), { requestId: id, reason: 'No room' })
          : await requestChanges(pa.rc(clock), { requestId: id, reason: 'Dates please' })
      expect(r.ok, op).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('forbidden')
        expect(r.reason).toMatch(/waiting for the Accommodation Admin/)
        expect(r.owner).toBe('Accommodation Admin')
        expect(r.next).toBeTruthy()
      }
    }
    expect((await iso.admin.query(`SELECT status FROM accommodation_request WHERE id = $1`, [id])).rows[0].status).toBe('submitted')
    expect((await k.auditOf(id)).length).toBe(0)
  })

  it('from the backup level a Policy Approver approves, a Backup Approver rejects, another sends back; each is audited with the actor and the role', async () => {
    const mk = async () => { const s = await k.cast('Res'); return { s, id: await k.request({ staffId: s.staffId, siteId: home.siteId }) } }
    const clock = atDays(2)
    const pa = crowd.get('Mgr+PA')!, ba = crowd.get('Mgr+BA')!

    const a = await mk()
    const bed = home.bedIds[58]
    const ap = await approveRequest(pa.rc(clock), { requestId: a.id, bedId: bed })
    expect(ap.ok, JSON.stringify(ap)).toBe(true)
    expect((await iso.admin.query(`SELECT status, decided_by FROM accommodation_request WHERE id = $1`, [a.id])).rows[0]).toMatchObject({ status: 'approved', decided_by: pa.userId })
    const audit = await k.auditOf(a.id)
    expect(audit.map(x => x.action)).toEqual(['requests.request.approved'])
    expect(audit[0]).toMatchObject({ actor_user_id: pa.userId, actor_role: 'Mgr', entity_type: 'request', site_id: home.siteId })

    const b = await mk()
    expect((await rejectRequest(ba.rc(clock), { requestId: b.id, reason: 'No capacity this month' })).ok).toBe(true)
    expect((await k.auditOf(b.id)).map(x => x.action)).toEqual(['requests.request.rejected'])

    const c = await mk()
    expect((await requestChanges(pa.rc(clock), { requestId: c.id, reason: 'Please give an end date' })).ok).toBe(true)
    expect((await k.auditOf(c.id))[0]).toMatchObject({ action: 'requests.request.changes_requested', actor_user_id: pa.userId })
  })

  it('never the person it is about nor the one who raised it, even at the escalation level', async () => {
    const subject = await k.cast('Res'), raiser = await k.cast('Rec', { siteId: home.siteId })
    const id = await k.request({ staffId: subject.staffId, siteId: home.siteId, raisedByUserId: raiser.userId })
    const clock = atDays(5)
    for (const who of [
      k.castOf({ id: subject.userId, staffId: subject.staffId, username: subject.username, password: subject.password }, 'Mgr', ['PolicyApprover'], home.siteId),
      k.castOf({ id: raiser.userId, staffId: raiser.staffId, username: raiser.username, password: raiser.password }, 'Mgr', ['PolicyApprover'], home.siteId),
      k.castOf({ id: raiser.userId, staffId: raiser.staffId, username: raiser.username, password: raiser.password }, 'AA', [], home.siteId),
    ]) {
      const r = await rejectRequest(who.rc(clock), { requestId: id, reason: 'try' })
      expect(!r.ok && r.code, `${who.role} ${who.caps}`).toBe('separation_of_duties')
    }
    expect((await iso.admin.query(`SELECT status FROM accommodation_request WHERE id = $1`, [id])).rows[0].status).toBe('submitted')
  })

  it('a Policy Approver of another site reads "not found"; a Policy Approver cannot run bulk allocation (an Accommodation Admin action) at any level', async () => {
    const subject = await k.cast('Res')
    const id = await k.request({ staffId: subject.staffId, siteId: home.siteId })
    const r = await approveRequest(crowd.get('Mgr+PA@other')!.rc(atDays(5)), { requestId: id, bedId: home.bedIds[57] })
    expect(!r.ok && r.code).toBe('not_found')
    const pa = crowd.get('Mgr+PA')!
    const p = await previewBulkAllocation(pa.rc(atDays(5)), { siteId: home.siteId, requestIds: [id] })
    expect(!p.ok && p.code).toBe('forbidden')
    const aa = crowd.get('AA')!
    const prev = await previewBulkAllocation(aa.rc(atDays(5)), { siteId: home.siteId, requestIds: [id] })
    expect(prev.ok).toBe(true)
    if (prev.ok) {
      const c = await confirmBulkAllocation(pa.rc(atDays(5)), { batchId: prev.data.batchId })
      expect(!c.ok && c.code).toBe('forbidden')
      expect((await iso.admin.query(`SELECT status FROM accommodation_request WHERE id = $1`, [id])).rows[0].status).toBe('submitted')
      // the same batch confirmed by the Accommodation Admin goes through the same approval path
      const done = await confirmBulkAllocation(aa.rc(atDays(5)), { batchId: prev.data.batchId })
      expect(done.ok).toBe(true)
    }
  })

  it('through the real routes: the Policy Approver is let in by the route guard, refused early with 403 and the owner, allowed from the backup level', async () => {
    const subject = await k.cast('Res')
    const id = await k.request({ staffId: subject.staffId, siteId: home.siteId })
    const pa = await k.cast('Mgr', { siteId: home.siteId, caps: ['PolicyApprover'] })
    // sessions are issued at the clock in force, so each call signs in at its own time
    useClock(T0)
    const early = await call(rejectRoute, { body: { reason: 'No room this month' }, cookie: await pa.cookie(), params: { id } })
    expect(early.status).toBe(403)
    expect(early.body).toMatchObject({ code: 'forbidden', owner: 'Accommodation Admin' })
    useClock(atDays(2).now())
    const late = await call(rejectRoute, { body: { reason: 'No room this month' }, cookie: await pa.cookie(), params: { id } })
    expect(late.status, JSON.stringify(late.body)).toBe(200)
    // a Resident and a Maintenance Coordinator never learn whether a request exists
    const res = await (await k.cast('Res')).cookie()
    const mc = await (await k.cast('MC', { siteId: home.siteId })).cookie()
    const missing = uuid()
    for (const [route, body] of [[approveRoute, { bedId: uuid() }], [rejectRoute, { reason: 'abc' }], [changesRoute, { reason: 'abc' }]] as const) {
      const ids = [id, missing]
      const answers = await Promise.all([res, mc].flatMap(c => ids.map(i => call(route, { body, cookie: c, params: { id: i } }))))
      expect(new Set(answers.slice(0, 2).map(a => a.status)).size, 'resident: same answer whether the request exists').toBe(1)
      expect(new Set(answers.slice(2).map(a => a.status)).size, 'maintenance coordinator: same answer whether the request exists').toBe(1)
    }
  })
})

describe('AT-033 the setting OFF: previous behaviour for the Accommodation Admin and Super Admin, nobody else', () => {
  beforeAll(async () => { await k.setConfig('approvals.escalation_backup', false) })

  it('a Policy Approver and a Backup Approver are refused at the escalation level with the reason (proposed, pending client sign-off); AA and SA still decide', async () => {
    const mk = async () => k.request({ staffId: (await k.cast('Res')).staffId, siteId: home.siteId })
    const clock = atDays(5)
    for (const who of [crowd.get('Mgr+PA')!, crowd.get('Mgr+BA')!]) {
      const id = await mk()
      const r = await rejectRequest(who.rc(clock), { requestId: id, reason: 'No room' })
      expect(!r.ok && r.code).toBe('forbidden')
      expect(!r.ok && r.reason).toMatch(/switched off \(proposed policy P-01, pending client sign-off\)/)
      expect(!r.ok && r.owner).toBe('Accommodation Admin')
      expect((await k.auditOf(id)).length).toBe(0)
    }
    for (const who of [crowd.get('AA')!, crowd.get('SA')!]) {
      const id = await mk()
      expect((await rejectRequest(who.rc(clock), { requestId: id, reason: 'No room' })).ok).toBe(true)
    }
  })

  it('the inbox card says why, and does not promise a later level', async () => {
    const id = await k.request({ staffId: (await k.cast('Res')).staffId, siteId: home.siteId })
    const pa = crowd.get('Mgr+PA')!
    const list = await listInbox(getDb(), pa.actor, atDays(5).now(), pa.userId)
    const card = list.find(i => i.ref === id)
    expect(card?.mine).toBe(false)
    expect(card?.why).toMatch(/switched off \(proposed policy P-01, pending client sign-off\)/)
  })

  it('transfers and extensions follow the same rule: the Policy Approver is refused, the Accommodation Admin decides', async () => {
    const t = await MAKERS.transfer()
    const e = await MAKERS.extension()
    const pa = crowd.get('Mgr+PA')!
    const tr = await approveTransfer(pa.rc(atDays(5)), { id: t.ref, destinationBedId: uuid(), note: null })
    expect(!tr.ok && tr.code).toBe('forbidden')
    expect(!tr.ok && tr.reason).toMatch(/switched off/)
    const rejected = await rejectTransfer(crowd.get('AA')!.rc(atDays(5)), { id: t.ref, reason: 'Not now' })
    expect(rejected.ok).toBe(true)
    const ex = await rejectExtension(pa.rc(atDays(5)), { id: e.ref, reason: 'Not now' })
    expect(!ex.ok && ex.code).toBe('forbidden')
    expect((await rejectExtension(crowd.get('SA')!.rc(atDays(5)), { id: e.ref, reason: 'Not now' })).ok).toBe(true)
  })

  it('exceptions stay with the Policy Approver whatever the setting says (D-25)', async () => {
    const subject = await k.cast('Res'), asker = await k.cast('AA', { siteId: home.siteId })
    const id = await k.request({ staffId: subject.staffId, siteId: home.siteId, status: 'pending_approval' })
    await iso.admin.query(`INSERT INTO request_exception_ask (request_id, site_id, asked_by, kinds, reason, created_at) VALUES ($1, $2, $3, '{gender}', 'Needs this room', $4)`, [id, home.siteId, asker.userId, T0])
    const aa = await grantException(crowd.get('AA')!.rc(atDays(5)), { requestId: id, kinds: ['gender'], reason: 'ok', evidence: 'letter' })
    expect(!aa.ok && aa.code).toBe('forbidden')
    const pa = await grantException(crowd.get('Mgr+PA')!.rc(), { requestId: id, kinds: ['gender'], reason: 'ok', evidence: 'letter' })
    expect(pa.ok).toBe(true)
    expect((await k.auditOf(id)).map(x => x.action)).toContain('requests.exception.granted')
  })
})
