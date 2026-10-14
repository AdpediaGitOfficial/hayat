'use client'
/**
 * A housekeeper's rooms, built for a phone: one card per assigned room, big tap targets, the checklist one line per row.
 * The server decides (required lines, own room, assignment); the screen only helps: it keeps "Mark cleaned" disabled until the
 * required lines are ticked and shows any refusal as reason + owner + next action. Cleaning never makes a bed available:
 * the card says so, and the next step belongs to the Final Inspection holder.
 */
import { useState } from 'react'
import { Alert, Badge, Blocked, Button, Field, GlassCard, Textarea } from '@/ui'
import type { MyRoom, ChecklistLine } from '@/server/queries/readiness/mine'
import { PhotoPicker, Problem, useCall, type Uploaded } from './call'

const DAMAGE = 'damage'

export function MyRooms({ rooms, checklist }: { rooms: MyRoom[]; checklist: ChecklistLine[] }) {
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  if (rooms.length === 0) {
    return (
      <GlassCard title="My rooms" subtitle="Rooms Reception has given you to clean">
        <div className="tbl-empty" data-testid="no-rooms">Nothing is assigned to you right now. Reception assigns rooms; you will be notified.</div>
      </GlassCard>
    )
  }
  return (
    <div className="stack" data-testid="my-rooms">
      <h2 style={{ margin: '4px 0 0' }}>My rooms <span className="muted body-sm">({rooms.length})</span></h2>
      {rooms.map(r => (
        <RoomCard key={r.taskId} room={r} checklist={checklist} open={openId === r.taskId} onToggle={() => setOpenId(openId === r.taskId ? undefined : r.taskId)} />
      ))}
    </div>
  )
}

function RoomCard({ room, checklist, open, onToggle }: { room: MyRoom; checklist: ChecklistLine[]; open: boolean; onToggle: () => void }) {
  const { run, busy, err } = useCall()
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState('')
  const [files, setFiles] = useState<Uploaded[]>([])
  const missing = checklist.filter(l => l.required && !ticks[l.id])
  const damage = ticks[DAMAGE] === true
  const needsNote = damage && notes.trim().length === 0
  const where = [room.siteName, room.buildingName, `Room ${room.roomName}`].filter(Boolean).join(' › ')

  return (
    <div data-task={room.taskId}><GlassCard strong className="hk-card">
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 18, fontWeight: 650 }}>Room {room.roomName} · Bed {room.bedCode}</div>
          <div className="muted body-sm">{where}</div>
          <div className="body-sm" style={{ marginTop: 4 }}>{room.reason}</div>
        </div>
        <Badge tone="warning">Needs cleaning</Badge>
      </div>
      {room.redoNote && <div style={{ marginTop: 10 }}><Alert tone="warning" title="Redo: this room did not pass inspection" detail={room.redoNote} /></div>}
      {room.blocked && <div style={{ marginTop: 10 }}><Blocked why={room.blocked.reason} owner={room.blocked.owner} next={room.blocked.next} /></div>}
      {!room.blocked && (
        <div style={{ marginTop: 12 }}>
          {!open ? <Button variant="primary" tall block onClick={onToggle}>Start cleaning</Button> : (
            <div className="stack" style={{ gap: 12 }}>
              {err && <Problem f={err} />}
              <div className="stack" style={{ gap: 8 }} role="group" aria-label="Cleaning checklist">
                {checklist.map(l => (
                  <label key={l.id} style={{
                    display: 'flex', alignItems: 'center', gap: 14, minHeight: 56, padding: '10px 14px', borderRadius: 12, cursor: 'pointer',
                    border: `1.5px solid ${ticks[l.id] ? 'var(--success, #1a7f4b)' : 'var(--line)'}`, background: ticks[l.id] ? 'var(--success-bg, rgba(26,127,75,.08))' : 'transparent',
                  }}>
                    <input type="checkbox" checked={ticks[l.id] === true} onChange={e => setTicks({ ...ticks, [l.id]: e.target.checked })} style={{ width: 26, height: 26, accentColor: 'var(--brand-fill)', flex: 'none' }} />
                    <span style={{ fontSize: 16 }}>{l.label}{!l.required && <span className="muted body-sm"> (if it applies)</span>}</span>
                  </label>
                ))}
              </div>
              <Field label={damage ? 'What is damaged or missing' : 'Notes'} optional={!damage} error={needsNote ? 'A note is needed when damage or missing items are noticed' : err?.fields?.notes}
                hint={damage ? 'Reception and the Maintenance Coordinator are told.' : undefined}>
                <Textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} />
              </Field>
              <PhotoPicker taskId={room.taskId} files={files} onChange={setFiles} label={damage ? 'Add a photo of the damage' : 'Add a photo'} />
              {missing.length > 0 && <div className="muted body-sm">Still to tick: {missing.map(m => m.label).join(', ')}</div>}
              <div className="row wrap">
                <Button variant="primary" tall block disabled={busy || missing.length > 0 || needsNote}
                  onClick={() => void run(`POST`, `/api/v1/readiness/tasks/${room.taskId}/clean`, { checklist: ticks, notes: notes.trim() || null, attachmentIds: files.map(f => f.id) })}>
                  {busy ? 'Saving…' : 'Mark cleaned'}
                </Button>
              </div>
              <div className="muted body-sm">After this the room still needs its final inspection before anyone can move in.</div>
            </div>
          )}
        </div>
      )}
    </GlassCard></div>
  )
}
