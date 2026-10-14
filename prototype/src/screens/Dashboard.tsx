import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import {
  Alert, Badge, Blocked, Button, Countdown, DataTable, GlassCard, NeedsAction, OccupancyBar, PageHeader, Person, Status, StatTile, Tabs, Icon, Field, Input, Select, Textarea,
} from '../ui'
import { bedsInScope, myInbox, myStatus, occupancy, approvalInbox } from '../domain/select'
import { activeStayOfStaff, bedById, resStatusView, roomOf, staffById, stayState, bedPath } from '../domain/rules'
import { fmtDate, fmtDateTime, fmtTime, greeting, today, addDays, dateStr, HOUR } from '../domain/time'
import { ROLE_LABEL } from '../roles'
import { CheckInModal } from './Allocations'
import { ResidentHome } from './ResidentHome'

export function Dashboard() {
  const { persona } = useCtx()
  switch (persona.role) {
    case 'Res': return <ResidentHome />
    case 'AA': case 'SA': return <AdminHome />
    case 'Rec': return <ReceptionHome />
    case 'MC': return <MaintenanceHome />
    case 'Tech': case 'Vend': return <JobsHome />
    case 'Sec': return <SecurityHome />
    case 'Mgr': return <ManagerHome />
    case 'Aud': return <AuditorHome />
  }
}

const firstName = (n: string) => n.split(' ')[0]
const eyebrow = (role: string, now: number) => `${role} · ${fmtDate(now).replace(/^\w+ /, m => m)}`.toUpperCase()

function usePulse() {
  const c = useCtx()
  const beds = bedsInScope(c.s, c.persona, c.scope)
  const occ = occupancy(c.s, beds)
  const T = today(c.now)
  const inScopeBed = (id: string) => beds.some(b => b.id === id)
  const arrivals = c.s.reservations.filter(r => r.status === 'Reserved' && r.from <= T && inScopeBed(r.bedId))
  const checkedInToday = c.s.stays.filter(st => st.start === T && st.source === 'Standard' && inScopeBed(st.bedId))
  const departures = c.s.stays.filter(st => st.status === 'Active' && inScopeBed(st.bedId) && (st.end === T || st.checkoutRequested || st.exitPending))
  const overdue = c.s.stays.filter(st => st.status === 'Active' && inScopeBed(st.bedId) && ['overdue', 'escalated'].includes(stayState(st, T, c.s.config)))
  return { ...c, beds, occ, T, arrivals, checkedInToday, departures, overdue, inScopeBed }
}

/* ============ Accommodation Admin / Super Admin ============ */
function AdminHome() {
  const p = usePulse()
  const { s, persona, now, go, occ } = p
  const inbox = myInbox(s, persona, now)
  const unverified = s.staff.filter(x => !x.verified && x.status === 'Active')
  const noBedReq = s.requests.filter(r => r.status === 'Submitted')
  const blocked7 = p.beds.filter(b => (b.state === 'Blocked') && b.since && now - b.since > 7 * 24 * HOUR)
  const notReadyArrivals = p.arrivals.filter(r => bedById(s, r.bedId)?.state !== 'Available')
  const items = [
    { key: 'ov', icon: 'clock' as const, tone: 'danger' as const, title: 'Overstays', meta: 'Past planned end date. Never auto-checked out', count: p.overdue.length, badge: p.overdue.length ? <Badge tone="danger">Urgent</Badge> : undefined, onClick: () => go('allocations', { tab: 'stays', f: 'overdue' }) },
    { key: 'em', icon: 'siren' as const, tone: 'danger' as const, title: 'Emergency check-ins', meta: 'Provisional stays waiting for a decision', count: s.emergencies.filter(e => e.status === 'Pending').length, onClick: () => go('emergency') },
    { key: 'ap', icon: 'checkCircle' as const, tone: 'brand' as const, title: 'Approvals waiting on you', meta: 'Requests, transfers, extensions', count: inbox.length, onClick: () => go('approvals') },
    { key: 'nr', icon: 'brush' as const, tone: 'warning' as const, title: 'Arrivals whose bed isn’t ready', meta: 'Cleaning or inspection blocks check-in', count: notReadyArrivals.length, onClick: () => go('housekeeping') },
    { key: 'uv', icon: 'userCog' as const, tone: 'warning' as const, title: 'Unverified staff profiles', meta: 'Added by Reception or CSV', count: unverified.length, onClick: () => go('staff', { f: 'unverified' }) },
    { key: 'wl', icon: 'hourglass' as const, tone: 'info' as const, title: 'Offers not viewed in 24h', meta: 'Reception to follow up in person', count: s.offers.filter(o => o.status === 'Pending' && o.followUp).length, onClick: () => go('waitlist') },
    { key: 'nb', icon: 'login' as const, tone: 'info' as const, title: 'Open requests', meta: 'Awaiting a bed decision', count: noBedReq.length, onClick: () => go('approvals') },
  ]
  return (
    <>
      <PageHeader display eyebrow={eyebrow(ROLE_LABEL[persona.role], now)} title={`${greeting(now)}, ${firstName(persona.name)}`} summary={`${items.reduce((n, i) => n + (i.key === 'nb' ? 0 : i.count), 0)} items need you today · ${p.arrivals.length + p.checkedInToday.length} arrivals · ${p.departures.length} departures`}
        actions={<>
          <Button icon="download" onClick={() => go('reports')}>Export</Button>
          <Button icon="userPlus" onClick={() => go('staff', { add: '1' })}>Add staff</Button>
          <Button variant="primary" icon="plus" onClick={() => go('allocations', { bulk: '1' })}>Allocate bed</Button>
        </>} />
      <div className="grid stats">
        <StatTile label="Occupancy" value={((occ.occupied / (occ.total || 1)) * 100).toFixed(1)} unit="%" spark={[88, 89.5, 90, 89, 91, 90.4, (occ.occupied / (occ.total || 1)) * 100]} delta={{ text: '2.1 pts', trend: 'up' }} hint="vs last month" onClick={() => go('inventory')} />
        <StatTile label="Arrivals today" value={p.arrivals.length + p.checkedInToday.length} icon="login" hint={`${notReadyArrivals.length} not ready`} onClick={() => go('allocations')} />
        <StatTile label="Pending approvals" value={inbox.length} spark={[3, 5, 4, 6, 5, 7, inbox.length]} delta={{ text: '2', trend: 'up', good: false }} hint="vs yesterday" onClick={() => go('approvals')} goodUp={false} />
        <StatTile label="Waitlist" value={s.waitlist.filter(w => w.status !== 'Closed').length} spark={[12, 11, 12, 10, 9, 9, s.waitlist.filter(w => w.status !== 'Closed').length]} delta={{ text: '3', trend: 'down' }} hint="joiners waiting" onClick={() => go('waitlist')} />
      </div>
      <div className="grid two">
        <NeedsAction items={items} onViewAll={() => go('approvals')} />
        <div className="stack">
          <GlassCard title="Occupancy" subtitle={persona.sites === 'all' ? 'All sites' : `${p.scope === 'all' ? 'Assigned sites' : s.sites.find(x => x.id === p.scope)?.name}`} actions={<Button variant="ghost" size="sm" onClick={() => go('inventory')}>Site tree<Icon name="chevronRight" /></Button>}>
            <OccupancyBar {...occ} scope={p.scope === 'all' ? 'All sites' : s.sites.find(x => x.id === p.scope)?.name ?? ''} />
          </GlassCard>
          <GlassCard title="Watchlist">
            <div className="stack" style={{ gap: 8 }}>
              {blocked7.length > 0 && <Alert tone="warning" title={`${blocked7.length} beds blocked over 7 days`} detail="Waiting on repairs. Review with Maintenance." />}
              {s.stays.filter(st => st.status === 'Active' && st.end && st.end <= addDays(p.T, 7) && st.end >= p.T).length > 0 && <Alert tone="info" title={`${s.stays.filter(st => st.status === 'Active' && st.end && st.end <= addDays(p.T, 7) && st.end >= p.T).length} stays end this week`} detail="Extend or schedule checkout." action={<Button size="sm" onClick={() => go('allocations', { tab: 'stays', f: 'ending' })}>Review</Button>} />}
              {s.stays.some(st => st.endPending) && <Alert tone="info" title="Stays need an end date" detail="Migrated or emergency stays: assign within 30 days." action={<Button size="sm" onClick={() => go('allocations', { tab: 'stays', f: 'pending' })}>Review</Button>} />}
            </div>
          </GlassCard>
        </div>
      </div>
      <Movements />
    </>
  )
}

export function Movements() {
  const p = usePulse()
  const { s, go, T, now } = p
  const act = useAct()
  const [tab, setTab] = useState<'arrivals' | 'departures' | 'transfers'>('arrivals')
  const [q, setQ] = useState('')
  const [checkIn, setCheckIn] = useState<string | null>(null)
  const arrivals = [
    ...p.checkedInToday.map(st => ({ id: st.id, staffId: st.staffId, bedId: st.bedId, type: st.stayType, eta: Date.parse(st.start + 'T00:00:00Z'), status: 'Checked in', resId: undefined as string | undefined })),
    ...p.arrivals.map(r => ({ id: r.id, staffId: r.staffId, bedId: r.bedId, type: r.stayType, eta: r.eta, status: resStatusView(r, now, bedById(s, r.bedId)), resId: r.id })),
  ]
  const transfers = s.transfers.filter(t => t.status === 'Approved' || t.status === 'Executed')
  const filt = (name: string) => name.toLowerCase().includes(q.toLowerCase())
  const search = <><label className="search" style={{ margin: 0, maxWidth: 280 }}><Icon name="search" /><input placeholder="Search residents or beds" value={q} onChange={e => setQ(e.target.value)} aria-label="Search residents or beds" /></label><span className="spacer" /><Button icon="download" onClick={() => go('reports')}>Export</Button></>
  return (
    <>
      <GlassCard strong title="Today’s movements" subtitle={`${arrivals.length} arrivals · ${p.departures.length} departures · ${transfers.length} transfers`} actions={<Tabs value={tab} onChange={setTab} options={[{ id: 'arrivals', label: 'Arrivals', count: arrivals.length }, { id: 'departures', label: 'Departures', count: p.departures.length }, { id: 'transfers', label: 'Transfers', count: transfers.length }]} />} flush>
        <div style={{ paddingTop: 4 }}>
          {tab === 'arrivals' && <DataTable cols={[
            { key: 'r', header: 'Resident', render: r => { const st = staffById(s, r.staffId)!; return <Person name={st.name} sub={st.dept} /> } },
            { key: 'b', header: 'Bed', render: r => <span className="mono">{bedById(s, r.bedId)?.code}</span> },
            { key: 't', header: 'Stay type', render: r => <Badge outline>{r.type}</Badge> },
            { key: 'e', header: 'ETA', align: 'r', render: r => <span className="tnum">{fmtTime(r.eta)}</span> },
            { key: 's', header: 'Status', render: r => <Status s={r.status} /> },
            { key: 'a', header: '', align: 'r', render: r => r.resId && r.status === 'Expected' ? <Button variant="primary" size="sm" onClick={() => setCheckIn(r.resId!)}>Check in</Button> : r.resId ? <Button size="sm" variant="ghost" onClick={() => setCheckIn(r.resId!)}>Open</Button> : null },
          ]} rows={arrivals.filter(r => filt(staffById(s, r.staffId)!.name) || filt(bedById(s, r.bedId)!.code))} rowKey={r => r.id} toolbar={search} />}
          {tab === 'departures' && <DataTable cols={[
            { key: 'r', header: 'Resident', render: st => { const x = staffById(s, st.staffId)!; return <Person name={x.name} sub={x.dept} /> } },
            { key: 'b', header: 'Bed', render: st => <span className="mono">{bedById(s, st.bedId)?.code}</span> },
            { key: 'w', header: 'Why', render: st => st.exitPending ? <Badge tone="neutral">Left organisation</Badge> : st.checkoutRequested ? <Badge tone="warning">Voluntary checkout</Badge> : <Badge tone="warning">Planned end</Badge> },
            { key: 'a', header: '', align: 'r', render: st => <Button size="sm" variant="primary" onClick={() => go('exits', { stay: st.id })}>Process checkout</Button> },
          ]} rows={p.departures} rowKey={st => st.id} toolbar={search} empty="No departures today" />}
          {tab === 'transfers' && <DataTable cols={[
            { key: 'r', header: 'Resident', render: t => { const st = s.stays.find(x => x.id === t.stayId)!; return <Person name={staffById(s, st.staffId)!.name} sub={t.kind} /> } },
            { key: 'b', header: 'Move', render: t => t.kind === 'Swap' ? <span className="mono">swap</span> : <span className="mono">{bedById(s, s.stays.find(x => x.id === t.stayId)!.bedId)?.code} → {bedById(s, t.destBedId)?.code}</span> },
            { key: 's', header: 'Status', render: t => <Status s={t.status} /> },
            { key: 'a', header: '', align: 'r', render: t => t.status === 'Approved' ? <Button size="sm" variant="primary" onClick={() => go('transfers')}>Execute</Button> : null },
          ]} rows={transfers} rowKey={t => t.id} toolbar={search} empty="No transfers today" />}
        </div>
      </GlassCard>
      {checkIn && <CheckInModal reservationId={checkIn} onClose={() => setCheckIn(null)} />}
    </>
  )
}

/* ============ Reception ============ */
function ReceptionHome() {
  const p = usePulse()
  const { s, persona, now, go } = p
  const act = useAct()
  const followUps = s.offers.filter(o => o.status === 'Pending' && !o.deliveredAt)
  const checkoutReq = s.stays.filter(st => st.status === 'Active' && st.checkoutRequested)
  const cleaning = s.cleaning.filter(t => t.status === 'Open' && !t.assignedTo)
  const approvedTransfers = s.transfers.filter(t => t.status === 'Approved')
  const inspections = s.beds.filter(b => b.state === 'InspectionRequired')
  const noShow = p.arrivals.filter(r => resStatusView(r, now) === 'No-show')
  const items = [
    { key: 'ci', icon: 'login' as const, tone: 'brand' as const, title: 'Arrivals to check in', meta: 'Reserved for today', count: p.arrivals.length, onClick: () => go('allocations') },
    { key: 'ns', icon: 'alert' as const, tone: 'danger' as const, title: 'No-shows', meta: 'ETA passed. Reservation expires 24h later', count: noShow.length, onClick: () => go('allocations') },
    { key: 'of', icon: 'phone' as const, tone: 'warning' as const, title: 'Offers to deliver in person', meta: 'Resident hasn’t viewed the offer', count: followUps.length, onClick: () => go('waitlist') },
    { key: 'co', icon: 'exit' as const, tone: 'warning' as const, title: 'Checkout requests', meta: 'Acknowledge within 1 business day', count: checkoutReq.length, onClick: () => go('exits') },
    { key: 'tr', icon: 'swap' as const, tone: 'info' as const, title: 'Approved transfers to execute', meta: 'Atomic: failure leaves residents in place', count: approvedTransfers.length, onClick: () => go('transfers') },
    { key: 'cl', icon: 'brush' as const, tone: 'info' as const, title: 'Cleaning to assign', meta: 'Beds waiting for housekeeping', count: cleaning.length, onClick: () => go('housekeeping') },
    { key: 'in', icon: 'shield' as const, tone: 'info' as const, title: 'Final inspections', meta: 'Bed isn’t Available until inspected', count: inspections.length, onClick: () => go('housekeeping') },
  ]
  return (
    <>
      <PageHeader display eyebrow={eyebrow(ROLE_LABEL[persona.role], now)} title={`${greeting(now)}, ${firstName(persona.name)}`} summary={`${p.arrivals.length} arrivals to process · ${p.departures.length} departures`}
        actions={<><Button icon="siren" onClick={() => go('emergency')}>Emergency check-in</Button><Button variant="primary" icon="plus" onClick={() => go('approvals')}>Submit request for staff</Button></>} />
      <div className="grid stats">
        <StatTile label="Arrivals today" value={p.arrivals.length + p.checkedInToday.length} icon="login" hint={`${p.checkedInToday.length} checked in`} />
        <StatTile label="Departures" value={p.departures.length} icon="exit" hint="today and pending" />
        <StatTile label="Beds ready now" value={p.beds.filter(b => b.state === 'Available').length} icon="bed" hint="Available, inspected" />
        <StatTile label="Not ready" value={p.beds.filter(b => ['NeedsCleaning', 'InspectionRequired'].includes(b.state)).length} icon="brush" hint="cleaning or inspection" />
      </div>
      <div className="grid two"><NeedsAction items={items} /><GlassCard title="Occupancy"><OccupancyBar {...p.occ} scope="Your sites" /></GlassCard></div>
      <Movements />
    </>
  )
}

/* ============ Maintenance Coordinator ============ */
function MaintenanceHome() {
  const { s, persona, now, go } = useCtx()
  const open = s.workOrders.filter(w => w.status === 'Open'), prog = s.workOrders.filter(w => w.status === 'In progress'), res = s.workOrders.filter(w => w.status === 'Resolved')
  const blocked = s.beds.filter(b => b.state === 'Blocked' || b.state === 'UnderMaintenance')
  return (
    <>
      <PageHeader display eyebrow={eyebrow(ROLE_LABEL[persona.role], now)} title={`${greeting(now)}, ${firstName(persona.name)}`} summary={`${open.length} to triage · ${res.length} waiting for your verification`} />
      <div className="grid stats">
        <StatTile label="To triage" value={open.length} icon="wrench" hint="target: 1 business day" goodUp={false} />
        <StatTile label="In progress" value={prog.length} icon="clock" />
        <StatTile label="Resolved, not verified" value={res.length} icon="checkCircle" hint="Resolved ≠ Verified" />
        <StatTile label="Beds out of service" value={blocked.length} icon="ban" hint="blocked or maintenance" />
      </div>
      <div className="grid two">
        <NeedsAction items={[
          { key: 'v', icon: 'checkCircle', tone: 'brand', title: 'Work to verify', meta: 'Independent verification before the room is ready', count: res.length, onClick: () => go('approvals') },
          { key: 't', icon: 'wrench', tone: 'warning', title: 'New work orders to triage', meta: 'Assign a technician or contractor', count: open.length, onClick: () => go('maintenance') },
          { key: 'b', icon: 'ban', tone: 'info', title: 'Blocked beds', meta: 'Unblock when work is verified', count: blocked.length, onClick: () => go('inventory') },
        ]} />
        <GlassCard title="Out of service"><ul className="list-plain">{blocked.slice(0, 6).map(b => <li key={b.id}><span className="mono">{b.code}</span><span className="muted body-sm" style={{ flex: 1 }}>{b.reason}</span><Status s={b.state} /></li>)}</ul></GlassCard>
      </div>
    </>
  )
}

/* ============ Technician / Contractor ============ */
function JobsHome() {
  const { s, persona, now, go } = useCtx()
  const act = useAct()
  const mine = s.workOrders.filter(w => persona.role === 'Vend' ? w.assignee === persona.vendor : (w.assignee === persona.staffId || !w.assignee) && w.status !== 'Verified')
  return (
    <>
      <PageHeader display eyebrow={eyebrow(ROLE_LABEL[persona.role], now)} title={`${greeting(now)}, ${firstName(persona.name)}`} summary={persona.role === 'Vend' ? 'Your assigned jobs only. Valid within your contract, documents and visit window.' : 'Your assigned work orders'} />
      <GlassCard title="Assigned jobs" strong flush>
        {mine.length === 0 && <div className="tbl-empty">No jobs assigned</div>}
        {mine.map(w => (
          <div key={w.id} className="approval-card" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="row"><b>{w.title}</b><span className="spacer" /><Status s={w.status} /></div>
            <div className="muted body-sm">{bedPath(s, bedById(s, w.bedId)!)}</div>
            <div className="row wrap">
              {w.status === 'Open' && <Button size="sm" onClick={() => act(A.advanceWorkOrder(persona, w.id, 'In progress', persona.vendor ?? persona.staffId))}>Accept job</Button>}
              {w.status === 'In progress' && <Button size="sm" variant="primary" onClick={() => act(A.advanceWorkOrder(persona, w.id, 'Resolved'))}>Submit for verification</Button>}
              {w.status === 'Resolved' && <Badge tone="info">Awaiting independent verification</Badge>}
            </div>
          </div>
        ))}
      </GlassCard>
      <Alert tone="info" title="Scope" detail="No access to staff eligibility or accommodation administration." />
    </>
  )
}

/* ============ Security ============ */
function SecurityHome() {
  const { s, persona, now, go } = useCtx()
  const act = useAct()
  const T = today(now)
  const sos = s.incidents.filter(i => !i.closed)
  const arrivals = s.reservations.filter(r => r.status === 'Reserved' && r.from <= T)
  return (
    <>
      <PageHeader display eyebrow={eyebrow(ROLE_LABEL[persona.role], now)} title={`${greeting(now)}, ${firstName(persona.name)}`} summary="Identity-check data only: name, photo, room. Never eligibility data." />
      <div className="grid stats">
        <StatTile label="Open SOS / incidents" value={sos.length} icon="siren" goodUp={false} hint={`acknowledge within ${s.config.sosAckMinutes} min`} onClick={() => go('incidents')} />
        <StatTile label="Expected arrivals" value={arrivals.length} icon="login" hint="for gate verification" />
        <StatTile label="Keys out of hours" value={s.keys.filter(k => k.status === 'Issued').length} icon="key" hint="Night Keys capability" onClick={() => go('keys')} />
        <StatTile label="Contractors on site" value={1} icon="truck" hint="CoolAir Services · 09:00–17:00" />
      </div>
      <div className="grid two">
        <GlassCard title="Open incidents" strong flush>
          {sos.length === 0 && <div className="tbl-empty">No open incidents</div>}
          {sos.map(i => <div key={i.id} className="approval-card" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="row"><Badge tone={i.kind === 'SOS' ? 'danger' : 'warning'}>{i.kind}</Badge><b>{i.text}</b></div>
            <div className="row">{i.ackAt ? <Badge tone="success">Acknowledged</Badge> : <Countdown to={i.at + s.config.sosAckMinutes * 60000} label="to acknowledge" warnBelowMs={120000} />}<span className="spacer" />
              {!i.ackAt && <Button size="sm" variant="primary" onClick={() => act(A.ackIncident(persona, i.id))}>Acknowledge</Button>}
              {i.ackAt && <Button size="sm" onClick={() => act(A.closeIncident(persona, i.id))}>Close</Button>}</div>
          </div>)}
        </GlassCard>
        <GlassCard title="Identity check: today’s arrivals" strong flush>
          <ul className="list-plain" style={{ padding: '0 20px 12px' }}>{arrivals.map(r => { const st = staffById(s, r.staffId)!, b = bedById(s, r.bedId)!; return <li key={r.id}><Person name={st.name} sub={`Room ${roomOf(s, b).name}`} /><span className="spacer" /><Badge outline>Photo on file</Badge></li> })}</ul>
        </GlassCard>
      </div>
    </>
  )
}

/* ============ Read-only Manager / Auditor ============ */
function ManagerHome() {
  const p = usePulse()
  const { s, persona, now, go } = p
  return (
    <>
      <PageHeader display eyebrow={eyebrow(ROLE_LABEL[persona.role], now)} title={`${greeting(now)}, ${firstName(persona.name)}`} summary="Operational summary. No create, edit or approval rights; export only if granted." />
      <div className="grid stats">
        <StatTile label="Occupancy" value={((p.occ.occupied / p.occ.total) * 100).toFixed(1)} unit="%" spark={[88, 89.5, 90, 89, 91, 90.4, (p.occ.occupied / p.occ.total) * 100]} />
        <StatTile label="Vacant and ready" value={p.beds.filter(b => b.state === 'Available').length} icon="bed" />
        <StatTile label="Waitlist" value={s.waitlist.filter(w => w.status !== 'Closed').length} icon="hourglass" />
        <StatTile label="Overdue stays" value={p.overdue.length} icon="clock" goodUp={false} />
      </div>
      <div className="grid even">
        <GlassCard title="Occupancy by site">{s.sites.map(site => <div key={site.id} style={{ marginBottom: 16 }}><OccupancyBar {...occupancy(s, bedsInScope(s, persona, site.id))} scope={site.name} /></div>)}</GlassCard>
        <GlassCard title="Reports"><p className="muted">Occupancy, arrivals and departures, overdue stays, maintenance turnaround.</p><div style={{ marginTop: 12 }}><Button onClick={() => go('reports')}>Open reports</Button></div></GlassCard>
      </div>
    </>
  )
}
function AuditorHome() {
  const { s, persona, now, go } = useCtx()
  return (
    <>
      <PageHeader display eyebrow={eyebrow(ROLE_LABEL[persona.role], now)} title={`${greeting(now)}, ${firstName(persona.name)}`} summary="Read-only: immutable audit log and authorised history." />
      <div className="grid stats">
        <StatTile label="Audit entries" value={s.audit.length} icon="scroll" onClick={() => go('audit')} />
        <StatTile label="Overrides and exceptions" value={s.audit.filter(a => /exception|waiver|override/i.test(a.action)).length} icon="shield" />
        <StatTile label="Permission changes" value={s.audit.filter(a => /Delegation|Configuration/i.test(a.action)).length} icon="userCog" />
        <StatTile label="Self-approval attempts blocked" value={0} icon="ban" hint="enforced in the API" />
      </div>
      <GlassCard title="Latest activity" flush strong>
        <ul className="list-plain" style={{ padding: '0 20px 12px' }}>{s.audit.slice(0, 8).map(a => <li key={a.id}><div style={{ flex: 1 }}><b style={{ fontWeight: 500 }}>{a.action}</b><div className="muted body-sm">{a.detail}</div></div><div className="subtle body-sm" style={{ textAlign: 'right' }}>{a.actor}<br />{fmtDateTime(a.at)}</div></li>)}</ul>
      </GlassCard>
    </>
  )
}
