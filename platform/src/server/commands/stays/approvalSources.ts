/**
 * Approval sources for WP-F: transfers, swaps and extensions (APPROVALS.md). Registered by one import line in the WP-F block of
 * src/server/approvals/sources.ts. The inbox merges them, applies scope and separation of duties and shows "why you can't
 * approve"; the generic approval sweep reminds (1 business day), routes to the backup (2) and escalates (3). It only
 * reminds: nothing here, or in the sweep, ever decides.
 *
 * Voluntary checkout has no approval (D-63): Reception processes it, and its acknowledgement reminder is the stays sweep.
 */
import { eq, inArray } from 'drizzle-orm'
import { site, staffProfile } from '@/server/db/schema'
import { extensionRequest, transferRequest } from '@/server/db/schema.stays'
import { registerApprovalSource } from '@/server/approvals/registry'
import type { ApprovalDraft, ApprovalSource, Decider } from '@/server/approvals/types'
import { escalationBackupOn, mayDecideNow, waitingReason } from '@/server/approvals/escalation'

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

/**
 * Transfers and swaps. A same-site request is ONE inbox item at its site. A cross-site request (D-104) needs two keys, so it is one
 * item PER MISSING KEY, each at the site that owns it, and "mine" is true only for someone who can approve that side:
 *   kind `transfer` / `swap`        the source site's key (a same-site request is this item too),
 *   kind `transfer_in` / `swap_in`  the destination site's key (and, for a transfer, the choice of bed there).
 * The items are separate kinds because the reminder sweep keys its notifications by kind and reference, so each site is reminded
 * and escalated on its own clock. Both clocks start when the request was raised (or failed); one key given does not reset the other.
 */
const transferSource = (kind: 'transfer' | 'swap', side: 'source' | 'destination'): ApprovalSource => ({
  kind: side === 'source' ? kind : `${kind}_in`,
  async listPending(db) {
    const rows = await db.select().from(transferRequest).where(eq(transferRequest.kind, kind))
    const backupOn = await escalationBackupOn(db)
    const open = rows.filter(r => (r.status === 'requested' || r.status === 'failed')
      && (side === 'source' ? !r.sourceApprovedAt : !!r.destinationSiteId && r.destinationSiteId !== r.siteId && !r.destinationApprovedAt))
    const who = await names(db, open.flatMap(r => [r.staffId, ...(r.otherStaffId ? [r.otherStaffId] : [])]))
    const siteIds = [...new Set(open.flatMap(r => [r.siteId, r.destinationSiteId]))]
    const siteName = new Map((siteIds.length ? await db.select({ id: site.id, name: site.name }).from(site).where(inArray(site.id, siteIds)) : []).map(s => [s.id, s.name]))
    return open.map((r): ApprovalDraft => {
      const failed = r.status === 'failed'
      const cross = r.destinationSiteId !== r.siteId
      const [from, to] = [siteName.get(r.siteId) ?? 'the source site', siteName.get(r.destinationSiteId) ?? 'the destination site']
      const person = who.get(r.staffId) ?? 'resident'
      const draftSite = side === 'source' ? r.siteId : r.destinationSiteId
      const subjectStaffIds = [r.staffId, ...(r.otherStaffId ? [r.otherStaffId] : [])]
      const route = cross ? (side === 'source' ? ` (move out of ${from}, into ${to})` : ` (move into ${to}, out of ${from})`) : ''
      return {
        kind: side === 'source' ? kind : `${kind}_in`, ref: r.id, siteId: draftSite,
        subjectStaffIds,
        raisedByStaffId: r.requestedByStaffId ?? undefined,
        title: kind === 'swap'
          ? `Bed swap${route}: ${person} and ${who.get(r.otherStaffId ?? '') ?? 'resident'}`
          : `${failed ? 'Transfer failed, choose another bed' : 'Transfer'}${route}: ${person}`,
        sub: failed ? `Nothing moved. ${r.failureReason ?? ''}` : cross && side === 'destination' && kind === 'transfer' ? `${r.reason} (you choose the bed in ${to})` : r.reason,
        // A failed execution restarts the clock: the Accommodation Admin has to choose again.
        createdAt: (failed && r.failedAt ? r.failedAt : r.createdAt).getTime(),
        deciders: primaryAndBackup('transfers_swaps.approve'),
        // The same rule approveTransfer / rejectTransfer apply to this side (P-01, pending sign-off): the inbox and the API agree.
        decidable: (actor, ctx) => mayDecideNow(actor, { primary: 'transfers_swaps.approve', siteId: draftSite, backupOn, subjectStaffIds, raisedByStaffId: r.requestedByStaffId ?? undefined }, ctx),
        whyNot: () => waitingReason('the Accommodation Admin', backupOn),
        href: '/stays/transfers',
      }
    })
  },
})

registerApprovalSource(transferSource('transfer', 'source'))
registerApprovalSource(transferSource('swap', 'source'))
registerApprovalSource(transferSource('transfer', 'destination'))
registerApprovalSource(transferSource('swap', 'destination'))

registerApprovalSource({
  kind: 'extension',
  async listPending(db) {
    const open = await db.select().from(extensionRequest).where(eq(extensionRequest.status, 'requested'))
    const backupOn = await escalationBackupOn(db)
    const who = await names(db, open.map(r => r.staffId))
    return open.map((r): ApprovalDraft => ({
      kind: 'extension', ref: r.id, siteId: r.siteId, subjectStaffIds: [r.staffId], raisedByStaffId: r.requestedByStaffId ?? undefined,
      // The same rule approveExtension / rejectExtension apply (P-01, pending sign-off): the inbox and the API agree.
      decidable: (actor, ctx) => mayDecideNow(actor, {
        primary: r.beyondPolicy ? 'reservations_stays.approve_extension_beyond_policy' : 'reservations_stays.approve_extension', siteId: r.siteId, backupOn,
        subjectStaffIds: [r.staffId], raisedByStaffId: r.requestedByStaffId ?? undefined,
      }, ctx),
      whyNot: () => waitingReason(r.beyondPolicy ? 'a Policy Approver' : 'the Accommodation Admin', backupOn),
      title: `Extension${r.beyondPolicy ? ' beyond policy' : ''}: ${who.get(r.staffId) ?? 'resident'} until ${r.newEnd}`,
      sub: `${r.addedDays} days more${r.reason ? `: ${r.reason}` : ''}`,
      createdAt: r.createdAt.getTime(),
      deciders: r.beyondPolicy ? beyondPolicy : primaryAndBackup('reservations_stays.approve_extension'),
      href: `/stays/${r.stayId}`,
    }))
  },
})
