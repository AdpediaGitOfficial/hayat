/**
 * Approval source for a Policy Approver exception on a transfer or swap destination (S-21, P-10; PROPOSED, pending client sign-off).
 * Registered by one import in the WP-N block of src/server/approvals/sources.ts. The inbox shows the item to the Policy Approvers of the
 * DESTINATION site (the scope of the decision), the reminder sweep reminds, backs up and escalates it like any other approval. It only
 * describes; granting or declining is `grantTransferException` / `declineTransferException`. With `transfers.exception_path` off there are
 * no items.
 *
 * One item per person who needs an exception: kind `transfer_exception` for the person who moves in a transfer (or the first resident of a
 * swap), `transfer_exception_other` for the second resident of a swap (their destination is the first resident's site).
 */
import { inArray } from 'drizzle-orm'
import { site, staffProfile } from '@/server/db/schema'
import { transferRequest } from '@/server/db/schema.stays'
import { registerApprovalSource } from '@/server/approvals/registry'
import type { ApprovalDraft, ApprovalSource } from '@/server/approvals/types'
import { EXCEPTION_DECIDERS } from '@/server/commands/approvals/sources'
import { getConfig } from '@/server/config/registry'
import { OPEN_FOR_EXCEPTION, exceptionNeeds } from './transferException'

const source = (kind: 'transfer_exception' | 'transfer_exception_other', party: 'first' | 'second'): ApprovalSource => ({
  kind,
  async listPending(db, now) {
    if (!(await getConfig(db, 'transfers.exception_path'))) return []
    const open = (await db.select().from(transferRequest).where(inArray(transferRequest.status, OPEN_FOR_EXCEPTION)))
      .filter(t => party === 'first' || t.kind === 'swap')
    if (open.length === 0) return []
    const people = new Map((await db.select({ id: staffProfile.id, name: staffProfile.fullName, employeeId: staffProfile.employeeId }).from(staffProfile)
      .where(inArray(staffProfile.id, [...new Set(open.flatMap(t => [t.staffId, ...(t.otherStaffId ? [t.otherStaffId] : [])]))]))).map(p => [p.id, p]))
    const siteIds = [...new Set(open.flatMap(t => [t.siteId, t.destinationSiteId]))]
    const siteName = new Map((await db.select({ id: site.id, name: site.name }).from(site).where(inArray(site.id, siteIds))).map(s => [s.id, s.name]))
    const out: ApprovalDraft[] = []
    for (const t of open) {
      for (const need of await exceptionNeeds(db, t, now)) {
        if (need.state !== 'waiting' || need.party !== party) continue
        const who = people.get(need.staffId)
        const from = need.party === 'first' ? t.siteId : t.destinationSiteId
        out.push({
          kind, ref: t.id, siteId: need.siteId,
          subjectStaffIds: [t.staffId, ...(t.otherStaffId ? [t.otherStaffId] : [])],
          raisedByStaffId: t.requestedByStaffId ?? undefined,
          title: `${who?.name ?? 'Resident'} (${who?.employeeId ?? ''}): ${need.failed.join(' and ')} exception for a ${t.kind === 'swap' ? 'swap' : 'transfer'} into ${siteName.get(need.siteId) ?? 'the destination site'}`,
          sub: `From ${siteName.get(from) ?? 'the other site'} · ${need.reasons.join('; ')} · proposed policy, pending client sign-off`,
          // The clock runs from when the request reached this point: raised, or the last failed attempt.
          createdAt: (t.status === 'failed' && t.failedAt ? t.failedAt : t.createdAt).getTime(),
          deciders: EXCEPTION_DECIDERS, href: '/stays/transfers',
        })
      }
    }
    return out
  },
})

registerApprovalSource(source('transfer_exception', 'first'))
registerApprovalSource(source('transfer_exception_other', 'second'))

