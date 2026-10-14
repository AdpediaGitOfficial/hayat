'use client'
/**
 * The readiness board: every bed that is not ready, with what it is waiting for, who owns the next step and what that step is (D-93).
 * Reception and the Super Admin assign a housekeeper from here. A Manager or Auditor gets the summary only (no rows).
 * Blocked and under-maintenance beds are shown because they explain why a bed is missing; changing them belongs to Maintenance.
 */
import { useEffect, useState } from 'react'
import { Alert, Badge, Blocked, Button, Field, GlassCard, Modal, Select, Status, Textarea } from '@/ui'
import { fmtDate } from '@/domain/time'
import { api } from '@/ui/api'
import type { Board as BoardData, BoardRow } from '@/server/queries/readiness/board'
import type { HousekeeperOption } from '@/server/queries/readiness/housekeepers'
import { Problem, useCall } from './call'

const STATUS: Record<BoardRow['state'], string> = { needs_cleaning: 'NeedsCleaning', inspection_required: 'InspectionRequired', blocked: 'Blocked', under_maintenance: 'UnderMaintenance' }
export const age = (h: number) => (h < 1 ? 'under an hour' : h < 48 ? `${h} h` : `${Math.floor(h / 24)} d ${h % 24} h`)

export function Board({ board, canAssign }: { board: BoardData; canAssign: boolean }) {
  const s = board.summary
  const rows = board.rows
  const bySite = new Map<string, BoardRow[]>()
  for (const r of rows ?? []) bySite.set(r.siteName, [...(bySite.get(r.siteName) ?? []), r])
  return (
    <div className="stack">
      <div className="grid three" data-testid="board-summary" style={{ gap: 12 }}>
        <Tile label="Needs cleaning" value={s.needsCleaning} hint={s.unassigned > 0 ? `${s.unassigned} without a housekeeper` : 'all assigned'} warn={s.unassigned > 0} />
        <Tile label="Awaiting final inspection" value={s.awaitingInspection} hint="cleaned, not yet passed" />
        <Tile label={`Past ${board.slaHours} h`} value={s.overSla} hint={s.oldestHours > 0 ? `longest wait ${age(s.oldestHours)}` : 'nothing waiting'} warn={s.overSla > 0} />
      </div>
      {rows === null && <Alert tone="info" title="Summary only" detail="Your role sees the totals, not the people or the individual rooms." />}
      {rows !== null && rows.length === 0 && (
        <GlassCard title="Readiness board" flush><div className="tbl-empty" data-testid="board-empty">Every bed is ready. Nothing is waiting for cleaning or inspection.</div></GlassCard>
      )}
      {[...bySite.entries()].map(([siteName, list]) => (
        <GlassCard key={siteName} title={siteName} subtitle={`${list.length} bed${list.length === 1 ? '' : 's'} not ready`} strong flush>
          <ul className="list-plain" data-testid="board-list" style={{ padding: '0 20px 8px' }}>
            {list.map(r => <Row key={r.bedId} r={r} canAssign={canAssign} />)}
          </ul>
        </GlassCard>
      ))}
    </div>
  )
}

function Tile({ label, value, hint, warn }: { label: string; value: number; hint: string; warn?: boolean }) {
  return (
    <div className="card stat">
      <span className="lbl">{label}</span>
      <span className="val"><span className="kpi">{value}</span></span>
      <span className="foot" style={warn ? { color: 'var(--warning-ink, inherit)' } : undefined}>{hint}</span>
    </div>
  )
}

function Row({ r, canAssign }: { r: BoardRow; canAssign: boolean }) {
  const [assigning, setAssigning] = useState(false)
  const cancel = useCall()
  const [cancelling, setCancelling] = useState(false)
  const [opening, setOpening] = useState(false)
  const [reason, setReason] = useState('')
  const t = r.task
  // A bed in Needs cleaning or Inspection required with NO task on record (migrated or seeded data): the hand path of S-22, P-14 (proposed, pending client sign-off).
  const noRecord = !t && (r.state === 'needs_cleaning' || r.state === 'inspection_required')
  const open = t?.status === 'open' && r.state === 'needs_cleaning'
  // A task its bed no longer needs (blocked, or out of step) can be cancelled so a fresh one opens when the bed returns.
  const stale = !!t && !((t.status === 'open' && r.state === 'needs_cleaning') || (t.status === 'cleaned' && r.state === 'inspection_required'))
  const where = [r.buildingName, `Room ${r.roomName}`].filter(Boolean).join(' › ')
  return (
    <li style={{ display: 'block' }} data-bed={r.bedCode} data-task={t?.id}>
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 650 }}>Bed {r.bedCode} <span className="muted" style={{ fontWeight: 400 }}>· {where}</span></div>
        </div>
        <Status s={STATUS[r.state]} />
        {r.overSla && <Badge tone="warning">Past the SLA</Badge>}
        {r.needBy && <Badge tone="info">Needed {fmtDate(r.needBy)}</Badge>}
        <span className="muted body-sm">{age(r.ageHours)}</span>
      </div>
      <div style={{ marginTop: 6 }}><Blocked why={r.label} owner={r.owner} next={r.next} /></div>
      {t?.issue && <div style={{ marginTop: 6 }}><Badge tone="danger">Damage reported while cleaning</Badge></div>}
      {t && <div className="muted body-sm" style={{ marginTop: 6 }}>{t.assigneeName ? `Assigned to ${t.assigneeName}` : 'Not assigned'} · {t.reason}{t.cleanedByName ? ` · cleaned by ${t.cleanedByName}` : ''}</div>}
      {canAssign && noRecord && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          <Button variant="primary" onClick={() => setOpening(true)}>Open a task by hand…</Button>
          <span className="muted body-sm">Proposed policy, pending client sign-off. A reason is required and kept in the audit log.</span>
        </div>
      )}
      {canAssign && t && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          {open && <Button variant={t.assigneeName ? 'secondary' : 'primary'} onClick={() => setAssigning(true)}>{t.assigneeName ? 'Reassign…' : 'Assign a housekeeper…'}</Button>}
          {stale && <Button variant="ghost" onClick={() => setCancelling(true)}>Cancel this task…</Button>}
        </div>
      )}
      {assigning && t && <AssignModal task={t} bed={r} onClose={() => setAssigning(false)} />}
      <Modal open={opening} onClose={() => setOpening(false)} title="Open a cleaning task by hand" subtitle={`Bed ${r.bedCode} · ${where}`}
        footer={<><Button variant="ghost" onClick={() => setOpening(false)}>Back</Button>
          <Button variant="primary" disabled={cancel.busy || reason.trim().length < 3} onClick={() => void cancel.run('POST', `/api/v1/readiness/beds/${r.bedId}/open-task`, { reason: reason.trim() }, () => { setOpening(false); setReason('') })}>
            {r.state === 'inspection_required' ? 'Open for the final inspection' : 'Open the task'}</Button></>}>
        <div className="form">
          {cancel.err && <Problem f={cancel.err} />}
          <Alert tone="info" title={r.state === 'inspection_required' ? 'There is no cleaning record for this bed' : 'This bed has no cleaning task'}
            detail={r.state === 'inspection_required'
              ? 'The task is opened as already cleaned, with a note that readiness was restored without a cleaning record, so the final inspection can proceed. You cannot inspect it yourself.'
              : 'A normal cleaning task is opened. Assign a housekeeper afterwards.'} />
          <Field label="Why" error={cancel.err?.fields?.reason}><Textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} /></Field>
        </div>
      </Modal>
      <Modal open={cancelling} onClose={() => setCancelling(false)} title="Cancel this cleaning task" subtitle={`Bed ${r.bedCode}`}
        footer={<><Button variant="ghost" onClick={() => setCancelling(false)}>Back</Button>
          <Button variant="danger" disabled={cancel.busy || reason.trim().length < 3} onClick={() => t && void cancel.run('POST', `/api/v1/readiness/tasks/${t.id}/cancel`, { reason: reason.trim() }, () => setCancelling(false))}>Cancel task</Button></>}>
        <div className="form">
          {cancel.err && <Problem f={cancel.err} />}
          <Field label="Why" error={cancel.err?.fields?.reason}><Textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} /></Field>
        </div>
      </Modal>
    </li>
  )
}

function AssignModal({ task, bed, onClose }: { task: NonNullable<BoardRow['task']>; bed: BoardRow; onClose: () => void }) {
  const { run, busy, err } = useCall()
  const [people, setPeople] = useState<HousekeeperOption[]>()
  const [loadErr, setLoadErr] = useState<string>()
  const [pick, setPick] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    void api<HousekeeperOption[]>('GET', `/api/v1/readiness/housekeepers?taskId=${task.id}`).then(r => (r.ok ? setPeople(r.data) : setLoadErr(r.reason)))
  }, [task.id])
  const reassign = !!task.assigneeStaffId
  const ok = pick !== '' && (!reassign || note.trim().length >= 3)
  return (
    <Modal open onClose={onClose} title={reassign ? 'Reassign cleaning' : 'Assign a housekeeper'} subtitle={`Bed ${bed.bedCode} · Room ${bed.roomName}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !ok} onClick={() => void run('POST', `/api/v1/readiness/tasks/${task.id}/assign`, { housekeeperStaffId: pick, note: note.trim() || null }, () => onClose())}>{reassign ? 'Reassign' : 'Assign'}</Button></>}>
      <div className="form">
        {err && <Problem f={err} />}
        {loadErr && <Alert tone="danger" title={loadErr} />}
        <Field label="Housekeeper" hint="Everyone holding the Housekeeping capability is listed (it carries no site); people recently given a task at this site come first, then those with the fewest open tasks. Nobody can be given the room they live in." error={err?.fields?.housekeeperStaffId}>
          <Select value={pick} onChange={e => setPick(e.target.value)} aria-label="Housekeeper">
            <option value="">{people ? (people.length ? 'Choose…' : 'Nobody holds the Housekeeping capability') : 'Loading…'}</option>
            {(people ?? []).map(p => <option key={p.staffId} value={p.staffId} disabled={!!p.blocked}>{p.name} ({p.employeeId}) · {p.openTasks} open{p.recentAtSite ? ' · works here' : ''}{p.blocked ? ` · ${p.blocked}` : ''}</option>)}
          </Select>
        </Field>
        {reassign && <Field label="Reason for the change" error={err?.fields?.note}><Textarea rows={2} value={note} onChange={e => setNote(e.target.value)} /></Field>}
      </div>
    </Modal>
  )
}
