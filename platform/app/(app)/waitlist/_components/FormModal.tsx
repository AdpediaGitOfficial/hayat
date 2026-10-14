'use client'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/ui'
import type { ApiFail, ApiResult } from '@/ui/api'
import { Problem } from './Problem'

export interface FieldDef {
  name: string
  label: string
  kind: 'text' | 'textarea' | 'date' | 'select'
  options?: { value: string; label: string }[]
  optional?: boolean
  hint?: string
  initial?: string
}

/**
 * One small form in a modal: fields, a submit that calls the API, a failure shown as reason + owner + next action (D-93), and a
 * refresh of the page on success. `run` returns the API result; the modal closes only on success. Mount it only while it is open
 * (`{show && <FormModal open … />}`), so every opening starts from the initial values.
 */
export function FormModal({ open, onClose, title, subtitle, fields, submitLabel, danger, run, children, canSubmit }: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  fields: FieldDef[]
  submitLabel: string | ((values: Record<string, string>) => string)
  danger?: boolean | ((values: Record<string, string>) => boolean)
  run: (values: Record<string, string>) => Promise<ApiResult<unknown>>
  children?: ReactNode
  canSubmit?: (values: Record<string, string>) => boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const initial = () => Object.fromEntries(fields.map(f => [f.name, f.initial ?? '']))
  const [values, setValues] = useState<Record<string, string>>(initial)
  const [err, setErr] = useState<ApiFail>()
  const [busy, setBusy] = useState(false)

  const missing = fields.some(f => !f.optional && !(values[f.name] ?? '').trim())
  async function go() {
    setBusy(true); setErr(undefined)
    const r = await run(values)
    setBusy(false)
    if (!r.ok) return setErr(r)
    toast(r.message ?? 'Done')
    onClose()
    router.refresh()
  }
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={(typeof danger === 'function' ? danger(values) : danger) ? 'danger' : 'primary'} onClick={go} disabled={busy || missing || (canSubmit ? !canSubmit(values) : false)}>{busy ? 'Working…' : typeof submitLabel === 'function' ? submitLabel(values) : submitLabel}</Button></>}>
      <div className="stack">
        {err && <Problem f={err} />}
        {children}
        {fields.map(f => (
          <Field key={f.name} label={f.label} optional={f.optional} hint={f.hint} error={err?.fields?.[f.name]}>
            {f.kind === 'textarea' ? <Textarea rows={3} value={values[f.name] ?? ''} onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))} />
              : f.kind === 'select' ? (
                <Select value={values[f.name] ?? ''} onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}>
                  <option value="">Choose…</option>
                  {f.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : <Input type={f.kind === 'date' ? 'date' : 'text'} value={values[f.name] ?? ''} onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))} />}
          </Field>
        ))}
      </div>
    </Modal>
  )
}
