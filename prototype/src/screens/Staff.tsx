import { useMemo, useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, DataTable, Field, GlassCard, Icon, Input, PageHeader, Person, Select, Status, Tabs, Textarea } from '../ui'
import { activeStayOfStaff, bedById, can } from '../domain/rules'
import { fmtDate, today } from '../domain/time'
import type { Gender, MigrationRow, Staff as StaffT } from '../domain/types'

type Tab = 'directory' | 'add' | 'csv' | 'migration'

export function Staff() {
  const { s, persona, params } = useCtx()
  const [tab, setTab] = useState<Tab>(params.add ? 'add' : 'directory')
  const manage = can(persona, 'staff.manage')
  const options = [{ id: 'directory' as Tab, label: 'Directory' }, ...(manage ? [{ id: 'add' as Tab, label: 'Add staff' }, { id: 'csv' as Tab, label: 'CSV import' }, { id: 'migration' as Tab, label: 'Import current occupancy' }] : [])]
  return (
    <>
      <PageHeader crumbs={['People']} title="Staff directory" summary={persona.role === 'Rec' ? 'Lookup with minimum data. Eligibility details stay with admins.' : 'Employee ID is the unique business key. No HRMS: entered manually or by CSV.'}
        actions={<Tabs value={tab} onChange={setTab} options={options} />} />
      {tab === 'directory' && <Directory initialQ={params.q ?? ''} initialF={params.f ?? 'all'} />}
      {tab === 'add' && manage && <AddStaff onDone={() => setTab('directory')} />}
      {tab === 'csv' && manage && <CsvImport />}
      {tab === 'migration' && manage && <Migration />}
    </>
  )
}

function Directory({ initialQ, initialF }: { initialQ: string; initialF: string }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const [q, setQ] = useState(initialQ)
  const [f, setF] = useState(initialF)
  const full = persona.role !== 'Rec'
  const rows = s.staff.filter(x => (f === 'all' ? !x.archived : f === 'unverified' ? !x.verified && x.status === 'Active' : f === 'left' ? x.status === 'Left' : x.status === 'Active'))
    .filter(x => (x.name + x.id + x.dept).toLowerCase().includes(q.toLowerCase())).slice(0, 40)
  return (
    <DataTable rowKey={x => x.id} rows={rows} footer={<span>Showing {rows.length} (first 40). Former staff are archived from default views but stay searchable. Never deleted.</span>}
      toolbar={<><label className="search" style={{ margin: 0, maxWidth: 300 }}><Icon name="search" /><input placeholder="Search name, ID or department" value={q} onChange={e => setQ(e.target.value)} aria-label="Search staff" /></label>
        <Tabs value={f} onChange={setF} options={[{ id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'unverified', label: 'Unverified' }, { id: 'left', label: 'Left' }]} /></>}
      cols={[
        { key: 'n', header: 'Staff', render: x => <Person name={x.name} sub={`${x.dept}${full ? ` · G${x.grade} · ${x.gender}` : ''}`} /> },
        { key: 'i', header: 'Employee ID', render: x => <span className="mono">{x.id}</span> },
        { key: 'p', header: 'Phone', render: x => <span className="mono">{full ? x.phone : '•••• ' + x.phone.slice(-4)}</span> },
        { key: 'b', header: 'Bed', render: x => { const st = activeStayOfStaff(s, x.id); return st ? <span className="mono">{bedById(s, st.bedId)?.code}</span> : <span className="muted">·</span> } },
        { key: 's', header: 'Status', render: x => x.status === 'Left' ? <Status s="Left" label={`Left ${x.leftEffective ? fmtDate(x.leftEffective) : ''}`} /> : x.verified ? <Status s="Active" /> : <Badge tone="warning">Unverified</Badge> },
        { key: 'a', header: '', align: 'r', render: x => can(persona, 'staff.manage') && !x.verified && x.status === 'Active' ? <Button size="sm" onClick={() => act(A.verifyStaff(persona, x.id))}>Verify</Button> : null },
      ]} />
  )
}

function AddStaff({ onDone }: { onDone: () => void }) {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [f, setF] = useState({ id: '', name: '', gender: 'Male' as Gender, dept: 'Front office', grade: 2, phone: '', email: '', emergencyContact: '', joining: today(now) })
  const set = (k: string, v: string | number) => setF({ ...f, [k]: v })
  const dup = f.id.trim() && s.staff.find(x => x.id.trim().toLowerCase() === f.id.trim().toLowerCase())
  return (
    <GlassCard strong title="Add a staff member" subtitle="Minimum profile. Email is optional, and username defaults to the employee ID.">
      <div className="stack" style={{ maxWidth: 640 }}>
        <div className="grid even">
          <Field label="Employee ID" error={dup ? `Already used by ${dup.name}. Duplicates are rejected, never auto-merged.` : undefined}><Input value={f.id} onChange={e => set('id', e.target.value)} invalid={!!dup} /></Field>
          <Field label="Full name"><Input value={f.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Gender" hint="Used by the configured eligibility rule"><Select value={f.gender} onChange={e => set('gender', e.target.value)}><option>Male</option><option>Female</option></Select></Field>
          <Field label="Department"><Input value={f.dept} onChange={e => set('dept', e.target.value)} /></Field>
          <Field label="Grade" hint="G1 to G7"><Input type="number" min={1} max={7} value={f.grade} onChange={e => set('grade', +e.target.value)} /></Field>
          <Field label="Joining date"><Input type="date" value={f.joining} onChange={e => set('joining', e.target.value)} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={e => set('phone', e.target.value)} /></Field>
          <Field label="Email" optional hint="No email: admin-assisted temporary credential"><Input value={f.email} onChange={e => set('email', e.target.value)} /></Field>
        </div>
        <Field label="Emergency contact"><Input value={f.emergencyContact} onChange={e => set('emergencyContact', e.target.value)} /></Field>
        <div className="row"><Button variant="primary" onClick={() => act(A.addStaff(persona, { ...f, email: f.email || undefined }), onDone)}>Add staff</Button></div>
      </div>
    </GlassCard>
  )
}

/* ---------------- CSV import with preview (D-34) ---------------- */
const SAMPLE_CSV = `employee_id,full_name,gender,department,designation_or_grade,phone,email_or_username,joining_date,employment_status,emergency_contact_name,emergency_contact_phone
E3001,Hassan Ali,Male,Culinary,2,+971501110001,,2026-10-12,Active,Amina Ali,+971501110099
E3002,Nadia Karim,Female,Spa,3,+971501110002,nadia@example.com,2026-10-12,Active,Sami Karim,+971501110098
E1007,Duplicate Rahul,Male,Front office,3,+971501110003,,2026-10-12,Active,,
E3004,=HYPERLINK("http://bad"),Female,Events,2,+971501110004,,2026-10-12,Active,,
E3005,Rina Das,Female,Laundry,2,+971501110005,,12/13/2026,Active,,
E3006,Karthik Raja,Male,Engineering,4,+971501110006,,2026-10-13,Active,Meena Raja,+971501110097
E3006,Karthik Raja,Male,Engineering,4,+971501110006,,2026-10-13,Active,Meena Raja,+971501110097`

type Row = { raw: string[]; status: 'accepted' | 'duplicate' | 'invalid' | 'warning'; why: string; rec?: Omit<StaffT, 'status' | 'loginActive' | 'exceptions' | 'verified' | 'source'> }
function parse(text: string, existing: string[]): Row[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  const seen = new Set(existing.map(x => x.toLowerCase()))
  return lines.slice(1).map(l => {
    const c = l.split(',').map(x => x.trim())
    const [id, name, gender, dept, grade, phone, email, joining, , ecn, ecp] = c
    const bad = c.find(x => /^[=+\-@]/.test(x) && !/^\+\d+$/.test(x))
    if (bad) return { raw: c, status: 'invalid', why: `Formula injection guard: “${bad.slice(0, 16)}…” starts with =, +, - or @` }
    if (!id || !name) return { raw: c, status: 'invalid', why: 'Employee ID and full name are required' }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(joining ?? '')) return { raw: c, status: 'invalid', why: `Joining date “${joining}” is not a valid date (use YYYY-MM-DD)` }
    if (seen.has(id.toLowerCase())) return { raw: c, status: 'duplicate', why: `Employee ID ${id} already exists. Never auto-merged` }
    seen.add(id.toLowerCase())
    const rec = { id, name, gender: (gender === 'Female' ? 'Female' : 'Male') as Gender, dept, grade: +grade || 1, phone, email: email || undefined, emergencyContact: ecn ? `${ecn} · ${ecp}` : '', joining }
    return { raw: c, status: !ecn ? 'warning' : 'accepted', why: !ecn ? 'No emergency contact (confirm whether required)' : 'OK', rec }
  })
}

function CsvImport() {
  const { s, persona } = useCtx()
  const act = useAct()
  const [text, setText] = useState('')
  const rows = useMemo(() => text ? parse(text, s.staff.map(x => x.id)) : [], [text, s.staff])
  const count = (k: Row['status']) => rows.filter(r => r.status === k).length
  const good = rows.filter(r => r.status === 'accepted' || r.status === 'warning')
  const downloadRejected = () => {
    const rej = rows.filter(r => r.status === 'invalid' || r.status === 'duplicate')
    const blob = new Blob(['row,reason\n' + rej.map(r => `"${r.raw.join(' | ').replace(/"/g, "'")}","${r.why}"`).join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'rejected-rows.csv'; a.click()
  }
  return (
    <div className="stack">
      <GlassCard strong title="Paste CSV" subtitle="Preview first: accepted, duplicate, invalid and warning rows are shown before anything is saved." actions={<Button onClick={() => setText(SAMPLE_CSV)}>Load sample</Button>}>
        <Textarea style={{ minHeight: 120, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={text} onChange={e => setText(e.target.value)} placeholder="employee_id,full_name,gender,department,…" aria-label="CSV text" />
      </GlassCard>
      {rows.length > 0 && <>
        <div className="grid stats"><div className="card stat"><span className="lbl">Accepted</span><span className="kpi">{count('accepted')}</span></div><div className="card stat"><span className="lbl">Warnings</span><span className="kpi">{count('warning')}</span></div><div className="card stat"><span className="lbl">Duplicates</span><span className="kpi">{count('duplicate')}</span></div><div className="card stat"><span className="lbl">Invalid</span><span className="kpi">{count('invalid')}</span></div></div>
        <GlassCard strong flush>
          <table className="tbl"><thead><tr><th>Row</th><th>Employee ID</th><th>Name</th><th>Result</th><th>Why</th></tr></thead><tbody>
            {rows.map((r, i) => <tr key={i}><td className="tnum">{i + 2}</td><td className="mono">{r.raw[0]}</td><td>{r.raw[1]}</td><td><Badge tone={r.status === 'accepted' ? 'success' : r.status === 'warning' ? 'warning' : r.status === 'duplicate' ? 'neutral' : 'danger'}>{r.status}</Badge></td><td className="muted body-sm">{r.why}</td></tr>)}
          </tbody></table>
        </GlassCard>
        <div className="row"><Button variant="primary" disabled={good.length === 0} onClick={() => act(A.commitStaffCsv(persona, good.map(r => r.rec!)), () => setText(''))}>Import {good.length} rows</Button><Button onClick={downloadRejected} disabled={count('invalid') + count('duplicate') === 0}>Download rejected rows</Button></div>
      </>}
    </div>
  )
}

/* ---------------- Import Current Occupancy (migration, D-86) ---------------- */
const SAMPLE_OCC = `employee_id,bed_code,start_date,end_date
E1100,PV-V01-R3-A,2026-06-01,2027-05-31
E1101,PV-V05-R3-A,2026-07-15,
E1102,PV-V05-R3-B,2026-08-01,2027-01-31
E1103,PV-V02-R3-A,2026-05-20,
E9999,PV-V02-R3-B,2026-05-20,2027-01-01
E1100,PV-V02-R2-B,2026-05-20,2027-01-01`

function Migration() {
  const { s, persona } = useCtx()
  const act = useAct()
  const [text, setText] = useState('')
  const batch = s.migration
  const rows: MigrationRow[] = useMemo(() => {
    if (!text) return []
    const seenBed = new Set<string>(), seenEmp = new Set<string>()
    return text.split(/\r?\n/).filter(l => l.trim()).slice(1).map(l => {
      const [empId, bedCode, start, end] = l.split(',').map(x => x.trim())
      const staff = s.staff.find(x => x.id.toLowerCase() === empId.toLowerCase())
      const bed = s.beds.find(b => b.code === bedCode)
      let error: string | undefined
      if (!staff) error = `Unknown employee ID ${empId}`
      else if (!bed) error = `Unknown bed ${bedCode}`
      else if (bed.state === 'Occupied' || s.stays.some(st => st.bedId === bed.id && st.status === 'Active')) error = `${bedCode} is already occupied`
      else if (seenBed.has(bedCode)) error = `${bedCode} appears twice in the file`
      else if (seenEmp.has(empId.toLowerCase()) || s.stays.some(st => st.staffId === staff.id && st.status === 'Active')) error = `${staff.name} already has a stay`
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) error = 'Invalid start date'
      seenBed.add(bedCode); seenEmp.add(empId.toLowerCase())
      return { empId, bedCode, start, end: end || undefined, error }
    })
  }, [text, s])
  const valid = rows.filter(r => !r.error)
  const canPrepare = can(persona, 'migration.prepare')
  return (
    <div className="stack">
      <Alert tone="info" title="Go-live migration (maker-checker)" detail="One tool brings current occupants in: stays tagged source = Migrated bypass request and reservation. An Accommodation Admin prepares, a Policy Approver or Super Admin signs off. Stays without an end date import as “End date pending”." />
      {batch && <Alert tone={batch.status === 'Imported' ? 'success' : 'warning'} title={`Batch ${batch.status.toLowerCase()}`} detail={`${batch.rows.filter(r => !r.error).length} valid rows · prepared by ${batch.preparedBy}${batch.signedBy ? ' · signed off by ' + batch.signedBy : ''}`} action={batch.status === 'Prepared' && can(persona, 'migration.signoff') ? <Button variant="primary" size="sm" onClick={() => act(A.signOffMigration(persona))}>Sign off</Button> : undefined} />}
      {canPrepare && <>
        <GlassCard strong title="Paste occupancy CSV" subtitle="employee_id, bed_code, start_date, end_date" actions={<Button onClick={() => setText(SAMPLE_OCC)}>Load sample</Button>}>
          <Textarea style={{ minHeight: 110, fontFamily: 'var(--font-mono)', fontSize: 12 }} value={text} onChange={e => setText(e.target.value)} aria-label="Occupancy CSV" />
        </GlassCard>
        {rows.length > 0 && <GlassCard strong flush><table className="tbl"><thead><tr><th>Employee</th><th>Bed</th><th>Start</th><th>End</th><th>Result</th></tr></thead><tbody>
          {rows.map((r, i) => <tr key={i}><td className="mono">{r.empId}</td><td className="mono">{r.bedCode}</td><td className="tnum">{r.start}</td><td>{r.end ?? <Badge tone="warning">End date pending</Badge>}</td><td>{r.error ? <Badge tone="danger">{r.error}</Badge> : <Badge tone="success">Valid</Badge>}</td></tr>)}
        </tbody></table></GlassCard>}
        <div><Button variant="primary" disabled={valid.length === 0} onClick={() => act(A.prepareMigration(persona, rows))}>Prepare {valid.length} rows for sign-off</Button></div>
      </>}
      {!canPrepare && <Blocked why="Only an Accommodation Admin prepares the import" owner="Accommodation Admin (maker)" next={`Sign-off is by a Policy Approver or Super Admin${can(persona, 'migration.signoff') ? '. You can sign off a prepared batch from here.' : ''}`} />}
    </div>
  )
}
