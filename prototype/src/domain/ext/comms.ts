/* Notifications with a delivery pipeline (P-3), and the stay timers that generate reminders (P-2).
   Rules: notification failure never changes business state; "accepted by provider" is not "delivered";
   a delivery confirmed by email is one of the ways an offer's 48h clock can start (D-51). */
import type { Persona } from '../types'
import { fail, fullName, guard, log, ok, registerTick, run } from '../core'
import { bedById, deny, staffById } from '../rules'
import { businessDaysBetween, dateStr, dayDiff, nowMs } from '../time'

export const commsActions = {
  /** Demo control: simulate the email provider being unreachable. */
  setEmailProvider(up: boolean) {
    return run(d => {
      d.emailProviderUp = up
      log(d, 'Demo', up ? 'Email provider restored' : 'Email provider outage simulated', 'Queued emails retry with backoff; nothing in the business flow changes')
      return ok(up ? 'Email provider is back. Queued emails will go out' : 'Email provider is now unreachable. Emails will retry, then fail visibly')
    })
  },
  retryNotification(actor: Persona, id: string) {
    return run(d => {
      const e = guard(deny(actor, 'notification.retry', 'retry notifications'))
      if (e) return e
      const n = d.notifications.find(x => x.id === id)
      if (!n || !n.email) return fail('Nothing to retry')
      if (n.emailStatus === 'delivered' || n.emailStatus === 'sent') return fail('Already sent')
      n.emailStatus = 'queued'; n.attempts = 0; n.nextAttemptAt = nowMs() - 1; n.lastError = undefined
      log(d, actor, 'Notification retried', n.text.slice(0, 60))
      return ok('Queued for another attempt')
    })
  },
  acknowledgeCheckout(actor: Persona, stayId: string) {
    return run(d => {
      const e = guard(deny(actor, 'checkout.execute', 'acknowledge checkout requests'))
      if (e) return e
      const st = d.stays.find(x => x.id === stayId)
      if (!st || !st.checkoutRequested) return fail('No checkout request to acknowledge')
      st.checkoutAckAt = nowMs(); st.checkoutAckBy = actor.name
      log(d, actor, 'Checkout acknowledged', fullName(d, st.staffId))
      return ok('Acknowledged. Arrange keys and room inspection')
    })
  },
}

/* ---- email pipeline: queued → (retrying) → sent → delivered, or failed after bounded retries ---- */
registerTick(({ d, now, note, touch }) => {
  for (const n of d.notifications) {
    if (!n.email) continue
    if ((n.emailStatus === 'queued' || n.emailStatus === 'retrying') && (n.nextAttemptAt ?? 0) <= now) {
      n.attempts = (n.attempts ?? 0) + 1
      if (d.emailProviderUp) { n.emailStatus = 'sent'; n.sentAt = now; n.lastError = undefined }
      else {
        n.lastError = 'Email provider unreachable'
        const wait = d.config.emailBackoffMinutes[n.attempts - 1]
        if (wait === undefined) {
          n.emailStatus = 'failed'; n.nextAttemptAt = undefined
          log(d, 'System', 'Email delivery failed', `${n.text.slice(0, 70)} · ${n.attempts} attempts`)
          if (n.critical) note({ toRole: 'AA', text: `A critical alert could not be emailed after ${n.attempts} attempts: “${n.text.slice(0, 80)}”. Follow up in person.`, dedupeKey: 'critfail:' + n.id })
        } else { n.emailStatus = 'retrying'; n.nextAttemptAt = now + wait * 60_000 }
      }
      touch()
    } else if (n.emailStatus === 'sent' && n.sentAt && now - n.sentAt >= d.config.emailDeliveredAfterSeconds * 1000) {
      // the provider's delivery receipt arrives: only now is the email "delivered"
      n.emailStatus = 'delivered'; touch()
      if (n.ref?.kind === 'offer') {
        const o = d.offers.find(x => x.id === n.ref!.id)
        if (o && o.status === 'Pending' && !o.deliveredAt) {
          o.deliveredAt = now; o.deliveredVia = 'email'; o.expiresAt = now + d.config.offerHours * 3600_000
          log(d, 'System', 'Offer delivered', `${fullName(d, o.staffId)} · email delivery confirmed · 48h clock started`)
        }
      }
    }
  }
})

/* ---- stay timers: end-date reminders (D-55), overdue flag and escalation (D-56), checkout acknowledgement (D-63) ---- */
registerTick(({ d, now, note, touch }) => {
  const T = dateStr(now)
  for (const st of d.stays) {
    if (st.status !== 'Active') continue
    if (st.end && !st.exitPending) {
      const left = dayDiff(T, st.end)
      const sent = st.remindersSent ?? (st.remindersSent = [])
      const crossed = d.config.endReminderDays.filter(r => left <= r && left >= 0 && !sent.includes(r))
      if (crossed.length) {
        sent.push(...crossed); touch()
        const min = Math.min(...crossed)
        note({ toStaffId: st.staffId, email: true, text: `Your stay ends ${min === 0 ? 'today' : min === 1 ? 'tomorrow' : `in ${min} days`}. Ask for an extension or plan your checkout.`, dedupeKey: `end:${st.id}:${min}` })
      }
      if (left < 0 && !st.overdueNotified) {
        st.overdueNotified = true; touch()
        note({ toRole: 'AA', text: `${fullName(d, st.staffId)} is past the planned end date (${bedById(d, st.bedId)?.code}). They are flagged, never auto-checked-out.`, dedupeKey: `overdue:${st.id}` })
      }
      if (-left > d.config.overdueGraceDays && !st.escalatedNotified) {
        st.escalatedNotified = true; touch()
        note({ toRole: 'PA', email: true, critical: true, text: `Overdue beyond the ${d.config.overdueGraceDays}-day grace: ${fullName(d, st.staffId)} (${bedById(d, st.bedId)?.code}). Needs a decision.`, dedupeKey: `esc:${st.id}` })
      }
    }
    if (st.checkoutRequested && !st.checkoutAckAt && !st.checkoutEscalated && businessDaysBetween(st.checkoutRequestedAt ?? now, now) >= 1) {
      st.checkoutEscalated = true; touch()
      note({ toRole: 'AA', text: `Checkout request from ${fullName(d, st.staffId)} has not been acknowledged within 1 business day.`, dedupeKey: `coack:${st.id}` })
    }
  }
})
