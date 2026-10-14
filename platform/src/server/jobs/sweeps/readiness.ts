/**
 * WP-J sweep: cleaning and inspection reminders (GH-18 placeholder: `readiness.cleaning_sla_hours`).
 *
 * Per stage, once each (event-based dedupe keys, so running twice or concurrently reminds once):
 *   open task (not assigned, or assigned and not cleaned)  after 1 x SLA since it was opened  -> Reception
 *                                                           after 2 x SLA                      -> Accommodation Admin
 *   cleaned task waiting for the final inspection          after 1 x SLA since it was cleaned -> Reception
 *                                                           after 2 x SLA                      -> Accommodation Admin
 * It NEVER assigns, cleans, inspects, cancels or releases a bed (CLAUDE.md: timeouts only remind and escalate). Each task runs in its
 * own transaction under a row lock, with the status re-checked, so one bad row never blocks the rest.
 */
import { and, eq, inArray, lte, or } from 'drizzle-orm'
import { bed, room } from '@/server/db/schema'
import { cleaningTask } from '@/server/db/schema.stage3'
import { registerSweep, systemTx, auditSystem } from '@/server/jobs/registry'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'

const HOUR = 3_600_000

registerSweep({
  name: 'readiness_cleaning_reminders',
  description: 'Reminds Reception when a cleaning task is unassigned or not cleaned, or a cleaned bed waits for its inspection, after the SLA; tells the Accommodation Admin after a second period. Never assigns, cleans, inspects or releases a bed.',
  async run(ctx) {
    const out = { checked: 0, remindedReception: 0, escalatedAdmin: 0, skipped: 0 }
    const hours = await getConfig(ctx.db, 'readiness.cleaning_sla_hours')
    const first = new Date(ctx.now.getTime() - hours * HOUR)
    // Coarse filter in SQL (the first period); the exact stage and period are re-checked under the row lock.
    const cands = await ctx.db.select({ id: cleaningTask.id }).from(cleaningTask).where(or(
      and(eq(cleaningTask.status, 'open'), lte(cleaningTask.createdAt, first)),
      and(eq(cleaningTask.status, 'cleaned'), lte(cleaningTask.cleanedAt, first)),
    )).limit(1000)
    for (const cand of cands) {
      out.checked++
      try {
        await systemTx(ctx, async tx => {
          const [r] = await tx.select({
            id: cleaningTask.id, status: cleaningTask.status, siteId: cleaningTask.siteId, createdAt: cleaningTask.createdAt, cleanedAt: cleaningTask.cleanedAt,
            assignee: cleaningTask.assignedToStaff, bedCode: bed.code, roomName: room.name,
          }).from(cleaningTask).innerJoin(bed, eq(bed.id, cleaningTask.bedId)).innerJoin(room, eq(room.id, bed.roomId))
            .where(and(eq(cleaningTask.id, cand.id), inArray(cleaningTask.status, ['open', 'cleaned']))).limit(1).for('update', { of: cleaningTask })
          if (!r) { out.skipped++; return }
          const stage = r.status === 'open' ? 'open' : 'cleaned'
          const since = stage === 'open' ? r.createdAt : r.cleanedAt
          if (!since) { out.skipped++; return }
          const waited = ctx.now.getTime() - since.getTime()
          if (waited < hours * HOUR) { out.skipped++; return }
          const base = `cleaning:${r.id}:sla:${stage}`
          let what: string
          if (stage === 'cleaned') what = `is cleaned and has waited for the final inspection for over ${hours} hours`
          else if (!r.assignee) what = `has had no housekeeper assigned for over ${hours} hours`
          else what = `was assigned but is still not cleaned after ${hours} hours`
          const where = `Room ${r.roomName}, bed ${r.bedCode}`

          const rec = await notify(tx, {
            dedupeKey: `${base}:rec`, kind: 'cleaning.sla', to: { role: 'Rec', siteId: r.siteId }, ref: { type: 'cleaning_task', id: r.id },
            text: `${where} ${what}. ${stage === 'cleaned' ? 'A Final Inspection holder needs to inspect it.' : r.assignee ? 'Check with the housekeeper.' : 'Assign a housekeeper.'}`,
          })
          if (rec) {
            out.remindedReception++
            await auditSystem(tx, ctx, { action: 'readiness.cleaning.sla_reminder', entityType: 'cleaning_task', entityId: r.id, siteId: r.siteId, reason: `Cleaning SLA of ${hours} hours passed (${stage})`, after: { stage, assigned: !!r.assignee } })
          }
          if (waited >= 2 * hours * HOUR) {
            const aa = await notify(tx, {
              dedupeKey: `${base}:aa`, kind: 'cleaning.sla_escalated', to: { role: 'AA', siteId: r.siteId }, ref: { type: 'cleaning_task', id: r.id },
              text: `${where} ${what.replace(`over ${hours} hours`, `over ${2 * hours} hours`).replace(`after ${hours} hours`, `after ${2 * hours} hours`)}. Reception was reminded and it still needs someone to act.`,
            })
            if (aa) {
              out.escalatedAdmin++
              await auditSystem(tx, ctx, { action: 'readiness.cleaning.sla_escalated', entityType: 'cleaning_task', entityId: r.id, siteId: r.siteId, reason: `Second cleaning SLA period passed (${stage})`, after: { stage, assigned: !!r.assignee } })
            }
          }
        })
      } catch (e) {
        out.skipped++
        console.error(JSON.stringify({ level: 'error', msg: 'cleaning reminder failed', taskId: cand.id, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return out
  },
})
