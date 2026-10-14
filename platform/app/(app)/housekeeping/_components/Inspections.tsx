'use client'
/**
 * The final inspection queue (D-24): cleaned rooms waiting for a Final Inspection holder. Pass makes the bed Available (and tells
 * the Admin who is next in the waitlist: no offer is made); fail needs a note, takes an optional photo, and sends the room back to
 * cleaning with a new task. A room the viewer cleaned or lives in is listed but blocked, with the reason, owner and next action (D-26).
 */
import { useState } from 'react'
import { Alert, Badge, Blocked, Button, Field, GlassCard, Modal, Textarea } from '@/ui'
import { fmtDateTime } from '@/domain/time'
import type { InspectionItem } from '@/server/queries/readiness/inspections'
import { PhotoPicker, Problem, useCall, type Uploaded } from './call'

export function Inspections({ items }: { items: InspectionItem[] }) {
  return (
    <GlassCard title="Final inspection" subtitle="Cleaned rooms waiting to be passed. A bed is only available after a pass." strong flush={items.length === 0}>
      {items.length === 0
        ? <div className="tbl-empty" data-testid="no-inspections">No rooms are waiting for inspection.</div>
        : <ul className="list-plain" data-testid="inspection-list">{items.map(i => <Item key={i.taskId} item={i} />)}</ul>}
    </GlassCard>
  )
}

function Item({ item: i }: { item: InspectionItem }) {
  const { run, busy, err } = useCall()
  const [failing, setFailing] = useState(false)
  const [note, setNote] = useState('')
  const [files, setFiles] = useState<Uploaded[]>([])
  const close = () => { setFailing(false); setNote(''); setFiles([]) }
  const where = [i.siteName, i.buildingName, `Room ${i.roomName}`].filter(Boolean).join(' › ')
  return (
    <li style={{ display: 'block' }} data-task={i.taskId}>
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 17, fontWeight: 650 }}>Room {i.roomName} · Bed {i.bedCode}</div>
          <div className="muted body-sm">{where}</div>
          <div className="body-sm">Cleaned{i.cleanedByName ? ` by ${i.cleanedByName}` : ''}{i.cleanedAt ? ` · ${fmtDateTime(Date.parse(i.cleanedAt))}` : ''}</div>
        </div>
        <Badge tone="warning">Inspection required</Badge>
        {i.issue && <Badge tone="danger">Damage reported</Badge>}
      </div>
      {i.notes && <div style={{ marginTop: 8 }}><Alert tone={i.issue ? 'warning' : 'info'} title={i.issue ? 'Damage or missing items noted' : i.noCleaningRecord ? 'No cleaning record' : 'Housekeeper note'} detail={i.notes} /></div>}
      {i.lines.length > 0 && <div className="muted body-sm" style={{ marginTop: 6 }}>{i.lines.filter(l => l.done).length} of {i.lines.length} lines ticked{i.attachmentCount > 0 ? ` · ${i.attachmentCount} photo${i.attachmentCount === 1 ? '' : 's'}` : ''}</div>}
      {err && <div style={{ marginTop: 8 }}><Problem f={err} /></div>}
      {i.blocked
        ? <div style={{ marginTop: 8 }}><Blocked why={i.blocked.reason} owner={i.blocked.owner} next={i.blocked.next} /></div>
        : (
          <div className="row wrap" style={{ marginTop: 10 }}>
            <Button variant="primary" tall disabled={busy} onClick={() => void run('POST', `/api/v1/readiness/tasks/${i.taskId}/pass`, {})}>Pass: bed is ready</Button>
            <Button variant="secondary" tall disabled={busy} onClick={() => setFailing(true)}>Fail…</Button>
          </div>
        )}
      <Modal open={failing} onClose={close} title="Fail the inspection" subtitle={`Room ${i.roomName} · Bed ${i.bedCode}`}
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="danger" disabled={busy || note.trim().length < 3}
            onClick={() => void run('POST', `/api/v1/readiness/tasks/${i.taskId}/fail`, { note: note.trim(), attachmentIds: files.map(f => f.id) }, () => close())}>Fail and send back to cleaning</Button></>}>
        <div className="form">
          {err && <Problem f={err} />}
          <Field label="What has to be redone" hint="The housekeeper sees this word for word." error={err?.fields?.note}>
            <Textarea rows={4} value={note} onChange={e => setNote(e.target.value)} />
          </Field>
          <PhotoPicker taskId={i.taskId} files={files} onChange={setFiles} label="Add a photo of the problem" />
        </div>
      </Modal>
    </li>
  )
}
