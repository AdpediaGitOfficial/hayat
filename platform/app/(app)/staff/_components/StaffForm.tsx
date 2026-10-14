'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Button, Field, GlassCard, Input, Select, useToast } from '@/ui'
import { api, type ApiFail } from '@/ui/api'
import { Problem } from './Problem'

export interface StaffFormValues {
  employeeId: string
  fullName: string
  gender: string
  department: string
  grade: string
  phone: string
  email: string
  emergencyContact: string
  joiningDate: string
}
export const EMPTY: StaffFormValues = { employeeId: '', fullName: '', gender: '', department: '', grade: '', phone: '', email: '', emergencyContact: '', joiningDate: '' }

/** Create (no id) or edit (id given) a staff profile. The employee ID is the business key and cannot be changed after creation. */
export function StaffForm({ id, initial = EMPTY }: { id?: string; initial?: StaffFormValues }) {
  const router = useRouter()
  const toast = useToast()
  const [v, setV] = useState(initial)
  const [err, setErr] = useState<ApiFail>()
  const [busy, setBusy] = useState(false)
  const set = (k: keyof StaffFormValues) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value })
  const fe = err?.fields ?? {}

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(undefined)
    const body = {
      fullName: v.fullName, gender: v.gender || null, department: v.department || null, grade: v.grade === '' ? null : v.grade,
      phone: v.phone || null, email: v.email || null, emergencyContact: v.emergencyContact || null, joiningDate: v.joiningDate || null,
    }
    const r = id
      ? await api<{ id: string }>('PATCH', `/api/v1/staff/${id}`, body)
      : await api<{ id: string }>('POST', '/api/v1/staff', { employeeId: v.employeeId, ...body })
    setBusy(false)
    if (!r.ok) return setErr(r)
    toast(r.message ?? 'Saved')
    router.push(`/staff/${r.data.id}`)
    router.refresh()
  }

  return (
    <GlassCard strong title={id ? 'Edit staff details' : 'Add a staff member'} subtitle="Employee ID is the unique key. Email is optional, and the username defaults to the employee ID.">
      <form className="form" onSubmit={submit} noValidate style={{ maxWidth: 680 }}>
        {err && <Problem f={err} />}
        <div className="grid even">
          <Field label="Employee ID" error={fe.employeeId} hint={id ? 'Cannot be changed after creation' : 'Letters, digits and . _ / - only'}>
            <Input value={v.employeeId} onChange={set('employeeId')} disabled={!!id} invalid={!!fe.employeeId} autoComplete="off" required />
          </Field>
          <Field label="Full name" error={fe.fullName}>
            <Input value={v.fullName} onChange={set('fullName')} invalid={!!fe.fullName} autoComplete="off" required />
          </Field>
          <Field label="Gender" optional error={fe.gender} hint="Used by the eligibility rule once it is configured">
            <Select value={v.gender} onChange={set('gender')}><option value="">Not set</option><option value="male">Male</option><option value="female">Female</option></Select>
          </Field>
          <Field label="Department" optional error={fe.department}>
            <Input value={v.department} onChange={set('department')} />
          </Field>
          <Field label="Grade" optional error={fe.grade} hint="A whole number, 0 or more">
            <Input type="number" inputMode="numeric" min={0} value={v.grade} onChange={set('grade')} invalid={!!fe.grade} />
          </Field>
          <Field label="Joining date" optional error={fe.joiningDate}>
            <Input type="date" value={v.joiningDate} onChange={set('joiningDate')} invalid={!!fe.joiningDate} />
          </Field>
          <Field label="Phone" optional error={fe.phone}>
            <Input type="tel" value={v.phone} onChange={set('phone')} invalid={!!fe.phone} />
          </Field>
          <Field label="Email" optional error={fe.email} hint="No email: the admin gives a temporary credential instead">
            <Input type="email" value={v.email} onChange={set('email')} invalid={!!fe.email} autoComplete="off" />
          </Field>
        </div>
        <Field label="Emergency contact" optional error={fe.emergencyContact}>
          <Input value={v.emergencyContact} onChange={set('emergencyContact')} />
        </Field>
        <div className="row wrap">
          <Button variant="primary" type="submit" disabled={busy || !v.fullName || (!id && !v.employeeId)}>{busy ? 'Saving…' : id ? 'Save changes' : 'Add staff member'}</Button>
          <Link href={id ? `/staff/${id}` : '/staff'} className="btn secondary" style={{ textDecoration: 'none' }}>Cancel</Link>
        </div>
      </form>
    </GlassCard>
  )
}
