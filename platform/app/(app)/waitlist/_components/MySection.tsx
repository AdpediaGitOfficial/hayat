import type { ReactNode } from 'react'
import { getDb } from '@/server/db/client'
import type { CurrentUser } from '@/server/auth/current'
import { getConfig } from '@/server/config/registry'
import { viewOffer } from '@/server/commands/waitlist/delivery'
import { myWaitlist } from '@/server/queries/waitlist/queue'
import { Alert, Blocked, Countdown, GlassCard, Status } from '@/ui'
import { LeaveButton } from './LeaveButton'
import { OfferCard } from './OfferCard'
import { dates, fmtDay, fmtWhen } from './format'

/**
 * "My accommodation" section for the resident: the bed offer waiting for an answer, the waitlist entry (position, expiry) and,
 * when an offer just ended, what that means for their place. Rendering the offer card IS the resident opening the offer: it confirms
 * delivery (first time only) and starts the 48 hours (D-51).
 */
export async function waitlistSection(cur: CurrentUser): Promise<ReactNode | null> {
  const { actor, clock } = cur.rc
  if (actor.role !== 'Res' || !actor.staffId) return null
  const db = getDb()
  let mine = await myWaitlist(db, actor.staffId, clock.now())
  if (mine.offer && !mine.offer.deliveredAt) {
    await viewOffer(cur.rc, { offerId: mine.offer.id }) // opening it is confirmed delivery
    mine = await myWaitlist(db, actor.staffId, clock.now())
  }
  if (!mine.entry && !mine.offer && !mine.lastEnded) return null
  const maxDeclines = await getConfig(db, 'timers.max_declines_before_requeue')
  const { entry, offer, lastEnded } = mine
  const site = entry?.siteName ?? ''

  return (
    <div className="stack" data-testid="my-waitlist" style={{ marginBottom: 16 }}>
      {offer && entry && (
        <OfferCard o={{
          offerId: offer.id, bedCode: offer.bedCode, roomName: offer.roomName, siteName: entry.siteName, from: offer.from, to: offer.to,
          deliveredAt: offer.deliveredAt, expiresAt: offer.expiresAt, position: entry.position, declines: entry.declines, maxDeclines, queueLength: entry.queueLength,
        }} />
      )}

      {!offer && lastEnded?.status === 'accepted' && !entry && (
        <Alert tone="success" title={`Bed ${lastEnded.bedCode} is reserved for you`}
          detail={<>{lastEnded.roomName}, {dates(lastEnded.from, lastEnded.to)}. Reception will check you in when you arrive. Nothing else is needed from you.</>} />
      )}

      {!offer && lastEnded && lastEnded.status !== 'accepted' && (
        <Alert tone="warning"
          title={lastEnded.status === 'expired' ? `Your offer of bed ${lastEnded.bedCode} ended: it was not answered in time`
            : lastEnded.status === 'withdrawn' ? `Your offer of bed ${lastEnded.bedCode} was withdrawn by the Accommodation Admin`
              : `You declined bed ${lastEnded.bedCode}`}
          detail={entry
            ? <>You stay on the waitlist{lastEnded.status === 'declined' && entry.declines >= maxDeclines ? ' at the back of the queue' : ' and keep your place'} (number {entry.position}). Nothing else is needed from you.</>
            : 'You are no longer on the waitlist. Ask Reception if you still need a bed.'} />
      )}

      {entry && (
        <GlassCard eyebrow="Waitlist" title={offer ? 'You are on the waitlist' : `Number ${entry.position} of ${entry.queueLength} on the waitlist`}
          subtitle={`${site} · ${dates(entry.arrival, entry.end)}`}
          actions={<Status s={entry.status === 'offered' ? 'Offered' : 'Waiting'} />}>
          <div className="stack">
            <div className="row wrap" style={{ gap: 24 }}>
              <div><div className="subtle body-sm">Your place</div><b>{entry.position}</b> of {entry.queueLength}</div>
              {entry.priority && <div><div className="subtle body-sm">Priority</div><b>{entry.priority}</b></div>}
              <div><div className="subtle body-sm">Joined</div>{fmtDay(entry.createdAt.slice(0, 10))}</div>
              <div><div className="subtle body-sm">Valid until</div>
                <Countdown to={Date.parse(entry.expiresAt)} from={Date.parse(entry.createdAt)} warnBelowMs={3 * 86_400_000} />
                <div className="subtle body-sm">{fmtWhen(entry.expiresAt)}</div>
              </div>
              {entry.declines > 0 && <div><div className="subtle body-sm">Offers declined</div>{entry.declines}</div>}
            </div>
            {!offer && (
              <Blocked why="No bed is free for your dates yet. Beds are offered in queue order as they become free."
                owner="Accommodation Admin"
                next={`Nothing to do now. You will be notified when a bed is held for you. If you still need a bed after ${fmtDay(entry.expiresAt.slice(0, 10))}, ask your Accommodation Admin to renew the entry before it ends.`} />
            )}
            <div><LeaveButton entryId={entry.id} hasOffer={!!offer} /></div>
          </div>
        </GlassCard>
      )}
    </div>
  )
}
