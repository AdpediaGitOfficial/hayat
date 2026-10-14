/**
 * Reminds and escalates pending approvals (reminder at 1 business day, backup at the SLA, escalation after it).
 * It only sends notifications. It never decides anything.
 */
import { registerSweep, systemTx } from '@/server/jobs/registry'
import { notify } from '@/server/notify'
import { draftClock, pendingDrafts } from './inbox'
import './sources'

registerSweep({
  name: 'approval_reminders',
  description: 'Reminds approvers at 1 business day, routes to the backup at the SLA and escalates after it. Never decides.',
  async run(ctx) {
    const out = { reminded: 0, backup: 0, escalated: 0 }
    for (const d of await pendingDrafts(ctx.db, ctx.now)) {
      if (d.ownClock) continue // that source runs its own sweep
      const clock = await draftClock(ctx.db, d, ctx.now)
      if (clock.reminders === 0) continue
      const at = (lvl: 0 | 1 | 2) => d.deciders.find(x => x.level === lvl) ?? d.deciders[d.deciders.length - 1]
      const text = `${d.title}: waiting ${clock.businessDays} business day${clock.businessDays === 1 ? '' : 's'}`
      await systemTx(ctx, async tx => {
        if (await notify(tx, { dedupeKey: `approval:${d.kind}:${d.ref}:reminder${Math.min(clock.reminders, 1)}`, kind: 'approval.reminder', to: { role: at(0).notify, siteId: d.siteId }, text: `Reminder: ${text}`, ref: { type: d.kind, id: d.ref } })) out.reminded++
        if (clock.level >= 1 && await notify(tx, { dedupeKey: `approval:${d.kind}:${d.ref}:backup`, kind: 'approval.backup', to: { role: at(1).notify, siteId: d.siteId }, text: `Routed to you as ${at(1).label}: ${text}`, ref: { type: d.kind, id: d.ref } })) out.backup++
        if (clock.level >= 2 && await notify(tx, { dedupeKey: `approval:${d.kind}:${d.ref}:escalated`, kind: 'approval.escalated', to: { role: at(2).notify, siteId: d.siteId }, text: `Escalated to you as ${at(2).label}: ${text}`, ref: { type: d.kind, id: d.ref }, critical: true })) out.escalated++
      })
    }
    return out
  },
})
