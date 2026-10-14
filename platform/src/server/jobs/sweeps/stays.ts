/**
 * WP-F sweeps: no-show, end-of-stay reminders, overdue stays, checkout acknowledgement reminders.
 *
 * What they may do (STAGE-2 section 2, CLAUDE.md): remind, escalate, flag, and release a hold that the rules say lapses.
 * What they NEVER do: approve or reject anything, move a resident, or check anyone out. An overdue stay stays `active`
 * however late it is; a person (Reception) checks it out. Every step runs in its own transaction under a row lock and is
 * keyed (status check plus notification dedupe keys), so running a sweep twice, or two instances at once, does it once.
 * Time comes only from `ctx.now`; "today" is the site's own calendar day.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { bed, bedClaim, reservation, site, stay } from '@/server/db/schema'
import { checkoutRequest } from '@/server/db/schema.stays'
import { registerSweep, systemTx, auditSystem, type SweepContext } from '@/server/jobs/registry'
import { getConfig } from '@/server/config/registry'
import { loadCalendar } from '@/server/eligibility'
import { notify } from '@/server/notify'
import { businessDaysElapsed } from '@/domain/approvals'
import { todayInZone } from '@/server/commands/property/shared'
import { releaseClaim } from '@/server/allocation'
import { endReminderDue, isNoShow, stayFlag } from '@/server/commands/stays/rules'

/* ---------------- no-show (D-58) ---------------- */

/**
 * A reservation still `reserved` more than `timers.no_show_hours` after its expected arrival (twice that once the Accommodation
 * Admin has extended it) lapses: the hold is released so the bed can go to someone else. This releases a hold; it decides
 * nothing about the person, who can be given a new reservation.
 *
 * Reading of the enum: `no_show` when the arrival window passed without anyone arriving (D-58 "No-show"). `expired` only when
 * the whole reserved period had already ended by the time the sweep got to it (a sweep that ran very late).
 */
registerSweep({
  name: 'stays_no_show',
  description: 'Releases the hold of a reservation nobody arrived for, 24 h after the expected arrival (48 h once extended). Never decides about a person.',
  async run(ctx) {
    const out = { released: 0, expired: 0, skipped: 0 }
    const hours = await getConfig(ctx.db, 'timers.no_show_hours')
    // Coarse filter in SQL (the shorter window); the exact rule, including the extension, is re-checked under the row lock.
    const cands = await ctx.db.select({ id: reservation.id }).from(reservation)
      .where(and(eq(reservation.status, 'reserved'), sql`${reservation.eta} < ${ctx.now.toISOString()}::timestamptz - ${`${hours} hours`}::interval`)).limit(500)
    for (const cand of cands) {
      try {
        await systemTx(ctx, async tx => {
          const [r] = await tx.select({
            id: reservation.id, staffId: reservation.staffId, claimId: reservation.claimId, eta: reservation.eta, status: reservation.status, extended: reservation.noShowExtended,
            siteId: bed.siteId, tz: site.timeZone, bedCode: bed.code, to: sql<string | null>`upper(${bedClaim.period})::text`,
          }).from(reservation).innerJoin(bed, eq(bed.id, reservation.bedId)).innerJoin(site, eq(site.id, bed.siteId)).innerJoin(bedClaim, eq(bedClaim.id, reservation.claimId))
            .where(eq(reservation.id, cand.id)).limit(1).for('update', { of: reservation })
          if (!r || r.status !== 'reserved' || !isNoShow(ctx.now.getTime(), r.eta.getTime(), hours, r.extended)) { out.skipped++; return }
          const today = todayInZone(ctx.now, r.tz)
          const lapsed = r.to !== null && r.to <= today ? 'expired' : 'no_show'
          await tx.update(reservation).set({ status: lapsed, cancelReason: lapsed === 'no_show' ? `No-show: not checked in within ${hours * (r.extended ? 2 : 1)} hours of the expected arrival` : 'Expired: the reserved period ended before check-in' }).where(eq(reservation.id, r.id))
          await releaseClaim(tx, r.claimId, lapsed, ctx.now)
          await auditSystem(tx, ctx, {
            action: `stays.reservation.${lapsed}`, entityType: 'reservation', entityId: r.id, siteId: r.siteId,
            reason: lapsed === 'no_show' ? 'No-show rule (D-58)' : 'Reserved period ended', before: { status: 'reserved', claim: 'live' }, after: { status: lapsed, claim: 'released', extended: r.extended },
          })
          await notify(tx, { dedupeKey: `reservation:${r.id}:${lapsed}`, kind: `reservation.${lapsed}`, to: { staffId: r.staffId }, ref: { type: 'reservation', id: r.id }, text: `Your bed reservation (${r.bedCode}) was released because you did not check in. Contact Reception or the Accommodation Admin if you still need a bed.` })
          await notify(tx, { dedupeKey: `reservation:${r.id}:${lapsed}:aa`, kind: `reservation.${lapsed}`, to: { role: 'AA', siteId: r.siteId }, ref: { type: 'reservation', id: r.id }, text: `A reservation for bed ${r.bedCode} lapsed (${lapsed === 'no_show' ? 'no-show' : 'expired'}) and the bed was released.` })
          lapsed === 'no_show' ? out.released++ : out.expired++
        })
      } catch (e) {
        out.skipped++
        console.error(JSON.stringify({ level: 'error', msg: 'no-show step failed', reservationId: cand.id, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return out
  },
})

/* ---------------- shared: active stays with a planned end ---------------- */

interface EndingStay { id: string; staffId: string; siteId: string; tz: string; end: string; bedCode: string }

async function activeStaysWithEnd(ctx: SweepContext, withinDays: number): Promise<EndingStay[]> {
  return ctx.db.select({
    id: stay.id, staffId: stay.staffId, siteId: bed.siteId, tz: site.timeZone, bedCode: bed.code, end: sql<string>`upper(${bedClaim.period})::text`,
  }).from(stay).innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(site, eq(site.id, bed.siteId)).innerJoin(bedClaim, eq(bedClaim.id, stay.claimId))
    .where(and(eq(stay.status, 'active'), isNotNull(sql`upper(${bedClaim.period})`), sql`upper(${bedClaim.period}) <= (${ctx.now.toISOString()}::timestamptz + ${`${withinDays} days`}::interval)::date`))
    .limit(2000)
}

/* ---------------- end-of-stay reminders (D-55) ---------------- */

registerSweep({
  name: 'stays_end_reminders',
  description: 'Reminds the resident and the Accommodation Admin 14, 7 and 1 days before a stay ends (configurable), each once. Never moves or checks out anyone.',
  async run(ctx) {
    const out = { reminded: 0 }
    const days = await getConfig(ctx.db, 'timers.end_reminder_days')
    const widest = Math.max(0, ...days)
    for (const s of await activeStaysWithEnd(ctx, widest + 1)) {
      const due = endReminderDue(s.end, todayInZone(ctx.now, s.tz), days)
      if (due === undefined) continue
      try {
        await systemTx(ctx, async tx => {
          // Keys carry the end date, so an extension re-arms the reminders for the new end.
          const left = `${due} day${due === 1 ? '' : 's'}`
          const a = await notify(tx, { dedupeKey: `stay:${s.id}:end:${due}:${s.end}`, kind: 'stay.end_reminder', to: { staffId: s.staffId }, ref: { type: 'stay', id: s.id }, text: `Your stay ends on ${s.end} (within ${left}). If you need to stay longer, ask for an extension now; otherwise arrange your checkout with Reception.` })
          const b = await notify(tx, { dedupeKey: `stay:${s.id}:end:${due}:${s.end}:aa`, kind: 'stay.end_reminder', to: { role: 'AA', siteId: s.siteId }, ref: { type: 'stay', id: s.id }, text: `A stay in bed ${s.bedCode} ends on ${s.end} (within ${left}).` })
          if (a || b) out.reminded++
        })
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: 'end reminder failed', stayId: s.id, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return out
  },
})

/* ---------------- overdue (D-56) ---------------- */

registerSweep({
  name: 'stays_overdue',
  description: 'Flags a stay that is past its end date on day 1 and escalates to the Policy Approver after the grace days. The stay stays active: a person checks it out, never this sweep.',
  async run(ctx) {
    const out = { flagged: 0, escalated: 0 }
    const grace = await getConfig(ctx.db, 'timers.overdue_grace_days')
    for (const s of await activeStaysWithEnd(ctx, 0)) {
      const f = stayFlag(s.end, todayInZone(ctx.now, s.tz), grace)
      if (f.flag !== 'overdue' && f.flag !== 'escalated') continue
      try {
        await systemTx(ctx, async tx => {
          // Re-read under a lock: the stay may have been checked out or extended a moment ago.
          const [cur] = await tx.select({ status: stay.status, end: sql<string | null>`upper(${bedClaim.period})::text` }).from(stay).innerJoin(bedClaim, eq(bedClaim.id, stay.claimId)).where(eq(stay.id, s.id)).limit(1).for('update', { of: stay })
          if (!cur || cur.status !== 'active' || cur.end !== s.end) return
          const key = `stay:${s.id}:overdue:${s.end}`
          const flagged = await notify(tx, { dedupeKey: key, kind: 'stay.overdue', to: { role: 'AA', siteId: s.siteId }, ref: { type: 'stay', id: s.id }, text: `Overdue: the stay in bed ${s.bedCode} ended on ${s.end} and the resident has not been checked out.` })
          await notify(tx, { dedupeKey: `${key}:resident`, kind: 'stay.overdue', to: { staffId: s.staffId }, ref: { type: 'stay', id: s.id }, text: `Your stay ended on ${s.end}. Please arrange your checkout with Reception, or ask for an extension.` })
          if (flagged) {
            out.flagged++
            await auditSystem(tx, ctx, { action: 'stays.stay.overdue_flagged', entityType: 'stay', entityId: s.id, siteId: s.siteId, reason: 'Past the planned end date (D-56)', after: { end: s.end, daysOver: f.daysOver, status: 'active' } })
          }
          if (f.flag === 'escalated') {
            const esc = await notify(tx, { dedupeKey: `${key}:escalated`, kind: 'stay.overdue_escalated', to: { role: 'PolicyApprover', siteId: s.siteId }, ref: { type: 'stay', id: s.id }, critical: true, text: `Escalated: the stay in bed ${s.bedCode} is ${f.daysOver} days past its end date (${s.end}). No one has been checked out; please decide how to proceed with the Accommodation Admin.` })
            if (esc) {
              out.escalated++
              await auditSystem(tx, ctx, { action: 'stays.stay.overdue_escalated', entityType: 'stay', entityId: s.id, siteId: s.siteId, reason: `More than ${grace} days overdue (D-56)`, after: { end: s.end, daysOver: f.daysOver, status: 'active' } })
            }
          }
        })
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: 'overdue step failed', stayId: s.id, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return out
  },
})

/* ---------------- checkout acknowledgement (D-63) ---------------- */

registerSweep({
  name: 'stays_checkout_reminders',
  description: 'Reminds Reception when a voluntary checkout request is not acknowledged within 1 business day, and tells the Accommodation Admin after 2. Reminds only.',
  async run(ctx) {
    const out = { reminded: 0, escalated: 0 }
    const open = await ctx.db.select({ id: checkoutRequest.id, siteId: checkoutRequest.siteId, createdAt: checkoutRequest.createdAt, departureDate: checkoutRequest.departureDate }).from(checkoutRequest)
      .where(eq(checkoutRequest.status, 'requested')).limit(1000)
    for (const r of open) {
      const days = businessDaysElapsed(r.createdAt.getTime(), ctx.now.getTime(), await loadCalendar(ctx.db, r.siteId))
      if (days < 1) continue
      try {
        await systemTx(ctx, async tx => {
          const [cur] = await tx.select({ status: checkoutRequest.status }).from(checkoutRequest).where(eq(checkoutRequest.id, r.id)).limit(1).for('update')
          if (!cur || cur.status !== 'requested') return
          if (await notify(tx, { dedupeKey: `checkout:${r.id}:ack_reminder`, kind: 'checkout.ack_reminder', to: { role: 'Rec', siteId: r.siteId }, ref: { type: 'checkout_request', id: r.id }, text: `A checkout request (departure ${r.departureDate}) has waited ${days} business day${days === 1 ? '' : 's'} for acknowledgement.` })) out.reminded++
          if (days >= 2 && await notify(tx, { dedupeKey: `checkout:${r.id}:ack_escalated`, kind: 'checkout.ack_escalated', to: { role: 'AA', siteId: r.siteId }, ref: { type: 'checkout_request', id: r.id }, text: `A checkout request (departure ${r.departureDate}) is still not acknowledged after ${days} business days. Please follow up with Reception.` })) out.escalated++
        })
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: 'checkout reminder failed', requestId: r.id, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    return out
  },
})
