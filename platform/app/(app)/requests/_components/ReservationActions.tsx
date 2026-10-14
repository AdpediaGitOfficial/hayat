'use client'
/** Cancel a reservation, or extend its no-show deadline once. Both need a reason (D-58) and are audited. */
import { useState } from 'react'
import { Button, Field, GlassCard, Modal, Textarea } from '@/ui'
import { Problem, useCall } from './common'

export function ReservationActions({ id, canCancel, canExtend }: { id: string; canCancel: boolean; canExtend: boolean }) {
  const { run, busy, err, clear } = useCall()
  const [mode, setMode] = useState<'cancel' | 'extend' | undefined>()
  const [reason, setReason] = useState('')
  const close = () => { setMode(undefined); setReason(''); clear() }
  const go = () => run('POST', `/api/v1/requests/reservations/${id}/${mode === 'cancel' ? 'cancel' : 'extend-no-show'}`, { reason }, close)
  return (
    <GlassCard title="Actions" subtitle="Cancelling frees the bed for those dates at once. An extension moves the no-show deadline by one more period, once.">
      <div className="row wrap">
        {canExtend && <Button onClick={() => setMode('extend')}>Extend no-show deadline (once)</Button>}
        {canCancel && <Button variant="danger" onClick={() => setMode('cancel')}>Cancel reservation</Button>}
      </div>
      <Modal open={mode !== undefined} onClose={close} title={mode === 'cancel' ? 'Cancel this reservation' : 'Extend the no-show deadline'}
        subtitle={mode === 'cancel' ? 'The resident is told and the bed is released.' : 'Allowed once per reservation. The resident is told.'}
        footer={<><Button onClick={close}>Back</Button><Button variant={mode === 'cancel' ? 'danger' : 'primary'} disabled={busy || reason.trim().length < 3} onClick={go}>{busy ? 'Working…' : mode === 'cancel' ? 'Cancel reservation' : 'Extend'}</Button></>}>
        <div className="stack">
          {err && <Problem f={err} />}
          <Field label="Reason" hint="At least 3 characters. Recorded in the audit log" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} autoFocus /></Field>
        </div>
      </Modal>
    </GlassCard>
  )
}
