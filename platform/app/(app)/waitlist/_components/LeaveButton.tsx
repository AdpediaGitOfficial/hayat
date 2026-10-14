'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button, Field, Input, Modal, useToast } from '@/ui'
import { post, type ApiFail } from '@/ui/api'
import { Problem } from './Problem'

/** Take someone off the waitlist (the resident themselves, or staff for them). A pending offer is withdrawn and its hold released. */
export function LeaveButton({ entryId, who, hasOffer }: { entryId: string; who?: string; hasOffer?: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<ApiFail>()
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr(undefined)
    const r = await post(`/api/v1/waitlist/${entryId}/leave`, { reason })
    setBusy(false)
    if (!r.ok) return setErr(r)
    toast(r.message ?? 'Taken off the waitlist')
    setOpen(false)
    router.refresh()
  }
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(true); setErr(undefined) }}>{who ? 'Remove' : 'Leave the waitlist'}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={who ? `Remove ${who} from the waitlist` : 'Leave the waitlist'}
        subtitle={hasOffer ? 'A bed offer is waiting for an answer: it will be withdrawn and the bed released.' : 'You lose your place in the queue. You can join again later, at the back.'}
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" onClick={go} disabled={busy || reason.trim().length < 3}>{busy ? 'Working…' : who ? 'Remove' : 'Leave'}</Button></>}>
        <div className="stack">
          {err && <Problem f={err} />}
          <Field label="Reason" hint="Kept in the audit log"><Input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
        </div>
      </Modal>
    </>
  )
}
