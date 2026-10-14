'use client'
/**
 * Add keys and assets to a site's cabinet: one at a time, or many with a prefix and a count (or a pasted list of codes) and a
 * per-row result. The type list is configuration (D-72 is open); a room key and a bed locker key are both just items linked to a room or a bed.
 */
import Link from 'next/link'
import { useState } from 'react'
import { Alert, Badge, Button, Field, GlassCard, Input, Select, Tabs, Textarea } from '@/ui'
import type { BulkOut } from '@/server/commands/keys/registry'
import type { LinkOptions } from '@/server/queries/keys/items'
import { Problem, useCall } from './call'

export interface TypeOption { id: string; label: string; category: 'key' | 'asset' }

export function NewItemForm({ types, options }: { types: TypeOption[]; options: LinkOptions }) {
  const { run, busy, err } = useCall()
  const [mode, setMode] = useState<'one' | 'many'>('one')
  const [siteId, setSiteId] = useState(options.sites[0]?.id ?? '')
  const [itemType, setItemType] = useState(types[0]?.id ?? '')
  const [link, setLink] = useState<'none' | 'room' | 'bed'>('none')
  const [target, setTarget] = useState('')
  const [code, setCode] = useState('')
  const [note, setNote] = useState('')
  const [prefix, setPrefix] = useState('')
  const [count, setCount] = useState('')
  const [list, setList] = useState('')
  const [way, setWay] = useState<'count' | 'list'>('count')
  const [result, setResult] = useState<BulkOut>()
  const [madeId, setMadeId] = useState<string>()

  const category = types.find(t => t.id === itemType)?.category ?? 'key'
  const places = link === 'room' ? options.rooms.filter(r => r.siteId === siteId) : link === 'bed' ? options.beds.filter(b => b.siteId === siteId) : []
  const links = { roomId: link === 'room' && target ? target : null, bedId: link === 'bed' && target ? target : null }
  const base = { siteId, category, itemType, ...links, note: note || null }
  const codes = list.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
  const ready = !!siteId && !!itemType && (link === 'none' || !!target) && (mode === 'one' ? !!code.trim() : way === 'count' ? Number(count) >= 1 : codes.length > 0)

  if (options.sites.length === 0) {
    return <Alert tone="warning" title="You do not manage keys at any site" detail="Only the Accommodation Admin and the Super Admin add keys and assets." />
  }

  return (
    <GlassCard title="Add keys and assets" subtitle="They start in the cabinet. Codes are unique per site and category, ignoring capitals.">
      <div className="stack" style={{ gap: 14 }}>
        <Tabs options={[{ id: 'one', label: 'One item' }, { id: 'many', label: 'Many at once' }]} value={mode} onChange={m => { setMode(m); setResult(undefined); setMadeId(undefined) }} />
        <form className="form" noValidate onSubmit={e => {
          e.preventDefault()
          setResult(undefined); setMadeId(undefined)
          if (mode === 'one') void run<{ id: string }>('POST', '/api/v1/keys', { ...base, code }, r => { setCode(''); setMadeId(r.data.id) })
          else void run<BulkOut>('POST', '/api/v1/keys/bulk', way === 'count' ? { ...base, prefix, count: Number(count) } : { ...base, codes }, r => setResult(r.data))
        }}>
          {err && <Problem f={err} />}
          {options.sites.length > 1 && (
            <Field label="Site" error={err?.fields?.siteId}>
              <Select value={siteId} onChange={e => { setSiteId(e.target.value); setTarget('') }}>{options.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
            </Field>
          )}
          <Field label="Type" hint="The list of types is set in Configuration." error={err?.fields?.itemType}>
            <Select value={itemType} onChange={e => setItemType(e.target.value)}>{types.map(t => <option key={t.id} value={t.id}>{t.label} ({t.category})</option>)}</Select>
          </Field>
          <Field label="Belongs to" hint="A room key belongs to a room; a bed locker key to a bed. Leave 'Nothing' for an access card.">
            <Select value={link} onChange={e => { setLink(e.target.value as 'none' | 'room' | 'bed'); setTarget('') }}>
              <option value="none">Nothing in particular</option><option value="room">A room</option><option value="bed">A bed</option>
            </Select>
          </Field>
          {link !== 'none' && (
            <Field label={link === 'room' ? 'Room' : 'Bed'} error={err?.fields?.roomId ?? err?.fields?.bedId}>
              <Select value={target} onChange={e => setTarget(e.target.value)}>
                <option value="">Choose…</option>
                {places.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </Field>
          )}
          {mode === 'one'
            ? <Field label="Code" hint="The number or tag on the item." error={err?.fields?.code}><Input value={code} onChange={e => setCode(e.target.value)} maxLength={40} autoComplete="off" /></Field>
            : <>
              <Tabs options={[{ id: 'count', label: 'Prefix and count' }, { id: 'list', label: 'List of codes' }]} value={way} onChange={setWay} />
              {way === 'count'
                ? <div className="row wrap" style={{ gap: 12 }}>
                  <Field label="Prefix" optional hint="R12- gives R12-01, R12-02…"><Input value={prefix} onChange={e => setPrefix(e.target.value)} maxLength={30} /></Field>
                  <Field label="How many" error={err?.fields?.count ?? err?.fields?.codes}><Input type="number" min={1} max={200} value={count} onChange={e => setCount(e.target.value)} /></Field>
                </div>
                : <Field label="Codes" hint="One per line, or separated by commas. Up to 200." error={err?.fields?.codes}><Textarea rows={6} value={list} onChange={e => setList(e.target.value)} /></Field>}
            </>}
          <Field label="Note" optional><Input value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
          <div><Button variant="primary" type="submit" tall block disabled={busy || !ready}>{mode === 'one' ? 'Add to the cabinet' : 'Add them all'}</Button></div>
        </form>

        {madeId && <Alert tone="success" title="Added to the cabinet" action={<Link href={`/keys/${madeId}`} className="btn secondary sm" style={{ textDecoration: 'none' }}>Open it</Link>} />}
        {result && (
          <div className="stack" style={{ gap: 8 }} data-testid="bulk-result">
            <Alert tone={result.failed === 0 ? 'success' : 'warning'} title={`${result.created} added, ${result.failed} not added`} />
            <ul className="list-plain" aria-label="Result per code">
              {result.rows.map((r, i) => (
                <li key={`${r.code}-${i}`}><span style={{ flex: 1 }} className="mono">{r.code}</span>{r.ok ? <Badge tone="success">Added</Badge> : <Badge tone="danger">{r.error ?? 'Not added'}</Badge>}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </GlassCard>
  )
}
