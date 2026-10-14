'use client'
/**
 * What can be done to one clearance item, as dialogs: complete on the former employee's behalf, record that it cannot be done now
 * (Outstanding, with a note and the owner who follows it up), reopen, and the Policy Approver's waiver (reason, evidence, password).
 * The server decides who may; `item.me` only says which buttons to show and why the others are missing.
 */
import { useState } from 'react'
import { Alert, Blocked, Button, Field, Input, Modal, Select, Textarea } from '@/ui'
import type { ItemView } from '@/server/queries/exit/cases'
import { Problem, useCall } from './common'
import { EvidenceUpload, type Uploaded } from './EvidenceUpload'

type Mode = 'done' | 'outstanding' | 'reopen' | 'waive'

export function ItemActions({ item, personName }: { item: ItemView; personName: string }) {
  const [mode, setMode] = useState<Mode>()
  const [note, setNote] = useState('')
  const [owner, setOwner] = useState('')
  const [evidence, setEvidence] = useState('')
  const [password, setPassword] = useState('')
  const [files, setFiles] = useState<Uploaded[]>([])
  const { run, busy, err, clear } = useCall()
  const me = item.me
  const close = () => { setMode(undefined); setNote(''); setOwner(''); setEvidence(''); setPassword(''); setFiles([]); clear() }
  const open = (m: Mode) => { clear(); setMode(m) }
  const finished = item.status === 'done' || item.status === 'waived'

  const go = () => {
    const ids = files.map(f => f.id)
    if (mode === 'done') return run(`/api/v1/exit/items/${item.id}/complete`, { note: note.trim() || null, attachmentIds: ids }, close)
    if (mode === 'outstanding') return run(`/api/v1/exit/items/${item.id}/outstanding`, { note, ...(owner ? { owner } : {}) }, close)
    if (mode === 'reopen') return run(`/api/v1/exit/items/${item.id}/reopen`, { reason: note }, close)
    return run(`/api/v1/exit/items/${item.id}/waive`, { reason: note, evidence, attachmentIds: ids, confirmPassword: password }, close)
  }
  const ready = mode === 'done' ? true
    : mode === 'outstanding' ? note.trim().length > 0
      : mode === 'reopen' ? note.trim().length >= 3
        : note.trim().length >= 3 && evidence.trim().length >= 3 && password.length > 0

  return (
    <div className="stack" style={{ gap: 8 }}>
      {!finished && !me.canWork && !me.canWaive && !me.canReopen && me.why && <Blocked why={me.why} owner={me.owner} next={me.next} />}
      <div className="row wrap">
        {me.canWork && <Button size="sm" variant="primary" onClick={() => open('done')} aria-label={`Mark done: ${item.label}`}>Mark done</Button>}
        {me.canWork && item.status !== 'outstanding' && <Button size="sm" onClick={() => open('outstanding')} aria-label={`Cannot be done: ${item.label}`}>Cannot be done now</Button>}
        {me.canReopen && <Button size="sm" onClick={() => open('reopen')} aria-label={`Reopen: ${item.label}`}>Reopen</Button>}
        {me.canWaive && <Button size="sm" onClick={() => open('waive')} aria-label={`Waive: ${item.label}`}>Waive…</Button>}
      </div>

      <Modal open={!!mode} onClose={close} wide={mode === 'waive'}
        title={mode === 'done' ? `Mark done: ${item.label}` : mode === 'outstanding' ? `Cannot be done now: ${item.label}` : mode === 'reopen' ? `Reopen: ${item.label}` : `Waive: ${item.label}`}
        footer={<>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant={mode === 'waive' ? 'danger' : 'primary'} disabled={busy || !ready} onClick={() => void go()}>
            {mode === 'done' ? 'Record as done' : mode === 'outstanding' ? 'Record as outstanding' : mode === 'reopen' ? 'Reopen the item' : 'Waive this item'}
          </Button>
        </>}>
        <div className="form">
          {err && <Problem f={err} />}
          {mode === 'done' && <Alert tone="info" title={`Recorded on ${personName}'s behalf`} detail="They no longer have a login, so you complete it for them. Your name, the time and this note are kept in the case history." />}
          {mode === 'outstanding' && <Alert tone="warning" title="The case stays open" detail="A mandatory item that cannot be done now stays on the case as Outstanding, with the note and the person who follows it up. It still has to be done or waived by the Policy Approver before the case can close." />}
          {mode === 'waive' && <Alert tone="warning" title="A waiver is final" detail="Only a Policy Approver can waive a clearance item. The reason, the evidence, your name and the time are kept for audit. It cannot be undone." />}
          <Field label={mode === 'reopen' ? 'Why is it being reopened?' : mode === 'waive' ? 'Reason for the waiver' : mode === 'outstanding' ? 'What is in the way?' : 'Note'}
            optional={mode === 'done'} hint={mode === 'done' ? 'For example what was collected or checked.' : 'Required.'} error={err?.fields?.note ?? err?.fields?.reason}>
            <Textarea value={note} onChange={e => setNote(e.target.value)} rows={3} />
          </Field>
          {mode === 'outstanding' && (
            <Field label="Who follows it up?" optional hint={`Currently ${item.ownerLabel}.`}>
              <Select value={owner} onChange={e => setOwner(e.target.value)}>
                <option value="">Keep {item.ownerLabel}</option>
                <option value="Reception">Reception</option>
                <option value="Maintenance">Maintenance Coordinator</option>
                <option value="AA">Accommodation Admin</option>
              </Select>
            </Field>
          )}
          {mode === 'waive' && (
            <>
              <Field label="Evidence" hint="Required: what supports the waiver, for example an incident report number or who confirmed it." error={err?.fields?.evidence}>
                <Textarea value={evidence} onChange={e => setEvidence(e.target.value)} rows={3} />
              </Field>
              <Field label="Photo or PDF" optional hint="Attached to this item and kept with the case.">
                <EvidenceUpload itemId={item.id} files={files} onChange={setFiles} />
              </Field>
              <Field label="Your password" hint="Confirm it is you (D-03)." error={err?.fields?.confirmPassword}>
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
            </>
          )}
          {mode === 'done' && (
            <Field label="Photo or PDF" optional><EvidenceUpload itemId={item.id} files={files} onChange={setFiles} /></Field>
          )}
        </div>
      </Modal>
    </div>
  )
}
