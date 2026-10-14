'use client'
/**
 * The forms of the keys screens, thin clients over the keys API (the server decides; a refusal is shown as reason, owner and next
 * action). Phone-first: one column, large targets. Used by the desk on /keys, the item page and the stay panel.
 */
import { useRef, useState } from 'react'
import { Alert, Blocked, Button, Check, Field, Input, Select, Textarea } from '@/ui'
import { api, type ApiFail } from '@/ui/api'
import type { KeyPerson } from '@/server/queries/keys/items'
import { Problem, useCall } from './call'

export interface ItemRef { id: string; code: string; label: string; status: 'in_cabinet' | 'issued' | 'lost' | 'damaged' | 'retired' }
const P = '/api/v1/keys'

/* ---------------- find a person by employee ID ---------------- */

export function PersonLookup({ itemId, onPick }: { itemId?: string; onPick: (p: KeyPerson | undefined) => void }) {
  const [employeeId, setEmployeeId] = useState('')
  const [person, setPerson] = useState<KeyPerson>()
  const [err, setErr] = useState<ApiFail>()
  async function find() {
    setPerson(undefined); setErr(undefined); onPick(undefined)
    const r = await api<KeyPerson>('GET', `${P}/people?employeeId=${encodeURIComponent(employeeId.trim())}${itemId ? `&itemId=${itemId}` : ''}`)
    if (r.ok) { setPerson(r.data); onPick(r.data.canHold ? r.data : undefined) } else setErr(r)
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label="Employee ID" hint="Type it, or scan the staff card." error={err ? (err.code === 'not_found' ? 'No staff member with that employee ID' : err.reason) : undefined}>
        <Input value={employeeId} autoComplete="off" inputMode="text" placeholder="E1007"
          onChange={e => { setEmployeeId(e.target.value); setPerson(undefined); setErr(undefined); onPick(undefined) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (employeeId.trim()) void find() } }} />
      </Field>
      <div><Button type="button" onClick={() => void find()} disabled={!employeeId.trim()}>Find person</Button></div>
      {person && (
        <div data-testid="person-card" className="stack" style={{ gap: 6 }}>
          <div className="row wrap"><b>{person.fullName}</b><span className="muted">{person.employeeId}{person.department ? ` · ${person.department}` : ''}</span></div>
          {person.problem && <Blocked why={person.problem} owner={person.isSelf ? 'Another member of staff' : 'Accommodation Admin'} next={person.isSelf ? 'Ask a colleague to hand it over' : 'Check the staff record and the stay, or choose a different item'} />}
        </div>
      )}
    </div>
  )
}

/* ---------------- issue ---------------- */

/** Hand an item from the cabinet to a person. With `staff`, the person is already known (the stay page). */
export function IssueForm({ item, staff, today, onDone }: { item: ItemRef; staff?: { id: string; name: string }; today: string; onDone?: () => void }) {
  const { run, busy, err } = useCall()
  const [person, setPerson] = useState<KeyPerson>()
  const [dueBack, setDueBack] = useState('')
  const [note, setNote] = useState('')
  const staffId = staff?.id ?? person?.id
  return (
    <form className="form" noValidate onSubmit={e => {
      e.preventDefault()
      if (staffId) void run('POST', `${P}/${item.id}/issue`, { staffId, dueBack: dueBack || null, note: note || null }, () => { setDueBack(''); setNote(''); onDone?.() })
    }}>
      {err && <Problem f={err} />}
      {staff ? <p className="body-sm">Issue <b>{item.label}</b> to <b>{staff.name}</b>.</p> : <PersonLookup itemId={item.id} onPick={setPerson} />}
      <Field label="Due back" optional hint="Leave empty for a key held for the whole stay." error={err?.fields?.dueBack}><Input type="date" min={today} value={dueBack} onChange={e => setDueBack(e.target.value)} /></Field>
      <Field label="Note" optional error={err?.fields?.note}><Input value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
      <div><Button variant="primary" type="submit" block tall disabled={busy || !staffId}>Issue {item.code}{staff ? ` to ${staff.name}` : person ? ` to ${person.fullName}` : ''}</Button></div>
    </form>
  )
}

/* ---------------- return ---------------- */

export function ReturnForm({ item, holder, holderLeft, onDone }: { item: ItemRef; holder?: string; holderLeft?: boolean; onDone?: () => void }) {
  const { run, busy, err } = useCall()
  const [notHere, setNotHere] = useState(!!holderLeft)
  const [note, setNote] = useState('')
  return (
    <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('POST', `${P}/${item.id}/return`, { note: note || null, onBehalf: notHere }, () => { setNote(''); onDone?.() }) }}>
      {err && <Problem f={err} />}
      <p className="body-sm">Take <b>{item.label}</b>{holder ? <> back from <b>{holder}</b></> : null} into the cabinet.</p>
      <Check checked={notHere} onChange={setNotHere}>The holder is not here (returned on their behalf)</Check>
      <Field label="Note" optional error={err?.fields?.note}><Input value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
      <div><Button variant="primary" type="submit" block tall disabled={busy}>Record the return of {item.code}</Button></div>
    </form>
  )
}

/* ---------------- lost and damaged (note mandatory, evidence optional) ---------------- */

async function toBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

export function ProblemForm({ item, kind, onDone }: { item: ItemRef; kind: 'lost' | 'damaged'; onDone?: () => void }) {
  const { run, busy, err } = useCall()
  const [note, setNote] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [upErr, setUpErr] = useState<ApiFail>()
  const [uploading, setUploading] = useState(false)
  const uploaded = useRef(new Map<string, string>())   // a retry after a refusal does not upload the same file twice

  async function submit() {
    setUpErr(undefined)
    const ids: string[] = []
    setUploading(true)
    for (const f of files) {
      const key = `${f.name}:${f.size}:${f.lastModified}`
      let id = uploaded.current.get(key)
      if (!id) {
        const r = await api<{ id: string }>('POST', '/api/v1/attachments', { entityType: 'handover_item', entityId: item.id, filename: f.name, contentType: f.type || undefined, dataBase64: await toBase64(f) })
        if (!r.ok) { setUploading(false); setUpErr(r); return }
        id = r.data.id
        uploaded.current.set(key, id)
      }
      ids.push(id)
    }
    setUploading(false)
    await run('POST', `${P}/${item.id}/${kind}`, { note, attachmentIds: ids }, () => { setNote(''); setFiles([]); onDone?.() })
  }
  return (
    <form className="form" noValidate onSubmit={e => { e.preventDefault(); void submit() }}>
      {(upErr || err) && <Problem f={(upErr ?? err)!} />}
      <Alert tone="warning" title={`A ${kind} item is never marked returned`} detail={kind === 'lost' ? 'It stays with the holder until it is found, replaced or retired.' : 'It stays with the holder until it is replaced or retired.'} />
      <Field label={kind === 'lost' ? 'What happened' : 'What is damaged'} hint="Required. Say where and when." error={err?.fields?.note}><Textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
      <Field label={kind === 'damaged' ? 'Photos (evidence)' : 'Files (for example a report)'} optional hint="PNG, JPEG or PDF, up to 5 MB each." error={upErr?.fields?.dataBase64}>
        <input type="file" multiple accept="image/png,image/jpeg,application/pdf" onChange={e => setFiles(Array.from(e.target.files ?? []))} />
      </Field>
      <div><Button variant="danger" type="submit" block tall disabled={busy || uploading || note.trim().length < 3}>Record {item.code} as {kind}</Button></div>
    </form>
  )
}

/* ---------------- found ---------------- */

export function FoundForm({ item, hasHolder, onDone }: { item: ItemRef; hasHolder: boolean; onDone?: () => void }) {
  const { run, busy, err } = useCall()
  const [to, setTo] = useState<'holder' | 'cabinet'>(hasHolder ? 'holder' : 'cabinet')
  const [note, setNote] = useState('')
  return (
    <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('POST', `${P}/${item.id}/found`, { to, note: note || null }, onDone) }}>
      {err && <Problem f={err} />}
      <Field label="Where is it now">
        <Select value={to} onChange={e => setTo(e.target.value as 'holder' | 'cabinet')}>
          {hasHolder && <option value="holder">Back with the holder</option>}
          <option value="cabinet">Back in the cabinet</option>
        </Select>
      </Field>
      <Field label="Note" optional><Input value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
      <div><Button variant="primary" type="submit" block tall disabled={busy}>Mark {item.code} as found</Button></div>
    </form>
  )
}

/* ---------------- retire, replace, archive (administrators) ---------------- */

export function RetireForm({ item, onDone }: { item: ItemRef; onDone?: () => void }) {
  const { run, busy, err } = useCall()
  const [reason, setReason] = useState('')
  return (
    <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('POST', `${P}/${item.id}/retire`, { reason }, onDone) }}>
      {err && <Problem f={err} />}
      <p className="body-sm">Retiring takes <b>{item.label}</b> out of use for good and ends the holder&apos;s obligation for it. The history stays.</p>
      <Field label="Reason" error={err?.fields?.reason}><Textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /></Field>
      <div><Button variant="danger" type="submit" block tall disabled={busy || reason.trim().length < 3}>Retire {item.code}</Button></div>
    </form>
  )
}

export function ReplaceForm({ item, holder, onDone }: { item: ItemRef; holder?: string; onDone?: () => void }) {
  const { run, busy, err } = useCall()
  const [newCode, setNewCode] = useState('')
  const [note, setNote] = useState('')
  return (
    <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('POST', `${P}/${item.id}/replace`, { newCode, note: note || null }, onDone) }}>
      {err && <Problem f={err} />}
      <p className="body-sm">The old item is retired and linked to the new one.{holder ? <> The new one is issued to <b>{holder}</b> if they can still hold it.</> : ' The new one goes into the cabinet.'}</p>
      <Field label="Code of the new item" hint="A new tag or key number. The retired item keeps its own code." error={err?.fields?.newCode}><Input value={newCode} onChange={e => setNewCode(e.target.value)} maxLength={40} /></Field>
      <Field label="Note" optional><Input value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
      <div><Button variant="primary" type="submit" block tall disabled={busy || !newCode.trim()}>Replace {item.code}</Button></div>
    </form>
  )
}

export function ArchiveForm({ item, onDone }: { item: ItemRef; onDone?: () => void }) {
  const { run, busy, err } = useCall()
  const [reason, setReason] = useState('')
  return (
    <form className="form" noValidate onSubmit={e => { e.preventDefault(); void run('POST', `${P}/${item.id}/archive`, { reason }, onDone) }}>
      {err && <Problem f={err} />}
      <p className="body-sm">Archiving hides <b>{item.label}</b> from the lists and frees its code. It is never deleted.</p>
      <Field label="Reason" error={err?.fields?.reason}><Input value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /></Field>
      <div><Button type="submit" block disabled={busy || reason.trim().length < 3}>Archive {item.code}</Button></div>
    </form>
  )
}

/* ---------------- the item page: which actions, with blocked states explained ---------------- */

type Mode = 'issue' | 'return' | 'lost' | 'damaged' | 'found' | 'retire' | 'replace' | 'archive'

export function ItemActions({ item, holder, holderLeft, today, canMove, canManage }: {
  item: ItemRef; holder?: { id: string; name: string }; holderLeft?: boolean; today: string; canMove: boolean; canManage: boolean
}) {
  const [mode, setMode] = useState<Mode>()
  const done = () => setMode(undefined)
  const s = item.status
  const buttons: { id: Mode; label: string; variant?: 'primary' | 'danger'; show: boolean }[] = [
    { id: 'issue', label: 'Issue', variant: 'primary', show: canMove && s === 'in_cabinet' },
    { id: 'return', label: 'Record return', variant: 'primary', show: canMove && s === 'issued' },
    { id: 'lost', label: 'Report lost', show: canMove && (s === 'in_cabinet' || s === 'issued') },
    { id: 'damaged', label: 'Report damaged', show: canMove && (s === 'in_cabinet' || s === 'issued') },
    { id: 'found', label: 'Mark found', variant: 'primary', show: canMove && s === 'lost' },
    { id: 'replace', label: 'Replace', show: canManage && (s === 'lost' || s === 'damaged') },
    { id: 'retire', label: 'Retire', variant: 'danger', show: canManage && (s === 'lost' || s === 'damaged' || s === 'in_cabinet') },
    { id: 'archive', label: 'Archive', show: canManage && (s === 'in_cabinet' || s === 'retired') },
  ]
  const shown = buttons.filter(b => b.show)
  return (
    <div className="stack" style={{ gap: 12 }}>
      {s === 'lost' && <Blocked why="A lost item cannot be marked returned" owner="Accommodation Admin" next="Mark it found if it turns up, or replace or retire it" />}
      {s === 'damaged' && <Blocked why="A damaged item cannot be marked returned" owner="Accommodation Admin" next="Replace it with a new one, or retire it" />}
      {s === 'issued' && !canMove && <Blocked why="You can see this item but not hand it back" owner="Reception" next="Take it to Reception to record the return" />}
      {shown.length === 0 && s === 'retired' && <p className="muted body-sm">This item is retired. It is kept for the history.</p>}
      {shown.length === 0 && s !== 'retired' && !(s === 'issued' && !canMove) && <p className="muted body-sm">You can view this item. Reception and the Accommodation Admin act on it.</p>}
      <div className="row wrap">
        {shown.map(b => <Button key={b.id} variant={mode === b.id ? 'primary' : b.variant ?? 'secondary'} onClick={() => setMode(mode === b.id ? undefined : b.id)}>{b.label}</Button>)}
      </div>
      {mode === 'issue' && <IssueForm item={item} today={today} onDone={done} />}
      {mode === 'return' && <ReturnForm item={item} holder={holder?.name} holderLeft={holderLeft} onDone={done} />}
      {mode === 'lost' && <ProblemForm item={item} kind="lost" onDone={done} />}
      {mode === 'damaged' && <ProblemForm item={item} kind="damaged" onDone={done} />}
      {mode === 'found' && <FoundForm item={item} hasHolder={!!holder} onDone={done} />}
      {mode === 'replace' && <ReplaceForm item={item} holder={holder?.name} onDone={done} />}
      {mode === 'retire' && <RetireForm item={item} onDone={done} />}
      {mode === 'archive' && <ArchiveForm item={item} onDone={done} />}
    </div>
  )
}
