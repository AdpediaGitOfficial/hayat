/**
 * WP-H sweep: clearance cases past their due date.
 *
 * A case still open after its due date tells the Accommodation Admin of the stay's site (any Accommodation Admin when the case has
 * no site), once. After `clearance.escalate_after_business_days` more business days it tells the Policy Approver, once. That is ALL
 * it does: it never closes a case, completes an item, waives anything or touches a stay or a bed. Every step is keyed
 * (notification dedupe keys), runs in its own transaction under a row lock, and reads time only from ctx.now.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { clearanceCase } from '@/server/db/schema.exit'
import { site, staffProfile } from '@/server/db/schema'
import { auditSystem, registerSweep, systemTx } from '@/server/jobs/registry'
import { getConfig } from '@/server/config/registry'
import { loadCalendar } from '@/server/eligibility'
import { notify } from '@/server/notify'
import { todayInZone } from '@/server/commands/property/shared'
import { businessDaysAfter } from '@/server/commands/exit/rules'
import { OPEN_CASE_STATUSES } from '@/server/commands/exit/shared'

registerSweep({
  name: 'exit_clearance_overdue',
  description: 'Reminds the Accommodation Admin when a clearance case is past its due date and escalates to the Policy Approver after the configured business days. Never closes, completes or waives anything.',
  async run(ctx) {
    const out = { overdue: 0, escalated: 0, skipped: 0 }
    const escalateAfter = await getConfig(ctx.db, 'clearance.escalate_after_business_days')
    // Coarse filter in SQL (due before tomorrow in the widest zone); the exact local day is decided per case under the row lock.
    const cands = await ctx.db.select({ id: clearanceCase.id }).from(clearanceCase)
      .where(and(inArray(clearanceCase.status, [...OPEN_CASE_STATUSES]), lt(clearanceCase.dueDate, sql`((${ctx.now.toISOString()}::timestamptz at time zone 'UTC')::date + 2)`))).limit(1000)
    for (const cand of cands) {
      try {
        await systemTx(ctx, async tx => {
          const [k] = await tx.select().from(clearanceCase).where(eq(clearanceCase.id, cand.id)).limit(1).for('update')
          if (!k || k.status === 'cleared') { out.skipped++; return }
          const tz = k.siteId ? (await tx.select({ tz: site.timeZone }).from(site).where(eq(site.id, k.siteId)).limit(1))[0]?.tz ?? 'UTC' : 'UTC'
          const today = todayInZone(ctx.now, tz)
          if (today <= k.dueDate) { out.skipped++; return } // due today is not overdue yet
          const [p] = await tx.select({ name: staffProfile.fullName, employeeId: staffProfile.employeeId }).from(staffProfile).where(eq(staffProfile.id, k.staffId)).limit(1)
          const who = `${p?.name ?? 'A former employee'} (${p?.employeeId ?? ''})`
          const aa = await notify(tx, {
            dedupeKey: `clearance:${k.id}:overdue`, kind: 'exit.clearance_overdue', to: k.siteId ? { role: 'AA', siteId: k.siteId } : { role: 'AA' }, ref: { type: 'clearance_case', id: k.id },
            text: `Clearance for ${who} was due on ${k.dueDate} and is still ${k.status.replace('_', ' ')}. Please follow up with the owners of the open items.`,
          })
          if (aa) {
            out.overdue++
            await auditSystem(tx, ctx, { action: 'exit.clearance.overdue_flagged', entityType: 'clearance_case', entityId: k.id, siteId: k.siteId ?? undefined, reason: 'Past the due date', after: { dueDate: k.dueDate, status: k.status, closed: false } })
          }
          const late = businessDaysAfter(k.dueDate, today, await loadCalendar(tx, k.siteId ?? undefined))
          if (late >= escalateAfter) {
            const pa = await notify(tx, {
              dedupeKey: `clearance:${k.id}:escalated`, kind: 'exit.clearance_escalated', critical: true,
              to: k.siteId ? { role: 'PolicyApprover', siteId: k.siteId } : { role: 'PolicyApprover' }, ref: { type: 'clearance_case', id: k.id },
              text: `Escalated: clearance for ${who} is ${late} business day${late === 1 ? '' : 's'} past its due date (${k.dueDate}). Nothing was closed or waived; please decide with the Accommodation Admin how to proceed.`,
            })
            if (pa) {
              out.escalated++
              await auditSystem(tx, ctx, { action: 'exit.clearance.overdue_escalated', entityType: 'clearance_case', entityId: k.id, siteId: k.siteId ?? undefined, reason: `More than ${escalateAfter} business days overdue`, after: { dueDate: k.dueDate, status: k.status, closed: false } })
            }
          }
        })
      } catch (e) {
        out.skipped++
        console.error(JSON.stringify({ level: 'error', msg: 'clearance overdue step failed', caseId: cand.id, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return out
  },
})
