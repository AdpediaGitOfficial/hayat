'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Badge, Button, Countdown, Field, GlassCard, Modal, Textarea, useToast } from '@/ui'
import { post, type ApiFail } from '@/ui/api'
import { Problem } from './Problem'
import { dates, fmtWhen } from './format'

export interface OfferCardData {
  offerId: string
  bedCode: string
  roomName: string
  siteName: string
  from: string
  to: string | null
  deliveredAt: string | null
  expiresAt: string | null
  position: number | null
  declines: number
  /** The decline that would go to the back of the queue (timers.max_declines_before_requeue). */
  maxDeclines: number
  queueLength: number
}

/** The resident's bed offer: accept it, or decline it knowing exactly what each answer does to their place in the queue (D-50). */
export function OfferCard({ o }: { o: OfferCardData }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const nextDecline = o.declines + 1
  const requeue = nextDecline >= o.maxDeclines

  async function accept() {
    setBusy(true); setErr(undefined)
    const r = await post(`/api/v1/waitlist/offers/${o.offerId}/accept`)
    setBusy(false)
    if (!r.ok) return setErr(r)
    toast(r.message ?? 'Bed reserved')
    router.refresh()
  }
  async function decline() {
    setBusy(true); setErr(undefined)
    const r = await post(`/api/v1/waitlist/offers/${o.offerId}/decline`, { reason: reason.trim() || undefined })
    setBusy(false)
    if (!r.ok) return setErr(r)
    toast(r.message ?? 'Declined')
    setDeclining(false)
    router.refresh()
  }

  return (
    <GlassCard strong eyebrow="Bed offer" title="A bed is being held for you"
      subtitle={`Bed ${o.bedCode} · ${o.roomName} · ${o.siteName}`}
      actions={<Badge tone="brand">Waiting for your answer</Badge>}>
      <div className="stack">
        <div>
          <div><b>Dates:</b> {dates(o.from, o.to)}</div>
          {o.expiresAt && o.deliveredAt && (
            <div style={{ marginTop: 8 }}>
              <Countdown to={Date.parse(o.expiresAt)} from={Date.parse(o.deliveredAt)} label="to answer" />
              <div className="subtle body-sm">Open since {fmtWhen(o.deliveredAt)}; it ends {fmtWhen(o.expiresAt)}. If you do not answer, the bed is released and you keep your place.</div>
            </div>
          )}
        </div>
        <Alert tone="info" title="What your answer does"
          detail={`Accept: the bed becomes your reservation and Reception checks you in on arrival. Decline: your first decline keeps your place in the queue${o.position ? ` (you are number ${o.position})` : ''}; a second decline moves you to the back of the queue.${o.declines > 0 ? ` You have declined ${o.declines} time${o.declines === 1 ? '' : 's'} already.` : ''}`} />
        {err && !declining && <Problem f={err} />}
        <div className="row wrap">
          <Button variant="primary" icon="checkCircle" onClick={accept} disabled={busy}>{busy && !declining ? 'Accepting…' : 'Accept this bed'}</Button>
          <Button onClick={() => { setDeclining(true); setErr(undefined) }} disabled={busy}>Decline</Button>
        </div>
      </div>
      <Modal open={declining} onClose={() => setDeclining(false)} title="Decline this bed?"
        subtitle={requeue ? `This is decline number ${nextDecline}: you will move to the back of the queue (position ${o.queueLength}).` : `This is your first decline: you keep your place${o.position ? ` (number ${o.position})` : ''}. A second decline moves you to the back of the queue.`}
        footer={<><Button onClick={() => setDeclining(false)}>Keep the offer</Button><Button variant={requeue ? 'danger' : 'primary'} onClick={decline} disabled={busy}>{busy ? 'Declining…' : 'Yes, decline'}</Button></>}>
        <div className="stack">
          {err && <Problem f={err} />}
          <Field label="Reason" optional hint="Helps the Accommodation Admin choose the next bed"><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} /></Field>
        </div>
      </Modal>
    </GlassCard>
  )
}
