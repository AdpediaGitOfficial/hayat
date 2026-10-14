'use client'
/** Calling the API from the housekeeping screens, and showing a refusal as reason + owner + next action (D-93). */
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { Alert, Button, useToast } from '@/ui'
import { api, type ApiFail, type ApiResult } from '@/ui/api'

export function Problem({ f }: { f: ApiFail }) {
  return <Alert tone="danger" title={f.reason} detail={[f.owner && `Owner: ${f.owner}`, f.next && `Next: ${f.next}`].filter(Boolean).join(' · ') || undefined} />
}

/** One API call with busy and error state; on success it toasts the server's message and refreshes the page data. */
export function useCall() {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()

  async function run<T = unknown>(method: 'GET' | 'POST', path: string, body: unknown, after?: (r: Extract<ApiResult<T>, { ok: true }>) => void): Promise<boolean> {
    setBusy(true); setErr(undefined)
    const r = await api<T>(method, path, body)
    setBusy(false)
    if (!r.ok) { setErr(r); return false }
    toast(r.message ?? 'Saved')
    after?.(r)
    router.refresh()
    return true
  }
  return { run, busy, err, setErr, clearError: () => setErr(undefined) }
}

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
  r.onerror = () => reject(new Error('Could not read the file'))
  r.readAsDataURL(file)
})

export interface Uploaded { id: string; filename: string }

/**
 * Photos for a task: each file is sent to /api/v1/attachments on that task (PNG, JPEG or PDF, checked by content on the server)
 * and the ids are handed to the command afterwards. Works with the phone camera.
 */
export function PhotoPicker({ taskId, files, onChange, label = 'Add a photo' }: { taskId: string; files: Uploaded[]; onChange: (f: Uploaded[]) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()
  async function pick(list: FileList | null) {
    if (!list || list.length === 0) return
    setBusy(true); setErr(undefined)
    let next = files
    for (const file of Array.from(list)) {
      const r = await api<{ id: string; filename: string }>('POST', '/api/v1/attachments', { entityType: 'cleaning_task', entityId: taskId, filename: file.name || 'photo', dataBase64: await readBase64(file).catch(() => '') })
      if (!r.ok) { setErr(r); break }
      next = [...next, { id: r.data.id, filename: r.data.filename }]
    }
    onChange(next)
    setBusy(false)
    if (input.current) input.current.value = ''
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      {err && <Problem f={err} />}
      <div className="row wrap">
        <input ref={input} type="file" accept="image/png,image/jpeg,application/pdf" multiple hidden onChange={e => void pick(e.target.files)} data-testid="photo-input" />
        <Button variant="secondary" icon="upload" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : label}</Button>
        {files.map(f => <span key={f.id} className="badge neutral">{f.filename}</span>)}
      </div>
    </div>
  )
}
