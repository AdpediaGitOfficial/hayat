import { Fragment, type ReactNode } from 'react'
import Link from 'next/link'
import { Alert, Badge, Icon, Person, GlassCard, Status } from '@/ui'
import type { StaffShape } from '@/server/queries/staff/access'
import type { StaffRecord } from '@/server/queries/staff/shapes'
import { ArchiveButton } from './ArchiveButton'

const dash = <span className="muted">Not set</span>
const SHAPE_NOTE: Record<StaffShape, string | null> = {
  full: null,
  own: 'This is your own record. To correct anything, ask your Accommodation Admin.',
  minimum: 'Limited view for look-ups: phone, email, grade and emergency contact are not shown to your role.',
  identity: 'Identity check only: name, employee ID and employment status.',
}

type Loose = Partial<{
  id: string; employeeId: string; fullName: string; gender: 'male' | 'female' | null; department: string | null; grade: number | null
  phone: string | null; email: string | null; emergencyContact: string | null; employmentStatus: 'active' | 'left'; joiningDate: string | null
  source: string; archivedAt: Date | null; createdAt: Date; updatedAt: Date
}>

/** Shows exactly the fields the record carries: a masked field is absent from the data, so it is absent from the page. */
export function Profile({ shape, staff, canManage }: { shape: StaffShape; staff: StaffRecord; canManage: boolean }) {
  const s = staff as Loose
  const has = (k: keyof Loose) => k in s
  const rows: [string, ReactNode][] = []
  rows.push(['Employee ID', <span key="e" className="mono">{s.employeeId}</span>])
  if (has('gender')) rows.push(['Gender', s.gender ? (s.gender === 'male' ? 'Male' : 'Female') : dash])
  if (has('department')) rows.push(['Department', s.department ?? dash])
  if (has('grade')) rows.push(['Grade', s.grade ?? dash])
  if (has('joiningDate')) rows.push(['Joining date', s.joiningDate ?? dash])
  if (has('phone')) rows.push(['Phone', s.phone ? <span key="p" className="mono">{s.phone}</span> : dash])
  if (has('email')) rows.push(['Email', s.email ?? dash])
  if (has('emergencyContact')) rows.push(['Emergency contact', s.emergencyContact ?? dash])
  if (has('source')) rows.push(['Entered by', s.source === 'csv' ? 'CSV import' : s.source === 'manual' ? 'Manual entry' : s.source === 'migration' ? 'Migration' : 'Demo data'])
  if (has('updatedAt') && s.updatedAt) rows.push(['Last changed', s.updatedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'])

  return (
    <div className="stack">
      {s.archivedAt && <Alert tone="warning" title="This profile is archived" detail="It is hidden from the default views. Nothing was deleted." />}
      <GlassCard strong
        title={<Person name={s.fullName ?? ''} sub={s.department ?? undefined} />}
        actions={<>
          <Status s={s.employmentStatus === 'left' ? 'Left' : 'Active'} />
          {canManage && !s.archivedAt && <>
            <Link href={`/staff/${s.id}/edit`} className="btn secondary" style={{ textDecoration: 'none' }}><Icon name="userCog" />Edit</Link>
            <ArchiveButton id={s.id!} name={s.fullName ?? 'this person'} />
          </>}
        </>}>
        <dl className="kv">
          {rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
        </dl>
      </GlassCard>
      {SHAPE_NOTE[shape] && <Alert tone="info" title={SHAPE_NOTE[shape]!} />}
      {shape === 'full' && <p className="muted body-sm"><Badge tone="neutral" dot={false}>Employee ID cannot be changed</Badge> It is the unique business key; other records will point at it.</p>}
    </div>
  )
}
