'use client'
/** Bulk allocation controls: start a preview, then confirm (or retry the failed rows), or discard it. The preview is the approval (D-60). */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Button, Field, GlassCard, Select, Textarea } from '@/ui'
import { Problem, useCall } from './common'
import type { SiteOption } from './RequestForm'

export function BulkStart({ sites }: { sites: SiteOption[] }) {
  const router = useRouter()
  const { run, busy, err } = useCall()
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '')
  const [ids, setIds] = useState('')
  const [note, setNote] = useState<string[]>([])
  async function go() {
    const employeeIds = ids.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
    await run<{ batchId: string; ignored: string[] }>('POST', '/api/v1/requests/bulk/preview', { siteId, ...(employeeIds.length ? { employeeIds } : {}) }, r => {
      setNote(r.data.ignored)
      router.push(`/requests/bulk/${r.data.batchId}`)
    })
  }
  return (
    <GlassCard strong title="1 · Select" subtitle="Everyone with an open request at the site, or only the employee IDs you list. Nothing is reserved until you confirm.">
      <div className="stack" style={{ maxWidth: 560 }}>
        {err && <Problem f={err} />}
        <Field label="Site" error={err?.fields?.siteId}><Select value={siteId} onChange={e => setSiteId(e.target.value)}>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Employee IDs" optional hint="Separate with commas, spaces or new lines. Leave empty to take every open request at the site" error={err?.fields?.requestIds}>
          <Textarea value={ids} onChange={e => setIds(e.target.value)} />
        </Field>
        {note.length > 0 && <Alert tone="warning" title="Some entries were ignored" detail={note.join('; ')} />}
        <div><Button variant="primary" tall disabled={busy || !siteId} onClick={go}>{busy ? 'Matching beds…' : 'Preview allocation'}</Button></div>
      </div>
    </GlassCard>
  )
}

export function BulkConfirm({ id, status, ready, failed }: { id: string; status: string; ready: number; failed: number }) {
  const { run, busy, err } = useCall()
  const [last, setLast] = useState<string>()
  const open = ready + failed
  const canConfirm = (status === 'previewed' || status === 'partial') && open > 0
  return (
    <GlassCard title={status === 'partial' ? '3 · Retry' : '2 · Confirm'} subtitle="Each row is reserved on its own, exactly as a single approval would be. A row that fails leaves nothing behind; confirm again to retry only those rows.">
      <div className="stack">
        {err && <Problem f={err} />}
        {last && <Alert tone={failed > 0 ? 'warning' : 'success'} title={last} />}
        <div className="row wrap">
          {canConfirm && <Button variant="primary" tall disabled={busy} onClick={() => run<{ batch: unknown }>('POST', `/api/v1/requests/bulk/${id}/confirm`, undefined, r => setLast(r.message))}>
            {busy ? 'Reserving…' : status === 'partial' ? `Retry ${open} row${open === 1 ? '' : 's'}` : `Confirm allocation (${ready})`}
          </Button>}
          {status === 'previewed' && <Button variant="danger" disabled={busy} onClick={() => run('POST', `/api/v1/requests/bulk/${id}/discard`, undefined)}>Discard preview</Button>}
        </div>
        {!canConfirm && status !== 'discarded' && <p className="muted body-sm">{status === 'confirmed' ? 'Every reservable row is done.' : 'Nothing in this batch can be reserved.'}</p>}
      </div>
    </GlassCard>
  )
}
