'use client'
import Link from 'next/link'
import { useState } from 'react'
import { Alert, Badge, Blocked, Button, Field, GlassCard, Icon, StatTile, Stepper, Tabs, Textarea, useToast } from '@/ui'
import { post, type ApiFail } from '@/ui/api'
import { Problem } from './Problem'

type Cls = 'new' | 'duplicate' | 'invalid'
export interface WizardRow { rowNo: number; classification: Cls; outcome: 'created' | 'rejected' | null; reasons: string[]; warnings: string[]; employeeId: string; fullName: string; department: string }
export interface WizardBatch {
  id: string
  status: 'previewed' | 'confirmed'
  fileName: string | null
  policy: 'save_valid' | 'all_or_nothing'
  summary: { total: number; new: number; duplicate: number; invalid: number; withWarnings: number; created: number | null; rejected: number | null }
  ignoredColumns: string[]
  rows: WizardRow[]
  canConfirm: boolean
  blocked?: { why: string; owner: string; next: string }
}

const STEPS = ['Upload', 'Preview', 'Confirm', 'Result']
const MAX_BYTES = 2_000_000
type Filter = 'all' | Cls | 'warnings'

function outcomeBadge(r: WizardRow) {
  if (r.outcome === 'created') return <Badge tone="success">Saved</Badge>
  if (r.outcome === 'rejected') return <Badge tone="danger">Rejected</Badge>
  if (r.classification === 'new') return r.warnings.length ? <Badge tone="info">New, with a note</Badge> : <Badge tone="success">New</Badge>
  if (r.classification === 'duplicate') return <Badge tone="warning">Duplicate</Badge>
  return <Badge tone="danger">Invalid</Badge>
}

/** Four steps: upload, preview (nothing is saved), confirm, result. The server holds the batch; this only drives it. */
export function ImportWizard({ initial, templateHeader, templateExample }: { initial?: WizardBatch; templateHeader: string; templateExample: string }) {
  const toast = useToast()
  const [batch, setBatch] = useState<WizardBatch | undefined>(initial)
  const [step, setStep] = useState(initial ? (initial.status === 'confirmed' ? 3 : 1) : 0)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [err, setErr] = useState<ApiFail>()
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')

  async function pick(file: File | undefined) {
    setErr(undefined)
    if (!file) return
    if (file.size > MAX_BYTES) return setErr({ ok: false, code: 'invalid', reason: 'The file is larger than 2 MB', next: 'Split it into smaller files', requestId: '' })
    setFileName(file.name)
    setText(await file.text())
  }

  async function preview() {
    setBusy(true); setErr(undefined)
    const r = await post<WizardBatch>('/api/v1/staff/import/preview', { csv: text, fileName: fileName || undefined })
    setBusy(false)
    if (!r.ok) return setErr(r)
    setBatch(r.data); setFilter('all'); setStep(1)
  }

  async function confirm() {
    if (!batch) return
    setBusy(true); setErr(undefined)
    const r = await post(`/api/v1/staff/import/${batch.id}/confirm`)
    if (!r.ok) { setBusy(false); return setErr(r) }
    toast(r.message ?? 'Import finished')
    // Reload the batch so every row shows what happened to it.
    const res = await fetch(`/api/v1/staff/import/${batch.id}`, { credentials: 'same-origin' })
    const j = await res.json()
    setBusy(false)
    if (j.ok) setBatch(j.data as WizardBatch)
    setStep(3)
  }

  function downloadTemplate() {
    const blob = new Blob([`${templateHeader}\r\n${templateExample}\r\n`], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'staff-import-template.csv'; a.click()
    URL.revokeObjectURL(a.href)
  }

  const s = batch?.summary
  const rejectedCount = s ? (batch!.status === 'confirmed' ? s.rejected ?? 0 : s.duplicate + s.invalid) : 0
  const shown = batch?.rows.filter(r => filter === 'all' ? true : filter === 'warnings' ? r.warnings.length > 0 : r.classification === filter) ?? []

  return (
    <div className="stack">
      <Stepper steps={STEPS} current={step} />
      {err && <Problem f={err} />}

      {step === 0 && (
        <GlassCard strong title="1. Upload a CSV" subtitle="Nothing is saved until you confirm. You will see every row first."
          actions={<Button icon="download" onClick={downloadTemplate}>Download template</Button>}>
          <div className="stack">
            <Field label="CSV file" hint="UTF-8, comma-separated, at most 2 MB and 5 000 rows. Columns: employee_id and full_name are required.">
              <input type="file" accept=".csv,text/csv" onChange={e => pick(e.target.files?.[0])} />
            </Field>
            <Field label="Or paste the CSV text">
              <Textarea style={{ minHeight: 120, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={text} onChange={e => { setText(e.target.value); setFileName('') }} placeholder={`${templateHeader}\n${templateExample}`} />
            </Field>
            <div><Button variant="primary" icon="arrowRight" onClick={preview} disabled={busy || text.trim() === ''}>{busy ? 'Reading…' : 'Preview'}</Button></div>
          </div>
        </GlassCard>
      )}

      {batch && s && step >= 1 && (
        <>
          <div className="grid stats">
            <StatTile label={batch.status === 'confirmed' ? 'Saved' : 'New'} value={batch.status === 'confirmed' ? s.created ?? 0 : s.new} icon="userPlus" />
            <StatTile label="Duplicates" value={s.duplicate} icon="users" hint="Never merged" />
            <StatTile label="Invalid" value={s.invalid} icon="alert" />
            <StatTile label={batch.status === 'confirmed' ? 'Rows in file' : 'With a note'} value={batch.status === 'confirmed' ? s.total : s.withWarnings} icon="file" />
          </div>
          {batch.ignoredColumns.length > 0 && <Alert tone="info" title="Some columns were ignored" detail={batch.ignoredColumns.join(', ')} />}
        </>
      )}

      {batch && step === 1 && (
        <GlassCard strong flush title="2. Preview" subtitle={`${batch.fileName ? batch.fileName + ' · ' : ''}${s!.total} rows. Nothing has been saved.`}
          footer={<div className="row wrap" style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button onClick={() => { setStep(0); setBatch(undefined) }}>Upload a different file</Button>
            <span className="row wrap">
              {rejectedCount > 0 && <a className="btn secondary" style={{ textDecoration: 'none' }} href={`/api/v1/staff/import/${batch.id}/rejected.csv`}><Icon name="download" />Rejected rows ({rejectedCount})</a>}
              <Button variant="primary" icon="arrowRight" onClick={() => setStep(2)} disabled={!batch.canConfirm}>Continue</Button>
            </span>
          </div>}>
          <div className="tbl-tool" style={{ paddingTop: 12, overflowX: 'auto' }}>
            <Tabs value={filter} onChange={setFilter} options={[
              { id: 'all', label: 'All', count: s!.total }, { id: 'new', label: 'New', count: s!.new }, { id: 'duplicate', label: 'Duplicate', count: s!.duplicate },
              { id: 'invalid', label: 'Invalid', count: s!.invalid }, { id: 'warnings', label: 'Notes', count: s!.withWarnings },
            ]} />
          </div>
          {batch.blocked && <div style={{ padding: '0 20px 12px' }}><Blocked why={batch.blocked.why} owner={batch.blocked.owner} next={batch.blocked.next} /></div>}
          <RowsTable rows={shown} />
        </GlassCard>
      )}

      {batch && step === 2 && (
        <GlassCard strong title="3. Confirm" subtitle="This saves the valid rows. It can be done once.">
          <div className="stack">
            <ul className="list-plain">
              <li><b>{s!.new}</b> staff will be added (source: CSV import).</li>
              <li><b>{rejectedCount}</b> row{rejectedCount === 1 ? '' : 's'} will {batch.policy === 'save_valid' ? 'be left out and listed in a file you can download' : 'stop the import'}.</li>
              <li>Policy: {batch.policy === 'save_valid' ? 'valid rows are saved, rejected rows are reported' : 'all or nothing: any rejected row blocks the whole import'}.</li>
            </ul>
            <Alert tone="info" title="Employee IDs are checked again at the moment you confirm" detail="A row whose ID was taken since the preview is rejected with that reason. Nothing is merged automatically." />
            <div className="row wrap">
              <Button onClick={() => setStep(1)}>Back to preview</Button>
              <Button variant="primary" icon="check" onClick={confirm} disabled={busy || !batch.canConfirm}>{busy ? 'Saving…' : `Save ${s!.new} staff`}</Button>
            </div>
          </div>
        </GlassCard>
      )}

      {batch && step === 3 && (
        <GlassCard strong flush title="4. Result"
          subtitle={`${s!.created ?? 0} saved + ${s!.rejected ?? 0} rejected = ${s!.total} rows`}
          actions={<>
            {(s!.rejected ?? 0) > 0 && <a className="btn secondary" style={{ textDecoration: 'none' }} href={`/api/v1/staff/import/${batch.id}/rejected.csv`}><Icon name="download" />Download rejected rows</a>}
            <Link href="/staff" className="btn primary" style={{ textDecoration: 'none' }}>Open the directory</Link>
          </>}>
          <div style={{ padding: '0 20px 12px' }}>
            {(s!.rejected ?? 0) === 0
              ? <Alert tone="success" title="All rows were saved" />
              : <Alert tone="warning" title={`${s!.rejected} row${s!.rejected === 1 ? ' was' : 's were'} not saved`} detail="Download the rejected rows, correct them in the file (the reason is in the second column) and upload the file again. Rows already saved will show as duplicates, so you can remove them first." />}
          </div>
          <RowsTable rows={batch.rows} />
        </GlassCard>
      )}
    </div>
  )
}

function RowsTable({ rows }: { rows: WizardRow[] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl stack-m">
        <thead><tr><th>Row</th><th>Result</th><th>Employee ID</th><th>Name</th><th>Why</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.rowNo}>
              <td data-h="Row" className="tnum">{r.rowNo}</td>
              <td data-h="Result">{outcomeBadge(r)}</td>
              <td data-h="Employee ID"><span className="mono">{r.employeeId}</span></td>
              <td data-h="Name">{r.fullName}</td>
              <td data-h="Why">{r.reasons.length ? r.reasons.join('. ') : r.warnings.length ? <span className="muted">{r.warnings.join('. ')}</span> : <span className="muted">OK</span>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5}><div className="tbl-empty">No rows in this view</div></td></tr>}
        </tbody>
      </table>
    </div>
  )
}
