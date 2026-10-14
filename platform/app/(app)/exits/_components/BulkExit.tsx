'use client'
/**
 * Bulk exit (D-38): paste employee IDs or CSV text, read the per-row preview (nobody is changed), then confirm once with your password.
 * Each row is its own Mark as Left; a row that fails is shown with its reason and can be retried by confirming again.
 */
import Link from 'next/link'
import { useState } from 'react'
import { Alert, Badge, Button, Field, GlassCard, Input, Textarea } from '@/ui'
import type { ExitBatchView } from '@/server/queries/exit/bulk'
import type { ConfirmExitOut, PreviewExitOut } from '@/server/commands/exit/bulk'
import { Problem, useCall } from './common'

const OUTCOME: Record<string, { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  will_mark: { label: 'Will be marked', tone: 'warning' }, already_left: { label: 'Already left', tone: 'neutral' }, not_found: { label: 'Not found', tone: 'neutral' }, blocked: { label: 'Blocked', tone: 'danger' },
}

export function BulkExit({ today }: { today: string }) {
  const { run, busy, err, clear } = useCall()
  const [text, setText] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(today)
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [batch, setBatch] = useState<ExitBatchView>()
  const [dupes, setDupes] = useState<string[]>([])
  const [last, setLast] = useState<{ marked: number; failed: number; message?: string }>()

  const csvOrIds = text.includes(',') || text.includes('\t') || text.includes(';') ? { csv: text } : { employeeIds: text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean) }
  const canPreview = text.trim().length > 0 && reason.trim().length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
  const open = batch ? batch.rows.filter(r => r.outcome === 'will_mark' && r.status !== 'done') : []

  return (
    <div className="stack">
      {err && <Problem f={err} />}
      {!batch && (
        <GlassCard title="Who has left?" subtitle="One employee ID per line, or paste a CSV (the first column is the employee ID)." strong>
          <form className="form" noValidate onSubmit={e => {
            e.preventDefault()
            void run<PreviewExitOut>('/api/v1/exit/bulk/preview', { ...csvOrIds, effectiveDate, reason }, r => { setBatch(r.data.batch); setDupes(r.data.duplicates); setLast(undefined) })
          }}>
            <Field label="Employee IDs" error={err?.fields?.employeeIds}>
              <Textarea value={text} onChange={e => { setText(e.target.value); clear() }} rows={6} placeholder={'E1007\nE1010\nE1023'} />
            </Field>
            <Field label="Effective date" hint="The same for everyone in this batch." error={err?.fields?.effectiveDate}><Input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} /></Field>
            <Field label="Reason" hint="Required. It goes on every clearance case." error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} /></Field>
            <div><Button variant="primary" type="submit" tall block disabled={busy || !canPreview}>Preview</Button></div>
          </form>
        </GlassCard>
      )}

      {batch && (
        <GlassCard title="Preview" subtitle={`Effective ${batch.effectiveDate}: ${batch.reason}`} strong flush>
          <div className="row wrap" style={{ padding: '0 20px 12px' }} data-testid="bulk-counts">
            <Badge tone="warning">{batch.counts.willMark} will be marked</Badge>
            <Badge tone="neutral">{batch.counts.alreadyLeft} already left</Badge>
            <Badge tone="neutral">{batch.counts.notFound} not found</Badge>
            <Badge tone={batch.counts.blocked ? 'danger' : 'neutral'}>{batch.counts.blocked} blocked</Badge>
            {batch.counts.done > 0 && <Badge tone="success">{batch.counts.done} done</Badge>}
            {batch.counts.failed > 0 && <Badge tone="danger">{batch.counts.failed} failed</Badge>}
          </div>
          {dupes.length > 0 && <div style={{ padding: '0 20px 8px' }}><Alert tone="info" title="Listed more than once" detail={dupes.join(', ')} /></div>}
          <ul className="list-plain" style={{ padding: '0 20px 8px' }} aria-label="Preview rows">
            {batch.rows.map(r => (
              <li key={r.id} style={{ display: 'block' }} data-row={r.employeeId} data-outcome={r.outcome} data-status={r.status}>
                <div className="row wrap" style={{ justifyContent: 'space-between' }}>
                  <b>{r.employeeId}</b>
                  <span className="row wrap">
                    <Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>
                    {r.status === 'done' && <Badge tone="success">Marked</Badge>}
                    {r.status === 'failed' && <Badge tone="danger">Failed</Badge>}
                  </span>
                </div>
                <div className="muted body-sm">{r.message}</div>
                {r.resultMessage && <div className="body-sm" style={{ marginTop: 2 }}>{r.resultMessage}{r.caseId && <> · <Link href={`/exits/${r.caseId}`}>Open the case</Link></>}</div>}
              </li>
            ))}
          </ul>
        </GlassCard>
      )}

      {batch && open.length > 0 && (
        <GlassCard title={batch.counts.failed > 0 ? 'Retry the rows that failed' : 'Confirm'} subtitle="Their logins end now. The stays and beds are not touched." strong>
          <form className="form" noValidate onSubmit={e => {
            e.preventDefault()
            void run<ConfirmExitOut>('/api/v1/exit/bulk/confirm', { batchId: batch.id, confirmPassword: password }, r => { setBatch(r.data.batch); setLast({ marked: r.data.marked, failed: r.data.failed, message: r.message }); setPassword('') })
          }}>
            <Field label="Your password" hint="Confirm it is you, once for the whole batch (D-03)." error={err?.fields?.confirmPassword}>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            <div className="row wrap">
              <Button variant="danger" type="submit" tall disabled={busy || password.length === 0}>Mark {open.length} {open.length === 1 ? 'person' : 'people'} as Left</Button>
              {batch.status === 'previewed' && <Button onClick={() => { setBatch(undefined); setPassword('') }}>Change the list</Button>}
            </div>
          </form>
        </GlassCard>
      )}
      {last && <Alert tone={last.failed ? 'warning' : 'success'} title={last.message ?? `${last.marked} marked`} />}
      {batch && open.length === 0 && <div className="row wrap"><Button onClick={() => { setBatch(undefined); setText(''); setLast(undefined) }}>Start another batch</Button><Link href="/exits" className="btn secondary" style={{ textDecoration: 'none' }}>All cases</Link></div>}
    </div>
  )
}
