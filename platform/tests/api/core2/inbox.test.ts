import { afterAll, describe, expect, it } from 'vitest'
import { closeAll, makeUser, grantCapability, newSite, uniq } from '../harness'
import { buildActor } from '@/server/auth/actor'
import { registerApprovalSource } from '@/server/approvals/registry'
import { listInbox } from '@/server/approvals/inbox'
import type { ApprovalDraft } from '@/server/approvals/types'
import { getDb } from '@/server/db/client'

afterAll(closeAll)

const kind = uniq('t_inbox')
let drafts: ApprovalDraft[] = []
registerApprovalSource({ kind, listPending: async () => drafts.filter(d => d.kind === kind) })

const H = 3600_000, D = 24 * H
const deciders = [
  { level: 0 as const, label: 'Accommodation Admin', action: 'requests_waitlist.approve' as const, notify: 'AA' as const },
  { level: 1 as const, label: 'Policy Approver', action: 'requests_waitlist.approve_exception' as const, notify: 'PolicyApprover' as const },
]
const draft = (o: Partial<ApprovalDraft> & Pick<ApprovalDraft, 'siteId' | 'ref'>): ApprovalDraft => ({
  kind, subjectStaffIds: [], title: 'Request', sub: '', createdAt: Date.UTC(2026, 9, 12, 9), href: '/x', deciders, ...o,
})
const actorOf = (role: any, sites: string[] | 'all', staffId?: string, caps: any[] = []) => buildActor({ assignments: [{ id: 'a', role, scopeKind: sites === 'all' ? 'all' : 'site', siteId: null, buildingId: null }], caps }, role, staffId)
const actor = (role: any, sites: string[] | 'all', staffId?: string, caps: any[] = []) => ({ role, caps, sites, staffId }) as any

describe('approvals inbox', () => {
  it('shows only items in the viewer\'s scope, and nothing to roles that cannot decide', async () => {
    const [a, b] = [await newSite(), await newSite()]
    drafts = [draft({ siteId: a, ref: 'r-a' }), draft({ siteId: b, ref: 'r-b' })]
    const now = new Date(Date.UTC(2026, 9, 12, 10))
    expect((await listInbox(getDb(), actor('AA', [a]), now)).map(i => i.ref)).toEqual(['r-a'])
    expect((await listInbox(getDb(), actor('SA', 'all'), now)).map(i => i.ref).sort()).toEqual(['r-a', 'r-b'])
    expect(await listInbox(getDb(), actor('Rec', [a]), now)).toEqual([])
    expect(await listInbox(getDb(), actor('Res', []), now)).toEqual([])
    void actorOf
  })

  it('"why you can\'t approve": the subject and the one who raised it are blocked (D-26)', async () => {
    const site = await newSite()
    drafts = [draft({ siteId: site, ref: 'self', subjectStaffIds: ['me'] }), draft({ siteId: site, ref: 'raised', raisedByStaffId: 'me' }), draft({ siteId: site, ref: 'other' })]
    const items = await listInbox(getDb(), actor('AA', [site], 'me'), new Date(Date.UTC(2026, 9, 12, 10)))
    const by = Object.fromEntries(items.map(i => [i.ref, i]))
    expect(by.self.mine).toBe(false)
    expect(by.self.why).toMatch(/separation of duties/)
    expect(by.raised.mine).toBe(false)
    expect(by.other.mine).toBe(true)
    expect(by.other.why).toBeUndefined()
  })

  it('a Policy Approver sees the item from the start but may only decide it once it is routed to the backup level', async () => {
    const site = await newSite()
    drafts = [draft({ siteId: site, ref: 'x', createdAt: Date.UTC(2026, 9, 12, 9) })]
    const pa = actor('AA', [site], 'pa', ['PolicyApprover'])
    const onlyPa = { ...pa, role: 'Mgr' } // holds PolicyApprover, not the AA role
    const early = await listInbox(getDb(), onlyPa, new Date(Date.UTC(2026, 9, 12, 10)))
    expect(early).toHaveLength(1)
    expect(early[0].mine).toBe(false)
    expect(early[0].why).toMatch(/Waiting for Accommodation Admin/)
    const late = await listInbox(getDb(), onlyPa, new Date(Date.UTC(2026, 9, 14, 10))) // 2 business days
    expect(late[0].clock.level).toBe(1)
    expect(late[0].mine).toBe(true)
    expect(late[0].current).toBe('Policy Approver')
  })

  it('urgent first, then the most escalated, then the oldest', async () => {
    const site = await newSite()
    drafts = [
      draft({ siteId: site, ref: 'old', createdAt: Date.UTC(2026, 9, 12, 9) }),
      draft({ siteId: site, ref: 'new', createdAt: Date.UTC(2026, 9, 14, 8) }),
      draft({ siteId: site, ref: 'urgent', createdAt: Date.UTC(2026, 9, 14, 9), urgent: true }),
    ]
    const items = await listInbox(getDb(), actor('SA', 'all'), new Date(Date.UTC(2026, 9, 14, 10)))
    expect(items.filter(i => ['old', 'new', 'urgent'].includes(i.ref)).map(i => i.ref)).toEqual(['urgent', 'old', 'new'])
  })

  it('reading the inbox decides nothing', async () => {
    const site = await newSite()
    drafts = [draft({ siteId: site, ref: 'z', createdAt: Date.UTC(2026, 8, 1) })]
    const before = JSON.stringify(drafts)
    await listInbox(getDb(), actor('SA', 'all'), new Date(Date.UTC(2026, 9, 20)))
    expect(JSON.stringify(drafts)).toBe(before)
    void makeUser; void grantCapability; void D
  })
})
