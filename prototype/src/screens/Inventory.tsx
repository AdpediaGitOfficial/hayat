import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Drawer, Field, GlassCard, Icon, Input, Modal, OccupancyBar, PageHeader, Select, Status, Tabs, Textarea } from '../ui'
import { bedsInScope, occupancy, visibleSites } from '../domain/select'
import { activeStayOfBed, bedById, bedPath, buildingOf, can, roomOf, staffById } from '../domain/rules'
import { flaggedStays } from '../domain/ext/structures'
import { fmtDate, fmtDateTime, today } from '../domain/time'
import type { Bed, State } from '../domain/types'

const bedClass = (s: State, b: Bed) => {
  if (b.state === 'Occupied') return 'occupied'
  if (['Blocked', 'UnderMaintenance', 'NeedsCleaning', 'InspectionRequired', 'Archived'].includes(b.state)) return 'blocked'
  if (b.heldBy || s.reservations.some(r => r.bedId === b.id && r.status === 'Reserved')) return 'reserved'
  return 'available'
}
const STATE_LABEL: Record<string, string> = { NeedsCleaning: 'Needs cleaning', InspectionRequired: 'Inspection required', UnderMaintenance: 'Under maintenance' }

export function Inventory() {
  const { s, persona, params } = useCtx()
  const sites = visibleSites(s, persona)
  const [siteId, setSiteId] = useState(params.site ?? sites[0]?.id ?? '')
  const [filter, setFilter] = useState<'all' | 'occupied' | 'reserved' | 'available' | 'blocked'>('all')
  const [sel, setSel] = useState<string | null>(null)
  const [add, setAdd] = useState<null | 'room' | 'building' | 'site'>(null)
  const site = s.sites.find(x => x.id === siteId) ?? sites[0]
  if (!site) return <GlassCard title="No sites in your scope" subtitle="Only a Super Admin can change site scope." />
  const beds = bedsInScope(s, persona, site.id)
  const occ = occupancy(s, beds)
  const blds = s.buildings.filter(b => b.siteId === site.id)
  const groups: { key: string; id?: string; blocked?: { reason: string }; title: string; subtitle?: string; rooms: typeof s.rooms }[] = []
  if (blds.length === 0) groups.push({ key: 'site', title: site.name, subtitle: 'Site › Room › Bed (no building level)', rooms: s.rooms.filter(r => r.siteId === site.id && !r.archived) })
  else blds.filter(b => !b.archived).forEach(b => groups.push({ key: b.id, id: b.id, blocked: b.blocked, title: b.name, rooms: s.rooms.filter(r => r.buildingId === b.id && !r.archived) }))
  const flagged = flaggedStays(s).filter(st => bedById(s, st.bedId)!.siteId === site.id)
  const canAddRoom = can(persona, 'bed.manage'), canAddBld = can(persona, 'building.create'), canStruct = can(persona, 'structure.block')
  const act = useAct()
  const matches = (b: Bed) => filter === 'all' || bedClass(s, b) === filter

  return (
    <>
      <PageHeader crumbs={['Accommodation', site.name]} title="Sites and rooms" summary={`${beds.length} beds · the bed is the unit of occupancy; room, building and site figures are roll-ups`}
        actions={<>
          {persona.role === 'SA' && <Button icon="plus" onClick={() => setAdd('site')}>Add site</Button>}
          {canAddBld && <Button icon="building" onClick={() => setAdd('building')}>Add building</Button>}
          {canAddRoom && <Button variant="primary" icon="plus" onClick={() => setAdd('room')}>Add room</Button>}
        </>} />
      {flagged.length > 0 && <Alert tone="warning" title={`${flagged.length} resident${flagged.length > 1 ? 's' : ''} live in a blocked room or building`} detail="They are flagged for you to move or confirm. Nobody is moved automatically." />}
      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
        <Tabs value={site.id} onChange={setSiteId} options={sites.map(x => ({ id: x.id, label: x.name, count: bedsInScope(s, persona, x.id).length }))} />
        <Tabs value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All' }, { id: 'occupied', label: 'Occupied', count: occ.occupied }, { id: 'reserved', label: 'Reserved', count: occ.reserved }, { id: 'available', label: 'Available', count: occ.available }, { id: 'blocked', label: 'Blocked / not ready', count: occ.blocked }]} />
      </div>
      <div className="grid two" style={{ gridTemplateColumns: '1fr 320px' }}>
        <div className="stack">
          {groups.map(g => (
            <GlassCard key={g.key} title={<span className="row">{g.title}{g.blocked && <Badge tone="warning">Blocked: {g.blocked.reason}</Badge>}</span>} subtitle={g.subtitle ?? `${g.rooms.length} rooms`} strong
              actions={g.id && canStruct ? <><Button size="sm" onClick={() => act(g.blocked ? A.unblockStructure(persona, { kind: 'building', id: g.id! }) : A.blockStructure(persona, { kind: 'building', id: g.id!, reason: 'Blocked for survey' }))}>{g.blocked ? 'Unblock' : 'Block'}</Button><Button size="sm" variant="danger" onClick={() => act(A.archiveBuilding(persona, g.id!))}>Archive</Button></> : undefined}>
              <div className="stack">
                {g.rooms.map(r => {
                  const rb = s.beds.filter(b => b.roomId === r.id && b.state !== 'Archived').filter(matches)
                  if (rb.length === 0 && filter !== 'all') return null
                  return (
                    <div key={r.id} className="room-block">
                      <h3>{r.floor && <span className="subtle" style={{ fontWeight: 400 }}>{r.floor} ·</span>} {r.name}<Badge outline>{r.gender === 'Any' ? 'Any gender' : r.gender}</Badge>{r.blocked && <Badge tone="warning">Blocked</Badge>}<span className="spacer" />{canStruct && <><Button size="sm" variant="ghost" onClick={() => act(r.blocked ? A.unblockStructure(persona, { kind: 'room', id: r.id }) : A.blockStructure(persona, { kind: 'room', id: r.id, reason: 'Room blocked' }))}>{r.blocked ? 'Unblock' : 'Block'}</Button><Button size="sm" variant="ghost" onClick={() => act(A.archiveRoom(persona, r.id))}>Archive</Button></>}</h3>
                      <div className="bed-grid">
                        {rb.map(b => {
                          const stay = activeStayOfBed(s, b.id)
                          const res = s.reservations.find(x => x.bedId === b.id && x.status === 'Reserved')
                          const sub = stay ? staffById(s, stay.staffId)?.name : b.heldBy ? 'Held by offer' : b.state !== 'Available' ? STATE_LABEL[b.state] ?? b.state : res ? `Reserved ${fmtDate(res.from)}` : 'Available'
                          return (
                            <button key={b.id} className={`bed ${bedClass(s, b)} ${sel === b.id ? 'sel' : ''}`} onClick={() => setSel(b.id)}>
                              <span className="code">{b.code}</span>
                              <span className="sub">{sub}</span>
                              {(stay && res || b.state !== 'Available' && b.state !== 'Occupied' && res) && <span className="sub" style={{ color: 'var(--champagne)' }}>+ reserved {fmtDate(res!.from)}</span>}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </GlassCard>
          ))}
        </div>
        <div className="stack" style={{ alignSelf: 'start', position: 'sticky', top: 90 }}>
          <GlassCard title={site.name}><OccupancyBar {...occ} scope={site.kind} /></GlassCard>
          <GlassCard title="How to read this"><p className="muted body-sm">Each bed shows its <b>physical state</b>. Reservations are date-ranged and sit alongside it: a bed can be Available today and reserved from next week. Readiness gates check-in, not future reservations.</p></GlassCard>
        </div>
      </div>
      {sel && <BedDrawer bedId={sel} onClose={() => setSel(null)} />}
      {add && <AddModal kind={add} siteId={site.id} onClose={() => setAdd(null)} />}
    </>
  )
}

function BedDrawer({ bedId, onClose }: { bedId: string; onClose: () => void }) {
  const { s, persona, now } = useCtx()
  const act = useAct()
  const bed = bedById(s, bedId)!
  const stay = activeStayOfBed(s, bed.id)
  const res = s.reservations.filter(r => r.bedId === bed.id && r.status === 'Reserved')
  const wos = s.workOrders.filter(w => w.bedId === bed.id)
  const offer = bed.heldBy ? s.offers.find(o => o.id === bed.heldBy) : undefined
  const [reason, setReason] = useState('')
  const [from, setFrom] = useState(''), [to, setTo] = useState('')
  const room = roomOf(s, bed)
  return (
    <Drawer open onClose={onClose} title={bed.code} subtitle={bedPath(s, bed)}
      footer={<>
        {bed.state === 'Blocked' || bed.state === 'UnderMaintenance' ? <Button onClick={() => act(A.unblockBed(persona, bed.id))}>Unblock bed</Button> : <Button onClick={() => act(A.blockBed(persona, bed.id, reason, { from: from || undefined, to: to || undefined }))}>{from && from > today(now) ? 'Schedule block' : 'Block bed'}</Button>}
        <Button variant="danger" onClick={() => act(A.archiveBed(persona, bed.id), onClose)}>Archive bed</Button>
      </>}>
      <div className="row"><Status s={bed.state} />{bed.heldBy && <Badge tone="brand">Held by offer</Badge>}<Badge outline>{room.gender === 'Any' ? 'Any gender' : room.gender + ' room'}</Badge></div>
      {bed.state === 'NeedsCleaning' && <Blocked why="Vacant · needs cleaning" owner="Housekeeping" next="Assign cleaning, then final inspection" />}
      {bed.state === 'InspectionRequired' && <Blocked why="Vacant · awaiting final inspection" owner="Final Inspection holder" next="Inspect to make the bed Available" />}
      {(bed.state === 'Blocked' || bed.state === 'UnderMaintenance') && <Blocked why={`${STATE_LABEL[bed.state] ?? bed.state}: ${bed.reason ?? ''}`} owner="Maintenance Coordinator" next="Verify the work, then unblock" />}
      <section><h3>Current stay</h3>
        {stay ? <dl className="kv" style={{ marginTop: 8 }}><dt>Resident</dt><dd>{staffById(s, stay.staffId)?.name}</dd><dt>Since</dt><dd>{fmtDate(stay.start)}</dd><dt>Planned end</dt><dd>{stay.end ? fmtDate(stay.end) : 'End date pending'}</dd><dt>Source</dt><dd>{stay.source}</dd></dl> : <p className="muted">Nobody is staying here.</p>}
      </section>
      <section><h3>Reservations (date-ranged)</h3>
        {res.length === 0 ? <p className="muted">No upcoming reservations.</p> : <ul className="list-plain">{res.map(r => <li key={r.id}><span style={{ flex: 1 }}>{staffById(s, r.staffId)?.name}</span><span className="muted body-sm">{fmtDate(r.from)} → {r.to ? fmtDate(r.to) : 'open'}</span></li>)}</ul>}
        {offer && <p className="muted body-sm" style={{ marginTop: 8 }}>Held for {staffById(s, offer.staffId)?.name} until the offer resolves.</p>}
      </section>
      {wos.length > 0 && <section><h3>Work orders</h3><ul className="list-plain">{wos.map(w => <li key={w.id}><span style={{ flex: 1 }}>{w.title}</span><Status s={w.status} /></li>)}</ul></section>}
      {(bed.blocks ?? []).length > 0 && <section><h3>Blocks (date-ranged)</h3><ul className="list-plain">{bed.blocks!.map(k => <li key={k.id}><span style={{ flex: 1 }}>{k.reason}</span><span className="muted body-sm">{fmtDate(k.from)} → {k.to ? fmtDate(k.to) : 'further notice'}</span></li>)}</ul></section>}
      <Field label="Reason to block" hint="Required when blocking. Blocking never moves an occupant: they’re flagged for the admin." optional><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <div className="grid even"><Field label="From" hint="Leave empty to start today" optional><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="Until" hint="Leave empty for further notice" optional><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field></div>
    </Drawer>
  )
}

function AddModal({ kind, siteId, onClose }: { kind: 'room' | 'building' | 'site'; siteId: string; onClose: () => void }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const [name, setName] = useState('')
  const [gender, setGender] = useState<'Male' | 'Female' | 'Any'>('Any')
  const [beds, setBeds] = useState(2)
  const [bld, setBld] = useState('')
  const [skind, setSkind] = useState<'Villa' | 'Apartment'>('Villa')
  const blds = s.buildings.filter(b => b.siteId === siteId)
  const submit = () => kind === 'room' ? act(A.addRoom(persona, { siteId, buildingId: bld || undefined, name, gender, beds }), onClose)
    : kind === 'building' ? act(A.addBuilding(persona, { siteId, name }), onClose) : act(A.addSite(persona, { name, kind: skind }), onClose)
  return (
    <Modal open onClose={onClose} title={kind === 'room' ? 'Add room and beds' : kind === 'building' ? 'Add building' : 'Add site'}
      subtitle={kind === 'site' ? 'Super Admin only' : kind === 'building' ? 'Super Admin, or an Accommodation Admin with the Building Creation capability, within assigned sites' : 'Accommodation Admin, within assigned sites'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Create</Button></>}>
      <Field label={kind === 'room' ? 'Room name' : kind === 'building' ? 'Building name (e.g. Block C)' : 'Site name'}><Input value={name} onChange={e => setName(e.target.value)} /></Field>
      {kind === 'site' && <Field label="Property type"><Select value={skind} onChange={e => setSkind(e.target.value as 'Villa')}><option>Villa</option><option>Apartment</option></Select></Field>}
      {kind === 'room' && <>
        <Field label="Building" hint="Optional: a villa can be Site › Room › Bed" optional><Select value={bld} onChange={e => setBld(e.target.value)}><option value="">None (room sits directly in the site)</option>{blds.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <div className="grid even"><Field label="Room gender"><Select value={gender} onChange={e => setGender(e.target.value as 'Any')}><option>Any</option><option>Male</option><option>Female</option></Select></Field>
          <Field label="Number of beds"><Input type="number" min={1} max={8} value={beds} onChange={e => setBeds(+e.target.value)} /></Field></div>
      </>}
    </Modal>
  )
}
