/**
 * Approval sources for WP-F: transfers, swaps and extensions (APPROVALS.md). Registered by one import line in the WP-F block of
 * src/server/approvals/sources.ts. The inbox merges them, applies scope and separation of duties and shows "why you can't
 * approve"; the generic approval sweep reminds (1 business day), routes to the backup (2) and escalates (3). It only
 * reminds: nothing here, or in the sweep, ever decides.
 *
 * Voluntary checkout has no approval (D-63): Reception processes it, and its acknowledgement reminder is the stays sweep.
 */
import { eq, inArray } from 'drizzle-orm'
import { staffProfile } from '@/server/db/schema'
import { extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { registerApprovalSource } from '@/server/approvals/registry'
import type { ApprovalDraft, ApprovalSource, Decider } from '@/server/approvals/types'

const primaryAndBackup = (primary: 'transfers_swaps.approve' | 'reservations_stays.approve_extension'): Decider[] => [
  { level: 0, label: 'Accommodation Admin', action: primary, notify: 'AA' },
  { level: 1, label: 'Policy Approver or backup approver', action: 'approvals_inbox.decide_escalated', notify: 'PolicyApprover' },
  { level: 2, label: 'Policy Approver / Super Admin', action: 'approvals_inbox.decide_escalated', notify: 'SA' },
]
const beyondPolicy: Decider[] = [
  { level: 0, label: 'Policy Approver', action: 'reservations_stays.approve_extension_beyond_policy', notify: 'PolicyApprover' },
  { level: 1, label: 'Backup approver', action: 'approvals_inbox.decide_escalated', notify: 'BackupApprover' },
  { level: 2, label: 'Policy Approver / Super Admin', action: 'approvals_inbox.decide_escalated', notify: 'SA' },
]

async function names(db: Parameters<ApprovalSource['listPending']>[0], ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db.select({ id: staffProfile.id, name: staffProfile.fullName }).from(staffProfile).where(inArray(staffProfile.id, unique))
  return new Map(rows.map(r => [r.id, r.name]))
}

const transferSource = (kind: 'transfer' | 'swap'): ApprovalSource => ({
  kind,
  async listPending(db) {
    const rows = await db.select().from(transferRequest).where(eq(transferRequest.kind, kind))
    const open = rows.filter(r => r.status === 'requested' || r.status === 'failed')
    const who = await names(db, open.flatMap(r => [r.staffId, ...(r.otherStaffId ? [r.otherStaffId] : [])]))
    return open.map((r): ApprovalDraft => {
      const failed = r.status === 'failed'
      return {
        kind, ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId, ...(r.otherStaffId ? [r.otherStaffId] : [])],
        raisedByStaffId: r.requestedByStaffId ?? undefined,
        title: kind === 'swap' ? `Bed swap: ${who.get(r.staffId) ?? 'resident'} and ${who.get(r.otherStaffId ?? '') ?? 'resident'}` : `${failed ? 'Transfer failed, choose another bed' : 'Transfer'}: ${who.get(r.staffId) ?? 'resident'}`,
        sub: failed ? `Nothing moved. ${r.failureReason ?? ''}` : r.reason,
        // A failed execution restarts the clock: the Accommodation Admin has to choose again.
        createdAt: (failed && r.failedAt ? r.failedAt : r.createdAt).getTime(),
        deciders: primaryAndBackup('transfers_swaps.approve'),
        href: '/stays/transfers',
      }
    })
  },
})

registerApprovalSource(transferSource('transfer'))
registerApprovalSource(transferSource('swap'))

registerApprovalSource({
  kind: 'extension',
  async listPending(db) {
    const open = await db.select().from(extensionRequest).where(eq(extensionRequest.status, 'requested'))
    const who = await names(db, open.map(r => r.staffId))
    return open.map((r): ApprovalDraft => ({
      kind: 'extension', ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId], raisedByStaffId: r.requestedByStaffId ?? undefined,
      title: `Extension${r.beyondPolicy ? ' beyond policy' : ''}: ${who.get(r.staffId) ?? 'resident'} until ${r.newEnd}`,
      sub: `${r.addedDays} days more${r.reason ? `: ${r.reason}` : ''}`,
      createdAt: r.createdAt.getTime(),
      deciders: r.beyondPolicy ? beyondPolicy : primaryAndBackup('reservations_stays.approve_extension'),
      href: `/stays/${r.stayId}`,
    }))
  },
})
