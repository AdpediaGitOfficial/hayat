'use client'
/** Approve and reject, each in a dialog. Reject needs a reason (AT-018); approve needs a note when rules would have failed. */
import { useState } from 'react'
import { Alert, Button, Field, Modal, Textarea } from '@/ui'
import type { DecideOut } from '@/server/commands/emergency/decide'
import { Problem, useCall } from './common'

export function DecideActions({ caseId, who, bedCode, failedReasons }: { caseId: string; who: string; bedCode: string; failedReasons: string[] }) {
  const [open, setOpen] = useState<'approve' | 'reject'>()
  const [note, setNote] = useState('')
  const { run, busy, err, clearError } = useCall()
  const close = () => { setOpen(undefined); setNote(''); clearError() }
  const needsNote = open === 'approve' && failedReasons.length > 0

  return (
    <>
      <div className="row wrap">
        <Button variant="primary" onClick={() => setOpen('approve')}>Approve</Button>
        <Button variant="secondary" onClick={() => setOpen('reject')}>Reject</Button>
      </div>
      <Modal open={!!open} onClose={close} title={open === 'approve' ? `Approve ${who} in ${bedCode}` : `Reject ${who} in ${bedCode}`}
        footer={<>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant={open === 'approve' ? 'primary' : 'danger'} disabled={busy || note.trim().length < (open === 'reject' || needsNote ? 3 : 0)}
            onClick={() => void run<DecideOut>('POST', `/api/v1/emergency/${caseId}/${open}`, open === 'approve' ? { note: note || null } : { reason: note }, () => close())}>
            {open === 'approve' ? 'Approve stay' : 'Reject and open relocation task'}
          </Button>
        </>}>
        <div className="form">
          {err && <Problem f={err} />}
          {open === 'approve' && <Alert tone="info" title="The provisional stay becomes Active" detail="You are accepting this person in this bed." />}
          {open === 'reject' && <Alert tone="warning" title="Nobody is moved" detail="The resident stays in the bed, as Resolution pending, until an Accommodation Admin relocates or checks them out. A task with a deadline is created for the Accommodation Admin." />}
          {failedReasons.length > 0 && open === 'approve' && <Alert tone="warning" title="Rules that would have failed" detail={failedReasons.join('; ')} />}
          <Field label={open === 'reject' ? 'Reason for rejecting' : needsNote ? 'Why you accept this' : 'Note'} optional={open === 'approve' && !needsNote}
            hint={open === 'reject' ? 'Required. It goes to the Accommodation Admin and the audit log.' : needsNote ? 'Required because a rule would have failed.' : undefined}
            error={err?.fields?.reason ?? err?.fields?.note}>
            <Textarea value={note} onChange={e => setNote(e.target.value)} rows={3} />
          </Field>
        </div>
      </Modal>
    </>
  )
}
