import { useMemo, useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Check, DataTable, Field, GlassCard, Icon, Input, Modal, PageHeader, Person, Select, Status, Stepper, Tabs, Textarea } from '../ui'
import { bedById, bedConflict, bedPath, eligibility, resStatusView, staffById, stayState, suggestBeds, can } from '../domain/rules'
import { addDays, dayDiff, fmtDate, fmtTime, today } from '../domain/time'
import { PERSONAS } from '../roles'
import type { StayType } from '../domain/types'

export function Allocations() {
  const { s, persona, params, go } = useCtx()
  const [tab, setTab] = useState<'reservations' | 'stays' | 'bulk' | 'lab'>((params.tab as 'stays') ?? (params.bulk ? 'bulk' : 'reservations'))
  const canManage = can(persona, 'allocate.bulk')
  return (
    <>
      <PageHeader crumbs={['Accommodation']} title="Allocations" summary="Request ≠ Reservation ≠ Stay. Each is its own record with its own state."
        actions={<Tabs value={tab} onChange={setTab} options={[{ id: 'reservations', label: 'Reservations' }, { id: 'stays', label: 'Stays' }, ...(canManage ? [{ id: 'bulk' as const, label: 'Bulk allocation' }, { id: 'lab' as const, label: 'Conflict lab' }] : [])]} />} />
      {tab === 'reservations' && <Reservations />}
      {tab === 'stays' && <Stays filter={params.f} />}
      {tab === 'bulk' && canManage && <Bulk />}
      {tab === 'lab' && canManage && <ConflictLab />}
    </>
  )
}

function Reservations() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const [sel, setSel] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [results, setResults] = useState<{ id: string; ok: boolean; msg: string }[] | null>(null)
  const rows = s.reservations.filter(r => r.status === 'Reserved').sort((a, b) => a.from.localeCompare(b.from))
  const doBulk = () => act(A.bulkCheckIn(persona, sel), r => { setResults(r.data ?? null); setSel([]) })
  return (
    <>
      <DataTable selectable={can(persona, 'checkin.execute')} selected={sel} onSelect={setSel} rowKey={r => r.id} rows={rows}
        toolbar={<><span className="muted">{rows.length} active reservations</span><span className="spacer" />{sel.length > 0 && <Button variant="primary" onClick={doBulk}>Bulk check-in ({sel.length})</Button>}</>}
        cols={[
          { key: 'r', header: 'Resident', render: r => { const x = staffById(s, r.staffId)!; return <Person name={x.name} sub={x.dept} /> } },
          { key: 'b', header: 'Bed', render: r => <span className="mono">{bedById(s, r.bedId)?.code}</span> },
          { key: 'd', header: 'Dates', render: r => <span className="tnum">{fmtDate(r.from)} → {r.to ? fmtDate(r.to) : 'open'}</span> },
          { key: 'e', header: 'ETA', align: 'r', render: r => <span className="tnum">{r.from === today(now) ? fmtTime(r.eta) : '·'}</span> },
          { key: 'src', header: 'Source', render: r => <Badge outline>{r.source}</Badge> },
          { key: 's', header: 'Status', render: r => r.from > today(now) ? <Status s="Reserved" /> : <Status s={resStatusView(r, now, bedById(s, r.bedId))} /> },
          { key: 'a', header: '', align: 'r', render: r => <Button size="sm" variant={r.from <= today(now) ? 'primary' : 'secondary'} onClick={() => setOpen(r.id)}>{r.from <= today(now) ? 'Check in' : 'Open'}</Button> },
        ]} />
      {results && <Modal open onClose={() => setResults(null)} title="Bulk check-in result" subtitle="Per-row results. Failed rows changed nothing and can be retried." footer={<Button variant="primary" onClick={() => setResults(null)}>Done</Button>}>
        <ul className="list-plain">{results.map(r => <li key={r.id}><Badge tone={r.ok ? 'success' : 'warning'}>{r.ok ? 'Checked in' : 'Not done'}</Badge><span>{r.msg}</span></li>)}</ul>
      </Modal>}
      {open && <CheckInModal reservationId={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function Stays({ filter }: { filter?: string }) {
  const { s, persona, now, go } = useCtx()
  const [f, setF] = useState(filter ?? 'all')
  const T = today(now)
  const stays = s.stays.filter(x => x.status === 'Active')
  const rows = stays.filter(x => f === 'all' ? true : f === 'overdue' ? ['overdue', 'escalated'].includes(stayState(x, T, s.config)) : f === 'ending' ? x.end && x.end >= T && x.end <= addDays(T, 7) : f === 'pending' ? x.endPending : true)
  return (
    <DataTable rowKey={x => x.id} rows={rows}
      toolbar={<Tabs value={f} onChange={setF} options={[{ id: 'all', label: 'All', count: stays.length }, { id: 'overdue', label: 'Overdue' }, { id: 'ending', label: 'Ending this week' }, { id: 'pending', label: 'End date pending' }]} />}
      cols={[
        { key: 'r', header: 'Resident', render: x => { const st = staffById(s, x.staffId)!; return <Person name={st.name} sub={`${st.dept}${st.status === 'Left' ? ' · left organisation' : ''}`} /> } },
        { key: 'b', header: 'Bed', render: x => <span className="mono">{bedById(s, x.bedId)?.code}</span> },
        { key: 't', header: 'Type', render: x => <><Badge outline>{x.stayType}</Badge> {x.source !== 'Standard' && <Badge tone={x.source === 'Provisional' ? 'info' : 'champagne'} dot={false}>{x.source}</Badge>}</> },
        { key: 'sd', header: 'Since', render: x => <span className="tnum">{fmtDate(x.start)}</span> },
        { key: 'e', header: 'Planned end', render: x => x.end ? <span className="tnum">{fmtDate(x.end)}</span> : <Badge tone="warning">End date pending</Badge> },
        { key: 's', header: 'Status', render: x => { const st = stayState(x, T, s.config); return st === 'escalated' ? <Badge tone="danger">Overdue · escalated to Policy Approver</Badge> : st === 'overdue' ? <Status s="Overdue" label={`Overdue ${-dayDiff(T, x.end!)}d`} /> : x.exitPending ? <Badge tone="neutral">Left organisation</Badge> : x.checkoutRequested ? <Status s="Checkout due" label="Checkout requested" /> : st === 'ending' ? <Status s="Checkout due" label="Ending soon" /> : <Status s="Active" /> } },
        { key: 'a', header: '', align: 'r', render: x => <Button size="sm" variant="ghost" onClick={() => go('exits', { stay: x.id })}>Checkout…</Button> },
      ]} />
  )
}

/* ============ Check-in wizard ============ */
export function CheckInModal({ reservationId, onClose }: { reservationId: string; onClose: () => void }) {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const r = s.reservations.find(x => x.id === reservationId)
  const [step, setStep] = useState(0)
  const [idOk, setIdOk] = useState(false)
  const [key, setKey] = useState(false)
  const [reason, setReason] = useState('')
  if (!r) return null
  const staff = staffById(s, r.staffId)!, bed = bedById(s, r.bedId)!
  const el = eligibility(s, staff, bed)
  const ready = bed.state === 'Available'
  const canNext = [idOk, ready && el.ok, key, true][step]
  const status = resStatusView(r, now, bed)
  return (
    <Modal open onClose={onClose} title={`Check in ${staff.name}`} subtitle={bedPath(s, bed)}
      footer={<>
        {step === 0 && <><Button onClick={() => act(A.extendNoShow(persona, r.id, reason || 'Delayed flight'))} disabled={status !== 'No-show'}>Extend no-show (once)</Button><Button variant="danger" onClick={() => act(A.cancelReservation(persona, r.id, reason || 'Cancelled at desk'), onClose)}>Cancel reservation</Button></>}
        <span className="spacer" />
        {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
        {step < 3 ? <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue</Button>
          : <Button variant="primary" onClick={() => act(A.checkIn(persona, r.id, { idVerified: idOk, keyIssued: key }), onClose)}>Check in</Button>}
      </>}>
      <Stepper steps={['Identity', 'Readiness', 'Keys', 'Confirm']} current={step} />
      {step === 0 && <div className="stack">
        <div className="row"><span className="avatar lg">{staff.name.split(' ').map(x => x[0]).join('')}</span><div><b>{staff.name}</b><div className="muted body-sm">{staff.id} · {staff.dept}</div></div><span className="spacer" />{status === 'No-show' && <Status s="No-show" />}</div>
        {staff.hasPhoto ? <Alert tone="info" title="Verify against the photo on file" detail="Reception and Security see identity data only. Eligibility data stays with admins." /> : <Alert tone="warning" title="No photo on file" detail="Check the employee ID card in person. No ID number is stored. Ask the Accommodation Admin to add a photo." />}
        <Check checked={idOk} onChange={setIdOk}>I have verified this person’s identity</Check>
        {status === 'No-show' && <Field label="Reason (for extending or cancelling)" optional><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>}
      </div>}
      {step === 1 && <div className="stack">
        <div className="row"><b>Bed readiness:</b> <Status s={bed.state} /></div>
        {!ready && <Blocked why={`${bed.code} is not ready: ${bed.state === 'NeedsCleaning' ? 'needs cleaning' : bed.state === 'InspectionRequired' ? 'awaiting final inspection' : bed.state}`} owner={bed.state === 'InspectionRequired' ? 'Final Inspection holder' : 'Housekeeping'} next="Assign cleaning, then run final inspection. The reservation stays valid" />}
        {ready && <Alert tone="success" title="Room is ready" detail="Cleaned and inspected." />}
        <b>Eligibility (revalidated now):</b>
        {el.ok ? <Alert tone="success" title="Still eligible" /> : <Blocked why={el.reasons.join('; ')} owner="Policy Approver" next="Review the exception or reallocate" />}
      </div>}
      {step === 2 && <div className="stack"><Check checked={key} onChange={setKey}>Room key issued to {staff.name}</Check><p className="muted body-sm">Key model for shared rooms (room key, bed locker key or both) is an open question for Grand Hyatt (D-72). Recorded as a single room key for now.</p></div>}
      {step === 3 && <div className="stack"><dl className="kv"><dt>Resident</dt><dd>{staff.name}</dd><dt>Bed</dt><dd className="mono">{bed.code}</dd><dt>Dates</dt><dd>{fmtDate(r.from)} → {r.to ? fmtDate(r.to) : 'open'}</dd></dl><Alert tone="info" title="One atomic commit" detail="The stay and the bed's occupancy are committed together. If anything fails, neither changes." /></div>}
    </Modal>
  )
}

/* ============ Bulk allocation ============ */
function Bulk() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const T = today(now)
  const cands = s.staff.filter(x => x.status === 'Active' && !s.stays.some(st => st.staffId === x.id && st.status === 'Active') && !s.reservations.some(r => r.staffId === x.id && r.status === 'Reserved') && !s.offers.some(o => o.staffId === x.id && o.status === 'Pending'))
    .filter(x => s.requests.some(r => r.staffId === x.id && r.status === 'Submitted') || s.waitlist.some(w => w.staffId === x.id && w.status === 'Waiting'))
  const [sel, setSel] = useState<string[]>(cands.slice(0, 3).map(c => c.id))
  const [from, setFrom] = useState(addDays(T, 3)), [to, setTo] = useState(addDays(T, 183))
  const [type, setType] = useState<StayType>('Permanent')
  const [results, setResults] = useState<{ staffId: string; ok: boolean; msg: string }[] | null>(null)
  const preview = useMemo(() => {
    const taken = new Set<string>()
    return sel.map(id => {
      const st = staffById(s, id)!
      const bed = suggestBeds(s, st, { from, to }, persona.sites).find(b => !taken.has(b.id))
      if (bed) taken.add(bed.id)
      return { st, bed }
    })
  }, [s, sel, from, to, persona])
  const run = () => act(A.bulkAllocate(persona, preview.filter(p => p.bed).map(p => ({ staffId: p.st.id, bedId: p.bed!.id, from, to, stayType: type }))), r => setResults(r.data ?? null))
  return (
    <div className="stack">
      <GlassCard title="1 · Select staff" subtitle="People with an open request or waitlist entry and no bed yet" strong>
        <div className="grid even" style={{ marginBottom: 12 }}><Field label="Arrival"><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="Planned end"><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field></div>
        <Field label="Stay type"><Select value={type} onChange={e => setType(e.target.value as StayType)}><option>Permanent</option><option>Contract</option><option>Trainee</option></Select></Field>
        <div className="chips" style={{ marginTop: 12 }}>{cands.map(c => <label key={c.id} className="check badge outline" style={{ height: 30, padding: '0 10px' }}><input type="checkbox" checked={sel.includes(c.id)} onChange={e => setSel(e.target.checked ? [...sel, c.id] : sel.filter(x => x !== c.id))} />{c.name}</label>)}</div>
      </GlassCard>
      <GlassCard title="2 · Preview" subtitle="Auto-matched to eligible free beds. Conflicts are flagged before you confirm." strong flush>
        <table className="tbl"><thead><tr><th>Staff</th><th>Rule</th><th>Matched bed</th><th>Result</th></tr></thead><tbody>
          {preview.map(p => <tr key={p.st.id}><td><Person name={p.st.name} sub={`${p.st.gender} · G${p.st.grade}`} /></td><td className="muted body-sm">{p.st.gender} room{p.st.grade >= 4 ? ' · Marina eligible' : ''}</td><td className="mono">{p.bed?.code ?? '—'}</td><td>{p.bed ? <Badge tone="success">Ready to reserve</Badge> : <Badge tone="warning">No eligible free bed</Badge>}</td></tr>)}
          {preview.length === 0 && <tr><td colSpan={4}><div className="tbl-empty">Select at least one person</div></td></tr>}
        </tbody></table>
      </GlassCard>
      <div className="row"><Button variant="primary" disabled={!preview.some(p => p.bed)} onClick={run}>Confirm allocation ({preview.filter(p => p.bed).length})</Button><span className="muted body-sm">The preview is the approval. Per-row results follow; failed rows leave no trace and can be retried safely.</span></div>
      {results && <Modal open onClose={() => setResults(null)} title="Bulk allocation result" footer={<Button variant="primary" onClick={() => setResults(null)}>Done</Button>}>
        <ul className="list-plain">{results.map(r => <li key={r.staffId}><Badge tone={r.ok ? 'success' : 'warning'}>{r.ok ? 'Reserved' : 'Not done'}</Badge><span><b style={{ fontWeight: 500 }}>{staffById(s, r.staffId)?.name}</b> · {r.msg}</span></li>)}</ul>
      </Modal>}
    </div>
  )
}

/* ============ Conflict lab: two admins, one bed ============ */
function ConflictLab() {
  const { s, now } = useCtx()
  const act = useAct()
  const open = s.requests.filter(r => r.status === 'Submitted')
  const males = open.filter(r => staffById(s, r.staffId)?.gender === 'Male')
  const [qa, setQa] = useState(males[0]?.id ?? '')
  const [qb, setQb] = useState(males[1]?.id ?? '')
  const a = s.requests.find(x => x.id === qa), b = s.requests.find(x => x.id === qb)
  const bedChoices = a && b ? suggestBeds(s, staffById(s, a.staffId)!, { from: a.arrival, to: a.end }, 'all').filter(x => suggestBeds(s, staffById(s, b.staffId)!, { from: b.arrival, to: b.end }, 'all').some(y => y.id === x.id)) : []
  const [bedId, setBedId] = useState('')
  const bed = bedId || bedChoices[0]?.id
  const anita = PERSONAS.find(p => p.id === 'p-aa')!, suresh = PERSONAS.find(p => p.id === 'p-pa')!
  const [log, setLog] = useState<string[]>([])
  const click = (who: typeof anita, req: typeof a) => {
    if (!req || !bed) return
    const r = act(A.approveRequest(who, req.id, bed))
    setLog(l => [...l, `${who.name} → ${staffById(s, req.staffId)?.name}: ${r.ok ? 'reserved ' + bedById(s, bed)?.code : 'blocked: ' + r.reason}`])
  }
  return (
    <div className="stack">
      <Alert tone="info" title="Two admins pick the same bed at the same moment" detail="Both screens loaded the same suggestions. Whoever confirms first wins. The second is revalidated against current state, refused with a reason, and nothing half-saves." />
      {males.length < 2 || !bed ? <Blocked why="Need two open requests from staff of the same gender, and one bed that suits both" next="Submit another request, or reset the demo data" /> :
        <div className="grid even">
          {[{ who: anita, req: a, set: setQa }, { who: suresh, req: b, set: setQb }].map(({ who, req, set }) => (
            <GlassCard key={who.id} title={`${who.name}’s screen`} subtitle="Same bed selected" strong>
              <div className="stack">
                <Field label="Request"><Select value={req?.id ?? ''} onChange={e => set(e.target.value)}>{males.map(r => <option key={r.id} value={r.id}>{staffById(s, r.staffId)?.name}</option>)}</Select></Field>
                <div className="row"><span className="muted">Selected bed</span><span className="mono">{bedById(s, bed)?.code}</span></div>
                <Button variant="primary" disabled={!req || req.status !== 'Submitted'} onClick={() => click(who, req)}>Approve and reserve as {who.name.split(' ')[0]}</Button>
              </div>
            </GlassCard>
          ))}
        </div>}
      {bedChoices.length > 1 && <Field label="Contested bed"><Select value={bed ?? ''} onChange={e => setBedId(e.target.value)}>{bedChoices.map(x => <option key={x.id} value={x.id}>{x.code}</option>)}</Select></Field>}
      {log.length > 0 && <GlassCard title="What happened" strong><ul className="list-plain">{log.map((l, i) => <li key={i}><Icon name={l.includes('blocked') ? 'alert' : 'checkCircle'} />{l}</li>)}</ul></GlassCard>}
    </div>
  )
}
