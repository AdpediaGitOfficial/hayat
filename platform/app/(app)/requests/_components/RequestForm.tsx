'use client'
/**
 * The request form (phone-first, single column). A Resident files for themselves at any live site; Reception and Accommodation
 * Admins file for a person by employee ID at their own sites. Before sending, a plain-words check shows the person's eligibility
 * problems and how many beds look free: counts only, nothing about other people.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { Alert, Blocked, Button, Field, GlassCard, Input, Select, Textarea } from '@/ui'
import { api } from '@/ui/api'
import type { RequestPreview } from '@/server/queries/requests/preview'
import { Problem, useCall } from './common'

export interface SiteOption { id: string; name: string }
type Type = 'permanent' | 'contract' | 'trainee'

export interface FormValues { siteId: string; arrivalDate: string; endDate: string; stayType: Type; note: string }

export function RequestForm({ sites, today, onBehalf }: { sites: SiteOption[]; today: string; onBehalf: boolean }) {
  const router = useRouter()
  const { run, busy, err } = useCall()
  const [v, setV] = useState<FormValues>({ siteId: sites[0]?.id ?? '', arrivalDate: '', endDate: '', stayType: 'contract', note: '' })
  const [employeeId, setEmployeeId] = useState('')
  const [preview, setPreview] = useState<RequestPreview>()
  const fe = err?.fields ?? {}
  const set = <K extends keyof FormValues>(k: K) => (e: { target: { value: string } }) => setV(x => ({ ...x, [k]: e.target.value as FormValues[K] }))

  // Re-check eligibility and supply whenever the facts the answer depends on change (debounced).
  useEffect(() => {
    setPreview(undefined)
    if (!v.siteId || !v.arrivalDate || (onBehalf && !employeeId.trim()) || (v.endDate && v.endDate <= v.arrivalDate) || (!v.endDate && v.stayType !== 'permanent')) return
    const t = setTimeout(async () => {
      const q = new URLSearchParams({ siteId: v.siteId, from: v.arrivalDate })
      if (v.endDate) q.set('to', v.endDate)
      if (onBehalf) q.set('employeeId', employeeId.trim())
      const r = await api<RequestPreview>('GET', `/api/v1/requests/preview?${q}`)
      if (r.ok) setPreview(r.data)
    }, 350)
    return () => clearTimeout(t)
  }, [v.siteId, v.arrivalDate, v.endDate, v.stayType, employeeId, onBehalf])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body = {
      ...(onBehalf ? { employeeId: employeeId.trim() } : {}),
      siteId: v.siteId, arrivalDate: v.arrivalDate, endDate: v.endDate || null, stayType: v.stayType, note: v.note || null,
    }
    await run<{ requestId: string }>('POST', '/api/v1/requests', body, r => router.push(onBehalf ? `/requests/${r.data.requestId}` : '/my'))
  }

  if (sites.length === 0) {
    return <Blocked why="No site is available for you to file a request" owner="Super Admin" next="Ask a Super Admin to assign your site, or to add one" />
  }

  const blockers = preview?.blockers ?? []
  return (
    <GlassCard strong title={onBehalf ? 'Request a bed for a colleague' : 'Request a bed'}
      subtitle={onBehalf ? 'They are told, and the request is recorded as filed by you.' : 'Tell us where and when you would like to move in. An Accommodation Admin chooses the bed.'}>
      <form className="form" onSubmit={submit} noValidate style={{ maxWidth: 560 }}>
        {err && <Problem f={err} />}
        {onBehalf && (
          <Field label="Employee ID" error={fe.employeeId} hint="The person the request is for">
            <Input value={employeeId} onChange={e => setEmployeeId(e.target.value)} invalid={!!fe.employeeId} autoComplete="off" autoCapitalize="characters" />
          </Field>
        )}
        <Field label="Site" error={fe.siteId}>
          <Select value={v.siteId} onChange={set('siteId')}>{sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        </Field>
        <div className="grid even">
          <Field label="Arrival date" error={fe.arrivalDate}>
            <Input type="date" min={today} value={v.arrivalDate} onChange={set('arrivalDate')} invalid={!!fe.arrivalDate} required />
          </Field>
          <Field label="Departure day" error={fe.endDate} hint={v.stayType === 'permanent' ? 'Leave empty for an open-ended permanent stay (reviewed regularly)' : 'The day you leave. Required for contract and trainee stays'}>
            <Input type="date" min={v.arrivalDate || today} value={v.endDate} onChange={set('endDate')} invalid={!!fe.endDate} />
          </Field>
        </div>
        <Field label="Stay type" error={fe.stayType}>
          <Select value={v.stayType} onChange={set('stayType')}>
            <option value="contract">Contract</option><option value="trainee">Trainee</option><option value="permanent">Permanent</option>
          </Select>
        </Field>
        <Field label="Note" optional error={fe.note} hint="Anything the admin should know">
          <Textarea value={v.note} onChange={set('note')} maxLength={500} />
        </Field>

        {blockers.map(b => <Blocked key={b} why={b} owner="Accommodation Admin" next="Resolve this before filing, or open the existing record" />)}
        {preview && blockers.length === 0 && (
          <div className="stack" style={{ gap: 8 }} data-testid="request-preview">
            {preview.freeBeds > 0 && <Alert tone="success" title={`${preview.freeBeds}${preview.freeBedsCapped ? '+' : ''} bed${preview.freeBeds === 1 ? '' : 's'} look free for these dates`} detail="The Accommodation Admin picks the bed when approving." />}
            {preview.problems.map((p, i) => <Alert key={i} tone={p.tone} title={p.text} />)}
          </div>
        )}

        <div className="row wrap">
          <Button variant="primary" type="submit" tall disabled={busy || !v.siteId || !v.arrivalDate || blockers.length > 0 || (onBehalf && !employeeId.trim())}>{busy ? 'Sending…' : 'Submit request'}</Button>
          <Button variant="ghost" onClick={() => router.back()}>Cancel</Button>
        </div>
      </form>
    </GlassCard>
  )
}
