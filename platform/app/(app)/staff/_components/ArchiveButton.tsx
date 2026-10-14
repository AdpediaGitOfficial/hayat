'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Blocked, Button, Field, Input, Modal, useToast } from '@/ui'
import { post, type ApiFail } from '@/ui/api'
import { Problem } from './Problem'

interface Blocker { kind: string; count: number; label: string; owner: string; next: string }

/** Archive (never delete). If the person still holds a bed, request or login, the refusal lists each blocker with its owner and next step. */
export function ArchiveButton({ id, name }: { id: string; name: string }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<ApiFail>()
  const [busy, setBusy] = useState(false)
  const blockers = (err?.detail as { blockers?: Blocker[] } | undefined)?.blockers

  async function go() {
    setBusy(true); setErr(undefined)
    const r = await post(`/api/v1/staff/${id}/archive`, { reason })
    setBusy(false)
    if (!r.ok) return setErr(r)
    toast(r.message ?? 'Archived')
    setOpen(false)
    router.refresh()
  }

  return (
    <>
      <Button icon="ban" onClick={() => { setOpen(true); setErr(undefined) }}>Archive</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Archive ${name}`} subtitle="Archiving hides the profile from the default views. The history stays and nothing is deleted."
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" onClick={go} disabled={busy || reason.trim().length < 3}>{busy ? 'Archiving…' : 'Archive'}</Button></>}>
        <div className="stack">
          {err && !blockers && <Problem f={err} />}
          {blockers?.map(b => <Blocked key={b.kind} why={`${b.count > 1 ? b.count + ' × ' : ''}${b.label}`} owner={b.owner} next={b.next} />)}
          <Field label="Reason" hint="Recorded in the audit log"><Input value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
        </div>
      </Modal>
    </>
  )
}
