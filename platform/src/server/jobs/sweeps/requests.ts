/**
 * WP-D sweep: delegation reminders (D-32). When an approver has named a stand-in for today, the stand-in is told about the
 * approvals that have waited a business day or more for the person they cover. It only sends notifications; it adds no
 * authority and no scope, and it never decides anything (the stand-in decides only what their own role allows, S-13).
 */
import { and, eq, isNull, lte, gte } from 'drizzle-orm'
import { delegation, staffProfile, userAccount } from '@/server/db/schema'
import { loadAccess } from '@/server/auth/actor'
import { approverScope, approvesAt } from '@/server/commands/approvals/approvers'
import { draftClock, pendingDrafts } from '@/server/approvals/inbox'
import { registerSweep, systemTx } from '@/server/jobs/registry'
import { notify } from '@/server/notify'

registerSweep({
  name: 'delegation_reminders',
  description: 'Tells a stand-in what has been waiting for the approver they cover. Reminds only; adds no authority.',
  async run(ctx) {
    const out = { delegations: 0, notified: 0 }
    const today = ctx.now.toISOString().slice(0, 10)
    const active = await ctx.db.select({
      id: delegation.id, fromUserId: delegation.fromUserId, toUserId: delegation.toUserId,
    }).from(delegation).where(and(isNull(delegation.revokedAt), lte(delegation.startsOn, today), gte(delegation.endsOn, today)))
    out.delegations = active.length
    if (active.length === 0) return out

    const people = new Map<string, { staffId: string | null; name: string | null }>()
    for (const d of active) {
      for (const uid of [d.fromUserId, d.toUserId]) {
        if (people.has(uid)) continue
        const [u] = await ctx.db.select({ staffId: userAccount.staffId, name: staffProfile.fullName }).from(userAccount).leftJoin(staffProfile, eq(staffProfile.id, userAccount.staffId)).where(eq(userAccount.id, uid))
        people.set(uid, { staffId: u?.staffId ?? null, name: u?.name ?? null })
      }
    }
    const scopes = new Map<string, ReturnType<typeof approverScope>>()
    for (const d of active) {
      if (!scopes.has(d.fromUserId)) scopes.set(d.fromUserId, approverScope(await loadAccess(ctx.db, d.fromUserId, ctx.now), people.get(d.fromUserId)?.staffId ?? undefined))
    }

    for (const draft of await pendingDrafts(ctx.db, ctx.now)) {
      if (draft.ownClock) continue
      const clock = await draftClock(ctx.db, draft, ctx.now)
      if (clock.reminders === 0) continue
      for (const d of active) {
        const away = people.get(d.fromUserId)!
        const cover = people.get(d.toUserId)!
        if (!cover.staffId) continue
        // Not about the person who is away, or the one covering (they cannot decide their own, D-26).
        if (away.staffId && (draft.subjectStaffIds.includes(away.staffId) || draft.raisedByStaffId === away.staffId)) continue
        if (draft.subjectStaffIds.includes(cover.staffId) || draft.raisedByStaffId === cover.staffId) continue
        if (!draft.deciders.some(x => x.level <= clock.level && approvesAt(scopes.get(d.fromUserId)!, draft.siteId, x.action))) continue
        const sent = await systemTx(ctx, tx => notify(tx, {
          dedupeKey: `approval:${draft.kind}:${draft.ref}:delegate:${d.id}`, kind: 'approval.delegate_reminder', to: { staffId: cover.staffId! },
          text: `Covering for ${away.name ?? 'a colleague'}: ${draft.title} has waited ${clock.businessDays} business day${clock.businessDays === 1 ? '' : 's'}`,
          ref: { type: draft.kind, id: draft.ref },
        }))
        if (sent) out.notified++
      }
    }
    return out
  },
})
