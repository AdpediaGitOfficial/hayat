'use client'
/** Evidence for a clearance item: a PNG, JPEG or PDF up to the configured size, uploaded to the item through the attachment service. */
import { useRef, useState } from 'react'
import { Button } from '@/ui'
import { api, type ApiFail } from '@/ui/api'
import { Problem } from './common'

export interface Uploaded { id: string; filename: string }

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('Could not read the file'))
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.readAsDataURL(file)
  })
}

export function EvidenceUpload({ itemId, files, onChange }: { itemId: string; files: Uploaded[]; onChange: (f: Uploaded[]) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()

  async function pick(file: File | undefined) {
    if (!file) return
    setBusy(true); setErr(undefined)
    try {
      const r = await api<Uploaded>('POST', '/api/v1/attachments', { entityType: 'clearance_item', entityId: itemId, filename: file.name, dataBase64: await toBase64(file) })
      if (r.ok) onChange([...files, { id: r.data.id, filename: r.data.filename }]); else setErr(r)
    } catch {
      setErr({ ok: false, code: 'invalid', reason: 'Could not read the file', next: 'Choose the file again', requestId: '' })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {err && <Problem f={err} />}
      {files.length > 0 && (
        <ul className="list-plain" aria-label="Attached evidence">
          {files.map(f => <li key={f.id}><span style={{ flex: 1 }}>{f.filename}</span><Button size="sm" variant="ghost" onClick={() => onChange(files.filter(x => x.id !== f.id))}>Leave out</Button></li>)}
        </ul>
      )}
      <input ref={input} type="file" accept="image/png,image/jpeg,application/pdf" hidden aria-label="Evidence file" data-testid="evidence-input" onChange={e => void pick(e.target.files?.[0])} />
      <div><Button size="sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : 'Attach a photo or PDF'}</Button></div>
    </div>
  )
}
