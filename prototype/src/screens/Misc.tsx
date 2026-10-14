import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Countdown, DataTable, Field, GlassCard, Icon, Input, Modal, OccupancyBar, PageHeader, Person, Select, Status, Tabs, Textarea } from '../ui'
import { bedsInScope, occupancy } from '../domain/select'
import { activeStayOfStaff, bedById, bedPath, buildingOf, can, roomOf, staffById, stayState } from '../domain/rules'
import { fmtDate, fmtDateTime, today, addDays } from '../domain/time'

/* ============ Keys ============ */
export function Keys() {
  const { s, persona } = useCtx()
  const act = useAct()
  const [f, setF] = useState<'Issued' | 'Lost' | 'Returned'>('Issued')
  const rows = s.keys.filter(k => k.status === f).slice(0, 40)
  const manage = can(persona, 'key.manage')
  return (
    <>
      <PageHeader crumbs={['Operations']} title="Keys" summary="A lost or damaged key is never marked returned. A replacement retires the old key and links the new one."
        actions={<Tabs value={f} onChange={setF} options={[{ id: 'Issued', label: 'Issued', count: s.keys.filter(k => k.status === 'Issued').length }, { id: 'Lost', label: 'Lost', count: s.keys.filter(k => k.status === 'Lost').length }, { id: 'Returned', label: 'Returned' }]} />} />
      {persona.role === 'Sec' && <Alert tone="info" title="Night Keys capability" detail="Issue and return keys out of hours. A missing key goes to the Accommodation Admin." />}
      <DataTable rowKey={k => k.id} rows={rows} empty="No keys here" cols={[
        { key: 'b', header: 'Bed', render: k => <span className="mono">{bedById(s, k.bedId)?.code}</span> },
        { key: 'r', header: 'Holder', render: k => <Person name={staffById(s, k.staffId)?.name ?? k.staffId} sub={k.kind} /> },
        { key: 'a', header: 'Issued', render: k => <span className="tnum">{fmtDateTime(k.at)}</span> },
        { key: 's', header: 'Status', render: k => <Badge tone={k.status === 'Issued' ? 'info' : k.status === 'Lost' ? 'danger' : 'neutral'}>{k.status}</Badge> },
        { key: 'x', header: '', align: 'r', render: k => manage ? <div className="row" style={{ justifyContent: 'flex-end' }}>
          {k.status === 'Issued' && <><Button size="sm" onClick={() => act(A.returnKey(persona, k.id))}>Return</Button><Button size="sm" variant="danger" onClick={() => act(A.reportKeyLost(persona, k.id))}>Lost</Button></>}
          {k.status === 'Lost' && <><Button size="sm" onClick={() => act(A.returnKey(persona, k.id))}>Mark returned</Button><Button size="sm" variant="primary" onClick={() => act(A.replaceKey(persona, k.id))}>Issue replacement</Button></>}
        </div> : null },
      ]} />
    </>
  )
}

/* ============ Maintenance ============ */
export function Maintenance() {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const myStay = persona.staffId ? activeStayOfStaff(s, persona.staffId) : undefined
  const [bedId, setBedId] = useState(myStay?.bedId ?? s.beds[0].id)
  const [title, setTitle] = useState('')
  const visible = s.workOrders.filter(w => persona.role === 'Res' ? w.bedId === myStay?.bedId : persona.role === 'Vend' ? w.assignee === persona.vendor : persona.role === 'Tech' ? (w.assignee === persona.staffId || !w.assignee) : true)
  const canCreate = can(persona, 'workorder.create')
  return (
    <>
      <PageHeader crumbs={persona.role === 'Res' ? ['My stay'] : ['Operations']} title="Maintenance" summary="Resolved ≠ Verified ≠ Room ready. The person who did the work can’t verify it." />
      {canCreate && <GlassCard strong title="Report an issue" subtitle={persona.role === 'Res' ? 'In your room' : 'Creates a work order. Triage within 1 business day.'}>
        <div className="grid even">
          {persona.role !== 'Res' && <Field label="Bed"><Select value={bedId} onChange={e => setBedId(e.target.value)}>{s.beds.filter(b => b.state !== 'Archived').map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field>}
          <Field label="What’s wrong?"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. AC not cooling" /></Field>
        </div>
        <div style={{ marginTop: 12 }}><Button variant="primary" onClick={() => act(A.createWorkOrder(persona, { bedId: persona.role === 'Res' ? myStay?.bedId ?? bedId : bedId, title }), () => setTitle(''))}>Create work order</Button></div>
      </GlassCard>}
      <DataTable rowKey={w => w.id} rows={visible} empty="No work orders" cols={[
        { key: 't', header: 'Work order', render: w => <Person name={w.title} sub={bedById(s, w.bedId)?.code} /> },
        { key: 'a', header: 'Assignee', render: w => w.assignee ? <Badge outline>{staffById(s, w.assignee)?.name ?? w.assignee}</Badge> : <span className="muted">Unassigned</span> },
        { key: 'c', header: 'Raised', render: w => <span className="tnum">{fmtDate(w.createdAt)}</span> },
        { key: 's', header: 'Status', render: w => <Status s={w.status} /> },
        { key: 'x', header: '', align: 'r', render: w => <div className="row" style={{ justifyContent: 'flex-end' }}>
          {w.status === 'Open' && can(persona, 'workorder.manage') && <Button size="sm" onClick={() => act(A.advanceWorkOrder(persona, w.id, 'In progress', 'E9007'))}>Assign technician</Button>}
          {w.status === 'Open' && can(persona, 'workorder.work') && <Button size="sm" onClick={() => act(A.advanceWorkOrder(persona, w.id, 'In progress', persona.staffId ?? persona.vendor))}>Accept</Button>}
          {w.status === 'In progress' && can(persona, 'workorder.work') && <Button size="sm" variant="primary" onClick={() => act(A.advanceWorkOrder(persona, w.id, 'Resolved'))}>Submit for verification</Button>}
          {w.status === 'Resolved' && can(persona, 'workorder.verify') && <Button size="sm" variant="primary" onClick={() => act(A.advanceWorkOrder(persona, w.id, 'Verified'))}>Verify</Button>}
        </div> },
      ]} />
    </>
  )
}

/* ============ Incidents & SOS ============ */
export function Incidents() {
  const { s, persona } = useCtx()
  const act = useAct()
  const [text, setText] = useState('')
  const rows = s.incidents
  return (
    <>
      <PageHeader crumbs={['Operations']} title="Incidents and SOS" summary={`SOS never waits on approval. Security acknowledges within ${s.config.sosAckMinutes} minutes, then escalates to the Security Supervisor.`} />
      <Alert tone="warning" title="Phone fallback" detail="The app can’t guarantee delivery during a network outage. The front-desk phone and physical escalation remain the fallback." />
      {(persona.role === 'Res' || persona.role === 'Rec' || persona.role === 'AA') && <GlassCard strong title="Report">
        <div className="stack"><Field label="What happened?"><Textarea value={text} onChange={e => setText(e.target.value)} /></Field>
          <div className="row"><Button onClick={() => act(A.raiseSOS(persona, text || 'Incident', 'Incident'), () => setText(''))}>Report incident</Button>{can(persona, 'sos.raise') && <Button variant="danger" icon="siren" onClick={() => act(A.raiseSOS(persona, text || 'SOS', 'SOS'), () => setText(''))}>Send SOS</Button>}</div></div>
      </GlassCard>}
      <DataTable rowKey={i => i.id} rows={rows} empty="No incidents" cols={[
        { key: 'k', header: 'Type', render: i => <Badge tone={i.kind === 'SOS' ? 'danger' : 'warning'}>{i.kind}</Badge> },
        { key: 't', header: 'Details', render: i => <Person name={i.text} sub={`${i.staffId ? staffById(s, i.staffId)?.name : 'Staff'} · ${fmtDateTime(i.at)}`} /> },
        { key: 'a', header: 'Acknowledgement', render: i => i.ackAt ? <Badge tone="success">Acknowledged</Badge> : <Countdown to={i.at + s.config.sosAckMinutes * 60000} label="to acknowledge" warnBelowMs={120000} /> },
        { key: 's', header: 'Status', render: i => <Status s={i.closed ? 'Closed' : 'Open'} /> },
        { key: 'x', header: '', align: 'r', render: i => can(persona, 'incident.ack') && !i.closed ? <div className="row" style={{ justifyContent: 'flex-end' }}>{!i.ackAt && <Button size="sm" variant="primary" onClick={() => act(A.ackIncident(persona, i.id))}>Acknowledge</Button>}{i.ackAt && <Button size="sm" onClick={() => act(A.closeIncident(persona, i.id))}>Close</Button>}</div> : null },
      ]} />
    </>
  )
}

/* ============ Reports ============ */
export function Reports() {
  const { s, persona, now } = useCtx()
  const T = today(now)
  const canOutage = persona.caps.includes('OutageExport')
  const canExport = persona.role !== 'Mgr' && persona.role !== 'Sec'
  const overdue = s.stays.filter(x => x.status === 'Active' && ['overdue', 'escalated'].includes(stayState(x, T, s.config)))
  const outage = () => {
    const arrivals = s.reservations.filter(r => r.status === 'Reserved' && r.from <= addDays(T, 1))
    const departures = s.stays.filter(x => x.status === 'Active' && (x.end === T || x.end === addDays(T, 1) || x.checkoutRequested))
    const csv = ['CONFIDENTIAL · OUTAGE SNAPSHOT · generated ' + fmtDateTime(now) + ' by ' + persona.name, 'type,employee,name,bed,date',
      ...arrivals.map(r => `arrival,${r.staffId},${staffById(s, r.staffId)?.name},${bedById(s, r.bedId)?.code},${r.from}`),
      ...departures.map(x => `departure,${x.staffId},${staffById(s, x.staffId)?.name},${bedById(s, x.bedId)?.code},${x.end ?? 'requested'}`)].join('\n')
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'outage-snapshot.csv'; a.click()
  }
  return (
    <>
      <PageHeader crumbs={['Insight']} title="Reports" summary="Every figure rolls up from bed states. Scope-limited and export-controlled on the server." actions={canExport ? <Button icon="download" onClick={() => window.print()}>Print / save PDF</Button> : <Badge outline>Export needs a grant</Badge>} />
      <div className="grid even">{s.sites.filter(x => persona.sites === 'all' || persona.sites.includes(x.id)).map(site => <GlassCard key={site.id} title={site.name}><OccupancyBar {...occupancy(s, bedsInScope(s, persona, site.id))} scope={site.kind} /></GlassCard>)}</div>
      <GlassCard title="Occupancy by building" strong flush>
        <table className="tbl"><thead><tr><th>Site</th><th>Building</th><th className="r">Beds</th><th className="r">Occupied</th><th className="r">Occupancy</th></tr></thead><tbody>
          {s.buildings.filter(b => persona.sites === 'all' || persona.sites.includes(b.siteId)).map(b => {
            const beds = s.beds.filter(x => roomOf(s, x).buildingId === b.id && x.state !== 'Archived'); const o = beds.filter(x => x.state === 'Occupied').length
            return <tr key={b.id}><td>{s.sites.find(x => x.id === b.siteId)?.name}</td><td>{b.name}</td><td className="r tnum">{beds.length}</td><td className="r tnum">{o}</td><td className="r tnum">{((o / (beds.length || 1)) * 100).toFixed(0)}%</td></tr>
          })}</tbody></table>
      </GlassCard>
      <GlassCard title="Overdue stays" strong flush subtitle="Flagged from day 1, escalated to the Policy Approver after the grace period. Never auto-checked-out.">
        <table className="tbl"><thead><tr><th>Resident</th><th>Bed</th><th>Planned end</th><th>Status</th></tr></thead><tbody>
          {overdue.map(x => <tr key={x.id}><td>{staffById(s, x.staffId)?.name}</td><td className="mono">{bedById(s, x.bedId)?.code}</td><td className="tnum">{fmtDate(x.end!)}</td><td>{stayState(x, T, s.config) === 'escalated' ? <Badge tone="danger">Escalated</Badge> : <Status s="Overdue" />}</td></tr>)}
          {overdue.length === 0 && <tr><td colSpan={4}><div className="tbl-empty">None</div></td></tr>}</tbody></table>
      </GlassCard>
      {canOutage && <GlassCard title="Outage export" subtitle="Declared network outage only. Watermarked arrivals and departures snapshot. No offline bed allocation; reconcile after restoration." strong>
        <Button icon="download" onClick={outage}>Download snapshot</Button>
      </GlassCard>}
    </>
  )
}

/* ============ Audit log ============ */
export function AuditLog() {
  const { s, persona } = useCtx()
  const [q, setQ] = useState('')
  const rows = s.audit.filter(a => (a.action + a.detail + a.actor).toLowerCase().includes(q.toLowerCase())).slice(0, 80)
  return (
    <>
      <PageHeader crumbs={['Insight']} title="Audit log" summary="Append-only. No edits, no deletion. Every decision records actor, time, decision, reason and state." />
      <DataTable rowKey={a => a.id} rows={rows} toolbar={<label className="search" style={{ margin: 0, maxWidth: 320 }}><Icon name="search" /><input placeholder="Filter actions, people, beds" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter audit" /></label>}
        cols={[
          { key: 't', header: 'When', render: a => <span className="tnum">{fmtDateTime(a.at)}</span> },
          { key: 'a', header: 'Actor', render: a => a.actor },
          { key: 'x', header: 'Action', render: a => <Badge outline>{a.action}</Badge> },
          { key: 'd', header: 'Detail', render: a => <span className="muted">{a.detail}</span> },
        ]} footer={<span>{rows.length} entries shown{persona.role === 'Aud' ? ' · export available to Auditors' : ''}</span>} />
    </>
  )
}

/* ============ Configuration (Super Admin) ============ */
export function Settings() {
  const { s, persona } = useCtx()
  const act = useAct()
  const c = s.config
  const [v, setV] = useState({ waitlistDays: c.waitlistDays, offerHours: c.offerHours, emergencyDeadlineHours: c.emergencyDeadlineHours, slaBusinessDays: c.slaBusinessDays, noShowHours: c.noShowHours, extensionPolicyDays: c.extensionPolicyDays, overdueGraceDays: c.overdueGraceDays, sosAckMinutes: c.sosAckMinutes, maMin: c.minGradeBySite.MA ?? 1 })
  const num = (k: keyof typeof v, label: string, hint?: string) => <Field key={k} label={label} hint={hint}><Input type="number" min={1} value={v[k]} onChange={e => setV({ ...v, [k]: +e.target.value })} /></Field>
  const OPEN = ['Approver names per route; who holds Policy Approver (D-25)', 'Eligibility matrix: gender/grade rules, room types, exception approvers (GH-03)', 'Waitlist priority categories and renewal rule (GH-04, GH-05)', 'SMS for residents without email (D-09, D-52)', 'Future-dated exit and login (D-37)', 'Max provisional emergency duration, rejection SLA, night coverage (GH-07, GH-19, GH-20)', 'SOS recipients, acknowledgement SLA and fallback (GH-08)', 'Visitor policy (GH-10)', 'Key model for shared rooms (D-72)', 'Periodic inspections in Phase 1 (D-75)', 'Retention and legal check on “never delete” (GH-11)', 'Migration inputs: occupants, rooms/beds, file format, data owner (D-89)', 'Password and session policy values (GH-14)', 'Maintenance SLAs and KPIs (GH-16)', 'Facility booking in or out (GH-17)']
  return (
    <>
      <PageHeader crumbs={['Insight']} title="Configuration" summary="Every number below is configurable and never hardcoded in logic. Open items from Grand Hyatt use placeholders until answered." />
      <GlassCard strong title="Timers and thresholds" subtitle="Changes are audited">
        <div className="grid three">
          {num('waitlistDays', 'Waitlist entry validity (days)', 'Decided: 15')}{num('offerHours', 'Bed offer window (hours)', 'Decided: 48')}{num('emergencyDeadlineHours', 'Emergency decision deadline (hours)', 'Decided: 24, re-alert every 24h')}
          {num('slaBusinessDays', 'Routine SLA (business days)', 'Default: 2')}{num('noShowHours', 'No-show expiry (hours after ETA)', 'Default: 24')}{num('extensionPolicyDays', 'Extension policy limit (days)', 'Placeholder')}
          {num('overdueGraceDays', 'Overdue grace before escalation (days)', 'Default: 3')}{num('sosAckMinutes', 'SOS acknowledgement (minutes)', 'Default: 5')}{num('maMin', 'Marina Apartments minimum grade', 'Placeholder for GH-03')}
        </div>
        <div style={{ marginTop: 16 }}><Button variant="primary" onClick={() => act(A.updateConfig(persona, { waitlistDays: v.waitlistDays, offerHours: v.offerHours, emergencyDeadlineHours: v.emergencyDeadlineHours, slaBusinessDays: v.slaBusinessDays, noShowHours: v.noShowHours, extensionPolicyDays: v.extensionPolicyDays, overdueGraceDays: v.overdueGraceDays, sosAckMinutes: v.sosAckMinutes, minGradeBySite: { ...c.minGradeBySite, MA: v.maMin } }))}>Save configuration</Button></div>
      </GlassCard>
      <GlassCard strong title="Open for Grand Hyatt" subtitle="Built behind configuration or a marked placeholder">
        <ul className="list-plain">{OPEN.map(o => <li key={o}><Badge tone="warning">Open</Badge><span>{o}</span></li>)}</ul>
      </GlassCard>
    </>
  )
}
