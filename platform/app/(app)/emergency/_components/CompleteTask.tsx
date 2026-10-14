'use client'
/** Mark a relocation or checkout task done, with what was done. Refused while the resident is still in the rejected stay. */
import { useState } from 'react'
import { Button, Field, Modal, Textarea } from '@/ui'
import { Problem, useCall } from './common'

export function CompleteTask({ taskId, title }: { taskId: string; title: string }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const { run, busy, err, clearError } = useCall()
  const close = () => { setOpen(false); setNote(''); clearError() }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Mark done</Button>
      <Modal open={open} onClose={close} title="Mark task done" subtitle={title}
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" disabled={busy || note.trim().length < 3} onClick={() => void run('POST', `/api/v1/emergency/tasks/${taskId}/complete`, { note }, () => close())}>Mark done</Button></>}>
        <div className="form">
          {err && <Problem f={err} />}
          <Field label="What was done" hint="Where the resident went, or that they were checked out." error={err?.fields?.note}>
            <Textarea value={note} onChange={e => setNote(e.target.value)} rows={3} />
          </Field>
        </div>
      </Modal>
    </>
  )
}
