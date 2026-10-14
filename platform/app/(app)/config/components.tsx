'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Button, Field, Input, Modal, Select, Textarea, useToast } from '@/ui'
import { api, type ApiFail } from '@/ui/api'

export interface EditableRow {
  key: string
  label: string
  description: string
  default: unknown
  value: unknown
  options?: string[]
  perSite: boolean
  overrides: { siteId: string; value: unknown }[]
}
export interface SiteOpt { id: string; code: string; name: string }

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v))

/** How to edit a value is decided by the shape of its default: a number, a choice from a list, a text, or a comma-separated list. */
function parse(row: EditableRow, text: string): { value: unknown } | { error: string } {
  const d = row.default
  if (Array.isArray(d)) {
    const items = text.split(',').map(s => s.trim()).filter(Boolean)
    if (typeof d[0] === 'number') {
      const nums = items.map(Number)
      if (nums.some(n => !Number.isFinite(n))) return { error: 'Use numbers separated by commas' }
      return { value: nums }
    }
    return { value: items }
  }
  if (typeof d === 'number') {
    if (text.trim() === '' || !Number.isFinite(Number(text))) return { error: 'Enter a number' }
    return { value: Number(text) }
  }
  return { value: text }
}

export function EditConfigButton({ row, sites }: { row: EditableRow; sites: SiteOpt[] }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [siteId, setSiteId] = useState('')
  const current = (sid: string) => show(row.overrides.find(o => o.siteId === sid)?.value ?? row.value)
  const [text, setText] = useState(current(''))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()
  const [local, setLocal] = useState<string>()

  async function submit() {
    const p = parse(row, text)
    if ('error' in p) return setLocal(p.error)
    setLocal(undefined); setBusy(true); setErr(undefined)
    const r = await api('PUT', `/api/v1/access/config/${encodeURIComponent(row.key)}`, { value: p.value, siteId: siteId || undefined, reason: reason.trim() })
    setBusy(false)
    if (!r.ok) return setErr(r)
    setOpen(false); setReason('')
    toast(r.message ?? 'Saved')
    router.refresh()
  }
  const isNumber = typeof row.default === 'number'
  return (
    <>
      <Button size="sm" onClick={() => { setText(current('')); setSiteId(''); setErr(undefined); setLocal(undefined); setOpen(true) }} aria-label={`Change ${row.label}`}>Change</Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={row.label} subtitle="Saved as a new version. Earlier versions stay in the history."
          footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy || !reason.trim()}>{busy ? 'Saving…' : 'Save new version'}</Button></>}>
          {err && <Alert tone="danger" title={err.reason} detail={[err.owner && `Owner: ${err.owner}`, err.next && `Next: ${err.next}`].filter(Boolean).join(' · ') || undefined} />}
          {row.description && <p className="muted body-sm" style={{ margin: 0 }}>{row.description}</p>}
          {row.perSite && (
            <Field label="Applies to" error={err?.fields?.siteId} hint="A site value overrides the all-sites value at that site only">
              <Select value={siteId} onChange={e => { setSiteId(e.target.value); setText(current(e.target.value)) }}>
                <option value="">All sites</option>{sites.map(s => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Value" error={local ?? err?.fields?.value} hint={Array.isArray(row.default) ? 'Separate items with commas' : `Default: ${show(row.default)}`}>
            {row.options ? (
              <Select value={text} onChange={e => setText(e.target.value)}>{row.options.map(o => <option key={o} value={o}>{o}</option>)}</Select>
            ) : (
              <Input type={isNumber ? 'number' : 'text'} value={text} onChange={e => setText(e.target.value)} />
            )}
          </Field>
          <Field label="Reason (required)" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} /></Field>
        </Modal>
      )}
    </>
  )
}
