import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Check, DataTable, Field, GlassCard, Modal, PageHeader, Person, Select, Status, Textarea } from '../ui'
import { bedById, can, staffById, suggestBeds } from '../domain/rules'
import { fmtDateTime, today } from '../domain/time'

export function Transfers() {
  const { s, persona, params, go } = useCtx()
  const act = useAct()
  const [modal, setModal] = useState<null | 'transfer' | 'swap'>(params.offer ? 'transfer' : null)
  const [fail, setFail] = useState(false)
  const rows = [...s.transfers].sort((a, b) => b.createdAt - a.createdAt)
  const canRequest = can(persona, 'transfer.request')
  return (
    <>
      <PageHeader crumbs={['Accommodation']} title="Transfers and swaps" summary="Approval ≠ execution. We lock the destination before releasing the source, and a failure leaves the resident where they were."
        actions={canRequest && <><Button onClick={() => setModal('swap')}>New swap</Button><Button variant="primary" icon="plus" onClick={() => setModal('transfer')}>New transfer</Button></>} />
      <Alert tone="info" title="Try a failed transfer" detail="Tick “simulate a key-reissue failure”, then execute an approved transfer. The whole operation rolls back and the resident stays in their original bed." />
      <div className="row"><Check checked={fail} onChange={setFail}>Simulate a key-reissue failure on execute</Check></div>
      <DataTable rowKey={t => t.id} rows={rows} cols={[
        { key: 'k', header: 'Type', render: t => <Badge outline>{t.kind}</Badge> },
        { key: 'r', header: 'Resident', render: t => { const st = s.stays.find(x => x.id === t.stayId)!; const o = t.otherStayId ? s.stays.find(x => x.id === t.otherStayId) : undefined; return <Person name={staffById(s, st.staffId)!.name + (o ? ' ⇄ ' + staffById(s, o.staffId)!.name : '')} sub={t.reason} /> } },
        { key: 'm', header: 'Move', render: t => { const st = s.stays.find(x => x.id === t.stayId)!; const o = t.otherStayId ? s.stays.find(x => x.id === t.otherStayId) : undefined; return o ? <span className="mono">{bedById(s, st.bedId)?.code} ⇄ {bedById(s, o.bedId)?.code}</span> : <span className="mono">{bedById(s, st.bedId)?.code} → {bedById(s, t.destBedId)?.code}</span> } },
        { key: 'w', header: 'Raised', render: t => <span className="tnum">{fmtDateTime(t.createdAt)}</span> },
        { key: 's', header: 'Status', render: t => <><Status s={t.status} />{t.status === 'Failed' && <div className="subtle body-sm" style={{ maxWidth: 260 }}>{t.note}</div>}</> },
        { key: 'a', header: '', align: 'r', render: t => t.status === 'Submitted' ? <Button size="sm" onClick={() => go('approvals')}>Awaiting approval</Button> : (t.status === 'Approved' || t.status === 'Failed') && can(persona, 'transfer.execute') ? <Button size="sm" variant="primary" onClick={() => {
          if (t.status === 'Failed') { /* a failed transfer can be re-requested */ return act({ ok: false, reason: 'This transfer failed. Raise a new one', owner: 'Accommodation Admin', next: 'New transfer' }) }
          act(A.executeTransfer(persona, t.id, { injectFailure: fail }))
        }}>{t.status === 'Failed' ? 'Failed' : 'Execute'}</Button> : null },
      ]} empty="No transfers yet" />
      {modal && <NewModal kind={modal} presetStay={params.offer} onClose={() => setModal(null)} />}
    </>
  )
}

function NewModal({ kind, presetStay, onClose }: { kind: 'transfer' | 'swap'; presetStay?: string; onClose: () => void }) {
  const { s, persona } = useCtx()
  const act = useAct()
  const stays = s.stays.filter(x => x.status === 'Active')
  const [stayId, setStayId] = useState(presetStay ?? stays[0]?.id ?? '')
  const stay = stays.find(x => x.id === stayId)
  const staff = stay && staffById(s, stay.staffId)
  const dests = stay && staff ? suggestBeds(s, staff, { from: today(), to: stay.end }, persona.sites).filter(b => b.state === 'Available') : []
  const [dest, setDest] = useState('')
  const others = stays.filter(x => x.id !== stayId)
  const [other, setOther] = useState('')
  const [reason, setReason] = useState('')
  const submit = () => kind === 'transfer' ? act(A.requestTransfer(persona, { stayId, destBedId: dest || dests[0]?.id, reason }), onClose) : act(A.requestSwap(persona, { stayId, otherStayId: other || others[0]?.id, reason }), onClose)
  return (
    <Modal open onClose={onClose} title={kind === 'transfer' ? 'New transfer' : 'New swap'} subtitle={kind === 'swap' ? 'Both beds are occupied: one atomic two-way operation, not two transfers' : 'Moves a resident to a free bed'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Request</Button></>}>
      <Field label="Resident"><Select value={stayId} onChange={e => setStayId(e.target.value)}>{stays.map(x => <option key={x.id} value={x.id}>{staffById(s, x.staffId)?.name} · {bedById(s, x.bedId)?.code}</option>)}</Select></Field>
      {kind === 'transfer' ? (dests.length ? <Field label="Destination bed (eligible, ready)"><Select value={dest || dests[0].id} onChange={e => setDest(e.target.value)}>{dests.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field> : <Blocked why="No eligible ready bed for this resident" owner="Housekeeping" next="Wait for cleaning and inspection, or pick a different resident" />)
        : <Field label="Swap with"><Select value={other || others[0]?.id} onChange={e => setOther(e.target.value)}>{others.map(x => <option key={x.id} value={x.id}>{staffById(s, x.staffId)?.name} · {bedById(s, x.bedId)?.code}</option>)}</Select></Field>}
      <Field label="Reason"><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field>
    </Modal>
  )
}
