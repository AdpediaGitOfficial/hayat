'use client'
/** The resident's own buttons on My accommodation: cancel the open request (with a reason). Editing happens on the request page. */
import { useState } from 'react'
import { Button, Field, Modal, Textarea } from '@/ui'
import { Problem, useCall } from './common'

export function CancelMyRequest({ id }: { id: string }) {
  const { run, busy, err, clear } = useCall()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const close = () => { setOpen(false); setReason(''); clear() }
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>Cancel request</Button>
      <Modal open={open} onClose={close} title="Cancel your request" subtitle="Nothing is reserved yet. You can file a new request later."
        footer={<><Button onClick={close}>Keep it</Button><Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => run('POST', `/api/v1/requests/${id}/cancel`, { reason }, close)}>{busy ? 'Cancelling…' : 'Cancel request'}</Button></>}>
        <div className="stack">
          {err && <Problem f={err} />}
          <Field label="Why are you cancelling?" hint="At least 3 characters" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
        </div>
      </Modal>
    </>
  )
}
