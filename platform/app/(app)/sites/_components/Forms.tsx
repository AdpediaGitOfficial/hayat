'use client'
/** Create and edit forms for sites, buildings, rooms and beds. Each one posts to the API and shows a refusal with its reason, owner and next action. */
import { useRouter } from 'next/navigation'
import { useMemo, useState, type FormEvent } from 'react'
import { Button, Field, GlassCard, Input, Modal, Select } from '@/ui'
import { Problem, useCall } from './common'
import { GENDER_LABEL, SITE_KIND_LABEL } from './state'

const zones = (): string[] => {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone') } catch { return [] }
}
const submitForm = (id: string) => (document.getElementById(id) as HTMLFormElement | null)?.requestSubmit()
const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/* ---------------- site ---------------- */

export function AddSiteButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button icon="plus" onClick={() => setOpen(true)}>Add site</Button>
      {open && <SiteModal onClose={() => setOpen(false)} />}
    </>
  )
}

export function EditSiteButton({ site }: { site: { id: string; code: string; name: string; kind: 'villa' | 'apartment' | 'other'; timeZone: string } }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button icon="settings" onClick={() => setOpen(true)}>Edit site</Button>
      {open && <SiteModal site={site} onClose={() => setOpen(false)} />}
    </>
  )
}

function SiteModal({ site, onClose }: { site?: { id: string; code: string; name: string; kind: 'villa' | 'apartment' | 'other'; timeZone: string }; onClose: () => void }) {
  const router = useRouter()
  const { run, busy, err } = useCall()
  const [code, setCode] = useState(site?.code ?? '')
  const [name, setName] = useState(site?.name ?? '')
  const [kind, setKind] = useState(site?.kind ?? 'villa')
  const [timeZone, setTimeZone] = useState(site?.timeZone ?? 'UTC')
  const tzs = useMemo(zones, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (site) {
      if (await run('PATCH', `/api/v1/property/sites/${site.id}`, { name, kind, timeZone })) onClose()
    } else {
      await run<{ id: string }>('POST', '/api/v1/property/sites', { code, name, kind, timeZone }, r => { onClose(); router.push(`/sites/${r.data.id}`) })
    }
  }
  return (
    <Modal open onClose={onClose} title={site ? 'Edit site' : 'Add site'} subtitle="Super Admin only"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !name || (!site && !code)} onClick={() => submitForm('site-form')}>{site ? 'Save' : 'Create site'}</Button></>}>
      <form id="site-form" className="form" onSubmit={submit} noValidate>
        {err && <Problem f={err} />}
        <Field label="Code" hint={site ? 'The code is the business key and cannot be changed' : 'Short and unique, for example PV'} error={err?.fields?.code}>
          <Input value={code} onChange={e => setCode(e.target.value)} disabled={!!site} autoCapitalize="characters" />
        </Field>
        <Field label="Name" error={err?.fields?.name}><Input value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Property type" error={err?.fields?.kind}>
          <Select value={kind} onChange={e => setKind(e.target.value as 'villa')}>
            {(Object.keys(SITE_KIND_LABEL) as (keyof typeof SITE_KIND_LABEL)[]).map(k => <option key={k} value={k}>{SITE_KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label="Time zone" hint="Dates such as “today” follow the site’s own time zone. Example: Asia/Dubai" error={err?.fields?.timeZone}>
          <Input list="tz-list" value={timeZone} onChange={e => setTimeZone(e.target.value)} autoCapitalize="none" />
        </Field>
        <datalist id="tz-list">{tzs.map(z => <option key={z} value={z} />)}</datalist>
      </form>
    </Modal>
  )
}

/* ---------------- building ---------------- */

export function AddBuildingButton({ siteId }: { siteId: string }) {
  const [open, setOpen] = useState(false)
  const { run, busy, err, clearError } = useCall()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const close = () => { setOpen(false); clearError() }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (await run('POST', '/api/v1/property/buildings', { siteId, code, name })) { setCode(''); setName(''); close() }
  }
  return (
    <>
      <Button icon="building" onClick={() => setOpen(true)}>Add building</Button>
      <Modal open={open} onClose={close} title="Add building" subtitle="Super Admin, or an Accommodation Admin with the Building Creation capability, within assigned sites"
        footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={busy || !code || !name} onClick={() => submitForm('building-form')}>Create building</Button></>}>
        <form id="building-form" className="form" onSubmit={submit} noValidate>
          {err && <Problem f={err} />}
          <Field label="Code" hint="Unique within the site, for example A" error={err?.fields?.code}><Input value={code} onChange={e => setCode(e.target.value)} autoCapitalize="characters" /></Field>
          <Field label="Name" hint="For example Block A" error={err?.fields?.name}><Input value={name} onChange={e => setName(e.target.value)} /></Field>
        </form>
      </Modal>
    </>
  )
}

export function EditBuildingForm({ building, canEdit }: { building: { id: string; code: string; name: string }; canEdit: boolean }) {
  const { run, busy, err } = useCall()
  const [code, setCode] = useState(building.code)
  const [name, setName] = useState(building.name)
  const dirty = code !== building.code || name !== building.name
  return (
    <GlassCard title="Details" subtitle={canEdit ? undefined : 'Only a Super Admin can edit a building'}>
      <form className="form" onSubmit={e => { e.preventDefault(); void run('PATCH', `/api/v1/property/buildings/${building.id}`, { code, name }) }} noValidate>
        {err && <Problem f={err} />}
        <div className="grid even">
          <Field label="Code" error={err?.fields?.code}><Input value={code} onChange={e => setCode(e.target.value)} disabled={!canEdit} /></Field>
          <Field label="Name" error={err?.fields?.name}><Input value={name} onChange={e => setName(e.target.value)} disabled={!canEdit} /></Field>
        </div>
        {canEdit && <div><Button variant="primary" type="submit" disabled={busy || !dirty || !code || !name}>Save changes</Button></div>}
      </form>
    </GlassCard>
  )
}

/* ---------------- room ---------------- */

export function AddRoomButton({ siteId, siteCode, buildings, defaultBuildingId }: {
  siteId: string; siteCode: string; buildings: { id: string; name: string }[]; defaultBuildingId?: string
}) {
  const [open, setOpen] = useState(false)
  const { run, busy, err, clearError } = useCall()
  const router = useRouter()
  const [buildingId, setBuildingId] = useState(defaultBuildingId ?? '')
  const [floor, setFloor] = useState('')
  const [unit, setUnit] = useState('')
  const [name, setName] = useState('')
  const [genderPolicy, setGender] = useState<'any' | 'male' | 'female'>('any')
  const [count, setCount] = useState(2)
  const [prefix, setPrefix] = useState('')
  const autoPrefix = slug(`${siteCode} ${name}`)
  const pfx = prefix || autoPrefix
  const bedCodes = Array.from({ length: Math.max(0, Math.min(12, count)) }, (_, i) => `${pfx}-${i + 1}`)
  const close = () => { setOpen(false); clearError() }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const body = { siteId, buildingId: buildingId || null, floor, unit, name, genderPolicy, bedCodes }
    await run<{ id: string }>('POST', '/api/v1/property/rooms', body, r => { setName(''); close(); router.push(`/sites/${siteId}/rooms/${r.data.id}`) })
  }
  return (
    <>
      <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Add room</Button>
      <Modal open={open} onClose={close} title="Add room and beds" subtitle="Accommodation Admin, within assigned sites"
        footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={busy || !name} onClick={() => submitForm('room-form')}>Create room</Button></>}>
        <form id="room-form" className="form" onSubmit={submit} noValidate>
          {err && <Problem f={err} />}
          <Field label="Room name" hint="For example 101" error={err?.fields?.name}><Input value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label="Building" hint="Optional: a villa can be Site › Room › Bed" optional error={err?.fields?.buildingId}>
            <Select value={buildingId} onChange={e => setBuildingId(e.target.value)}>
              <option value="">None (the room sits directly in the site)</option>
              {buildings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
          <div className="grid even">
            <Field label="Floor" optional error={err?.fields?.floor}><Input value={floor} onChange={e => setFloor(e.target.value)} /></Field>
            <Field label="Unit" optional error={err?.fields?.unit}><Input value={unit} onChange={e => setUnit(e.target.value)} /></Field>
          </div>
          <Field label="Room gender policy" error={err?.fields?.genderPolicy}>
            <Select value={genderPolicy} onChange={e => setGender(e.target.value as 'any')}>
              {(Object.keys(GENDER_LABEL) as (keyof typeof GENDER_LABEL)[]).map(g => <option key={g} value={g}>{GENDER_LABEL[g]}</option>)}
            </Select>
          </Field>
          <div className="grid even">
            <Field label="Number of beds" hint="Up to 12 now; add more later" error={err?.fields?.bedCodes}>
              <Input type="number" min={0} max={12} value={count} onChange={e => setCount(Number(e.target.value))} />
            </Field>
            <Field label="Bed code prefix" hint="Bed codes are unique within the site" optional>
              <Input value={prefix} placeholder={autoPrefix} onChange={e => setPrefix(e.target.value)} />
            </Field>
          </div>
          {bedCodes.length > 0 && <div className="hint-box">Beds to create: {bedCodes.join(', ')}</div>}
        </form>
      </Modal>
    </>
  )
}

export function EditRoomForm({ room, canEdit }: {
  room: { id: string; name: string; floor: string | null; unit: string | null; genderPolicy: 'any' | 'male' | 'female' }; canEdit: boolean
}) {
  const { run, busy, err } = useCall()
  const [name, setName] = useState(room.name)
  const [floor, setFloor] = useState(room.floor ?? '')
  const [unit, setUnit] = useState(room.unit ?? '')
  const [gender, setGender] = useState(room.genderPolicy)
  const dirty = name !== room.name || floor !== (room.floor ?? '') || unit !== (room.unit ?? '') || gender !== room.genderPolicy
  return (
    <GlassCard title="Details" subtitle={canEdit ? 'The gender policy cannot change while residents or bookings are in the room' : 'You can view this room but not edit it'}>
      <form className="form" onSubmit={e => { e.preventDefault(); void run('PATCH', `/api/v1/property/rooms/${room.id}`, { name, floor, unit, genderPolicy: gender }) }} noValidate>
        {err && <Problem f={err} />}
        <Field label="Room name" error={err?.fields?.name}><Input value={name} onChange={e => setName(e.target.value)} disabled={!canEdit} /></Field>
        <div className="grid even">
          <Field label="Floor" optional error={err?.fields?.floor}><Input value={floor} onChange={e => setFloor(e.target.value)} disabled={!canEdit} /></Field>
          <Field label="Unit" optional error={err?.fields?.unit}><Input value={unit} onChange={e => setUnit(e.target.value)} disabled={!canEdit} /></Field>
        </div>
        <Field label="Room gender policy" error={err?.fields?.genderPolicy}>
          <Select value={gender} onChange={e => setGender(e.target.value as 'any')} disabled={!canEdit}>
            {(Object.keys(GENDER_LABEL) as (keyof typeof GENDER_LABEL)[]).map(g => <option key={g} value={g}>{GENDER_LABEL[g]}</option>)}
          </Select>
        </Field>
        {canEdit && <div><Button variant="primary" type="submit" disabled={busy || !dirty || !name}>Save changes</Button></div>}
      </form>
    </GlassCard>
  )
}

/* ---------------- bed ---------------- */

export function AddBedForm({ roomId, suggestion }: { roomId: string; suggestion: string }) {
  const { run, busy, err } = useCall()
  const [code, setCode] = useState('')
  return (
    <GlassCard title="Add a bed" subtitle="It starts Available. Bed codes are unique within the site">
      <form className="form" onSubmit={async e => { e.preventDefault(); if (await run('POST', '/api/v1/property/beds', { roomId, code })) setCode('') }} noValidate>
        {err && <Problem f={err} />}
        <Field label="Bed code" error={err?.fields?.code}><Input value={code} placeholder={suggestion} onChange={e => setCode(e.target.value)} /></Field>
        <div><Button variant="primary" type="submit" icon="plus" disabled={busy || !code}>Add bed</Button></div>
      </form>
    </GlassCard>
  )
}
