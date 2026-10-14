'use client'
/**
 * The desk: issue or take back a key in a few taps on a phone. Type or scan the code on the tag, see what the item is and where it
 * stands, then issue it (find the person by employee ID) or record its return. Anything the rules refuse is explained with reason,
 * owner and next action, never a silent failure.
 */
import Link from 'next/link'
import { useState } from 'react'
import { Alert, Blocked, Button, Field, GlassCard, Input } from '@/ui'
import { api, type ApiFail } from '@/ui/api'
import type { ItemRow } from '@/server/queries/keys/items'
import { fmtDate } from '@/domain/time'
import { OverdueBadge, StatusChip } from './bits'
import { IssueForm, ReturnForm } from './Forms'

export function Desk({ today }: { today: string }) {
  const [code, setCode] = useState('')
  const [hits, setHits] = useState<ItemRow[]>()
  const [item, setItem] = useState<ItemRow>()
  const [err, setErr] = useState<ApiFail>()
  const [busy, setBusy] = useState(false)

  async function find() {
    setErr(undefined); setItem(undefined); setHits(undefined); setBusy(true)
    const r = await api<{ rows: ItemRow[] }>('GET', `/api/v1/keys?code=${encodeURIComponent(code.trim())}&limit=10`)
    setBusy(false)
    if (!r.ok) { setErr(r); return }
    setHits(r.data.rows)
    if (r.data.rows.length === 1) setItem(r.data.rows[0])
  }
  const reset = () => { setCode(''); setHits(undefined); setItem(undefined); setErr(undefined) }
  const ref = item ? { id: item.id, code: item.code, label: `${item.itemTypeLabel} ${item.code}`, status: item.status } : undefined

  return (
    <GlassCard title="Issue or return" subtitle="Type or scan the code on the tag." strong>
      <div className="stack" style={{ gap: 12 }}>
        <form className="form" noValidate onSubmit={e => { e.preventDefault(); if (code.trim()) void find() }}>
          <Field label="Key or asset code" error={err?.reason}>
            <Input value={code} onChange={e => { setCode(e.target.value); setHits(undefined); setItem(undefined) }} autoComplete="off" autoCapitalize="characters" placeholder="K-12" />
          </Field>
          <div className="row wrap"><Button variant="primary" type="submit" disabled={busy || !code.trim()}>Find</Button>{(hits || item) && <Button variant="ghost" onClick={reset}>Clear</Button>}</div>
        </form>

        {hits && hits.length === 0 && <Blocked why={`No key or asset with the code "${code.trim()}" in your sites`} owner="Accommodation Admin" next="Check the tag, or ask for it to be added under Keys › Add" />}
        {hits && hits.length > 1 && !item && (
          <ul className="list-plain" aria-label="Matching items">
            {hits.map(h => <li key={h.id}><span style={{ flex: 1 }}><b>{h.code}</b> <span className="muted body-sm">{h.itemTypeLabel} · {h.siteName}</span></span><StatusChip status={h.status} /><Button size="sm" onClick={() => setItem(h)}>Open</Button></li>)}
          </ul>
        )}

        {item && ref && (
          <div className="stack" style={{ gap: 10 }} data-testid="desk-item">
            <div className="row wrap"><b>{item.code}</b><span className="muted">{item.itemTypeLabel}{item.forLabel ? ` · ${item.forLabel}` : ''} · {item.siteName}</span><StatusChip status={item.status} /><OverdueBadge o={item.overdue} /></div>
            {item.status === 'issued' && item.holder && (
              <p className="body-sm">With <b>{item.holder.name}</b> <span className="muted">{item.holder.employeeId}</span>{item.holder.left && ' (has left)'}{item.dueBack ? ` · due back ${fmtDate(item.dueBack)}` : ''}</p>
            )}
            {item.status === 'in_cabinet' && <IssueForm item={ref} today={today} onDone={reset} />}
            {item.status === 'issued' && <ReturnForm item={ref} holder={item.holder?.name} holderLeft={item.holder?.left} onDone={reset} />}
            {(item.status === 'lost' || item.status === 'damaged') && (
              <Blocked why={`This item is ${item.status}${item.holder ? ` and still counted against ${item.holder.name}` : ''}. It is never marked returned`} owner="Accommodation Admin" next={item.status === 'lost' ? 'Open it to mark it found, or to replace or retire it' : 'Open it to replace or retire it'} />
            )}
            {item.status === 'retired' && <Alert tone="info" title="This item is retired" detail="It cannot be issued. Choose another from the cabinet." />}
            <div><Link href={`/keys/${item.id}`} className="btn ghost sm" style={{ textDecoration: 'none' }}>Open the item page</Link></div>
          </div>
        )}
      </div>
    </GlassCard>
  )
}
