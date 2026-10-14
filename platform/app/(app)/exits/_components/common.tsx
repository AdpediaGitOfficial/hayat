'use client'
/** Calling the exit API from the screens, and showing a refusal as reason + owner + next action (D-93). */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, useToast } from '@/ui'
import { api, type ApiFail, type ApiResult } from '@/ui/api'

export function Problem({ f }: { f: ApiFail }) {
  const detail = [f.owner && `Owner: ${f.owner}`, f.next && `Next: ${f.next}`].filter(Boolean).join(' · ') || undefined
  return <Alert tone="danger" title={f.reason} detail={detail} />
}

/** One API call with busy and error state; on success it toasts the server's message and refreshes the page data. */
export function useCall() {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()

  async function run<T = unknown>(path: string, body: unknown, after?: (r: Extract<ApiResult<T>, { ok: true }>) => void): Promise<boolean> {
    setBusy(true); setErr(undefined)
    const r = await api<T>('POST', path, body)
    setBusy(false)
    if (!r.ok) { setErr(r); return false }
    toast(r.message ?? 'Done')
    after?.(r)
    router.refresh()
    return true
  }
  return { run, busy, err, clear: () => setErr(undefined), setErr }
}
