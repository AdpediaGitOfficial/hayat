/**
 * WP-I sweep: keys and assets held past their time.
 *
 * What it may do: tell Reception once when an item becomes overdue, and the Accommodation Admin once after a further grace
 * period (`keys.overdue_grace_days`). What it NEVER does: mark an item returned, lost or damaged, retire it, or touch the holder
 * or their stay. Overdue is computed (see queries/keys/overdue.ts), so there is no status to forget. Each item runs in its own
 * transaction under a row lock and is keyed by the issue (the item id and its issued_at), so running the sweep twice, or two
 * instances at once, notifies once, and a later re-issue of the same key starts a new reminder cycle.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { site } from '@/server/db/schema'
import { handoverItem } from '@/server/db/schema.stage3'
import { registerSweep, systemTx, auditSystem } from '@/server/jobs/registry'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { loadHolderFacts, overdueState, overdueText, localDate } from '@/server/queries/keys/overdue'

registerSweep({
  name: 'keys_overdue',
  description: 'Tells Reception once when a key or asset becomes overdue, and the Accommodation Admin once after a further grace period. Never marks anything returned or lost.',
  async run(ctx) {
    const out = { reception: 0, admin: 0, checked: 0 }
    const grace = await getConfig(ctx.db, 'keys.overdue_grace_days')
    const cands = await ctx.db.select({ id: handoverItem.id }).from(handoverItem)
      .where(and(eq(handoverItem.status, 'issued'), isNull(handoverItem.archivedAt))).limit(5000)
    for (const cand of cands) {
      try {
        await systemTx(ctx, async tx => {
          // Under the item's row lock: a return or a re-issue in flight is either seen or waits for us.
          const [item] = await tx.select().from(handoverItem).where(eq(handoverItem.id, cand.id)).limit(1).for('update')
          if (!item || item.status !== 'issued' || !item.holderStaffId || !item.issuedAt || item.archivedAt) return
          const [s] = await tx.select({ tz: site.timeZone }).from(site).where(eq(site.id, item.siteId)).limit(1)
          const facts = await loadHolderFacts(tx, [item.holderStaffId])
          const holder = facts.get(item.holderStaffId)
          const o = overdueState({ status: item.status, dueBack: item.dueBack, timeZone: s?.tz ?? 'UTC', now: ctx.now, graceDays: grace, holder })
          out.checked++
          if (!o.overdue) return
          const label = `${item.itemType.replace(/_/g, ' ')} ${item.code}`
          const why = overdueText(o, { dueBack: item.dueBack, lastEnded: holder?.lastEnded ? localDate(holder.lastEnded, s?.tz ?? 'UTC') : null })
          const cycle = `${item.id}:${item.issuedAt.getTime()}`
          const rec = await notify(tx, {
            dedupeKey: `keys:${cycle}:overdue`, kind: 'keys.overdue', to: { role: 'Rec', siteId: item.siteId }, ref: { type: 'handover_item', id: item.id },
            text: `${label} is overdue: ${why}. Arrange its return, or record it as lost or damaged. Nothing is marked returned automatically.`,
          })
          const adm = o.daysOver > grace
            ? await notify(tx, {
              dedupeKey: `keys:${cycle}:overdue_aa`, kind: 'keys.overdue_escalated', to: { role: 'AA', siteId: item.siteId }, ref: { type: 'handover_item', id: item.id },
              text: `${label} has been overdue for ${o.daysOver} days (${why}) and is still not returned. Reception has been told.`,
            })
            : false
          if (rec) out.reception++
          if (adm) out.admin++
          if (rec || adm) {
            await auditSystem(tx, ctx, {
              action: 'keys.item.overdue_notified', entityType: 'handover_item', entityId: item.id, siteId: item.siteId,
              reason: why, after: { since: o.since, reason: o.reason, daysOver: o.daysOver, reception: rec, admin: adm },
            })
          }
        })
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: 'keys overdue step failed', itemId: cand.id, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return out
  },
})
