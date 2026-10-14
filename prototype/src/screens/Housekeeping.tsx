import { useState } from 'react'
import { useAct, useCtx } from '../ctx'
import { A } from '../domain/store'
import { Alert, Badge, Blocked, Button, Check, GlassCard, PageHeader, Person, Select, Status, Tabs } from '../ui'
import { bedById, bedPath, can, staffById } from '../domain/rules'
import { fmtDateTime } from '../domain/time'
import { PERSONAS } from '../roles'

const CHECKLIST = ['Linen changed', 'Bathroom cleaned', 'Floor and surfaces cleaned', 'Bins emptied', 'Fixtures and AC checked', 'No damage or lost items']

export function Housekeeping() {
  const { s, persona } = useCtx()
  const act = useAct()
  const canAssign = can(persona, 'housekeeping.assign')
  const canClean = can(persona, 'housekeeping.clean')
  const canInspect = can(persona, 'inspect.final')
  const [tab, setTab] = useState<'clean' | 'inspect'>(canClean && !canAssign ? 'clean' : 'clean')
  const tasks = s.cleaning.filter(t => t.status === 'Open')
  const mine = tasks.filter(t => t.assignedTo === persona.staffId)
  const inspect = s.beds.filter(b => b.state === 'InspectionRequired')
  const housekeepers = PERSONAS.filter(p => p.caps.includes('Housekeeping') && p.staffId)
  const [pick, setPick] = useState<Record<string, string>>({})
  const [done, setDone] = useState<Record<string, string[]>>({})
  const list = canAssign || !canClean ? tasks : mine
  return (
    <>
      <PageHeader crumbs={['Operations']} title={canClean && !canAssign ? 'My work' : 'Housekeeping and readiness'} summary="Needs cleaning → Inspection required → Available. A bed is Available only after someone else inspects it."
        actions={<Tabs value={tab} onChange={setTab} options={[{ id: 'clean', label: 'Cleaning', count: list.length }, { id: 'inspect', label: 'Final inspection', count: inspect.length }]} />} />
      {tab === 'clean' && (
        <div className="stack">
          {list.length === 0 && <GlassCard><div className="tbl-empty">No cleaning tasks{canClean && !canAssign ? ' assigned to you' : ''}</div></GlassCard>}
          {list.map(t => {
            const bed = bedById(s, t.bedId)!
            const ticked = done[t.id] ?? []
            const mineTask = t.assignedTo === persona.staffId
            return (
              <GlassCard key={t.id} strong title={bed.code} subtitle={bedPath(s, bed)} actions={<Status s="NeedsCleaning" />}>
                <div className="stack">
                  <div className="row wrap"><span className="muted">Assigned to</span>{t.assignedTo ? <Badge tone="info">{staffById(s, t.assignedTo)?.name}</Badge> : <Badge tone="warning">Unassigned</Badge>}<span className="subtle body-sm">· since {fmtDateTime(bed.since ?? t.createdAt)}</span></div>
                  {canAssign && (
                    <div className="row wrap"><Select value={pick[t.id] ?? t.assignedTo ?? housekeepers[0]?.staffId} onChange={e => setPick({ ...pick, [t.id]: e.target.value })} style={{ maxWidth: 260 }}>{housekeepers.map(h => <option key={h.id} value={h.staffId}>{h.name}</option>)}</Select><Button onClick={() => act(A.assignCleaning(persona, t.id, pick[t.id] ?? t.assignedTo ?? housekeepers[0].staffId!))}>{t.assignedTo ? 'Reassign' : 'Assign cleaning'}</Button></div>
                  )}
                  {canClean && (mineTask || canAssign) && (
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="label">Checklist</div>
                      {CHECKLIST.map(c => <Check key={c} checked={ticked.includes(c)} onChange={v => setDone({ ...done, [t.id]: v ? [...ticked, c] : ticked.filter(x => x !== c) })}>{c}</Check>)}
                      <div><Button variant="primary" disabled={ticked.length < CHECKLIST.length} onClick={() => act(A.completeCleaning(persona, t.id))}>Mark cleaned</Button></div>
                    </div>
                  )}
                  {!canClean && !canAssign && <Blocked why="Waiting for housekeeping" owner="Housekeeping" />}
                </div>
              </GlassCard>
            )
          })}
        </div>
      )}
      {tab === 'inspect' && (
        <div className="stack">
          {inspect.length === 0 && <GlassCard><div className="tbl-empty">Nothing waiting for inspection</div></GlassCard>}
          {inspect.map(b => {
            const t = [...s.cleaning].reverse().find(x => x.bedId === b.id && x.status === 'Cleaned')
            return (
              <GlassCard key={b.id} strong title={b.code} subtitle={bedPath(s, b)} actions={<Status s="InspectionRequired" />}>
                <div className="stack">
                  <div className="muted">Cleaned by {t?.cleanedBy ? staffById(s, t.cleanedBy)?.name : 'housekeeping'}. The cleaner can’t inspect their own room.</div>
                  {canInspect ? <div className="row"><Button variant="primary" onClick={() => act(A.finalInspection(persona, b.id, true))}>Pass: make Available</Button><Button variant="danger" onClick={() => act(A.finalInspection(persona, b.id, false))}>Fail: back to cleaning</Button></div>
                    : <Blocked why="Only a Final Inspection holder can release this bed" owner="Reception or Accommodation Admin with Final Inspection" next="Switch role to inspect" />}
                </div>
              </GlassCard>
            )
          })}
        </div>
      )}
    </>
  )
}
