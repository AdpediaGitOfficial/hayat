'use client'
/** Calling the API from the emergency screens, and showing a refusal as reason + owner + next action (D-93). */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, useToast } from '@/ui'
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
  return { run, busy, err, clearError: () => setErr(undefined) }
}
