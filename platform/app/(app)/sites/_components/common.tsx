'use client'
/** Small pieces every property form uses: calling the API, and showing a refusal as reason + owner + next action (D-93). */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Blocked, useToast } from '@/ui'
import { api, type ApiFail, type ApiResult } from '@/ui/api'
import type { Blocker } from '@/server/commands/property/dependencies'

export function blockersOf(f: ApiFail | undefined): Blocker[] {
  const d = f?.detail as { blockers?: Blocker[] } | undefined
  return d?.blockers ?? []
}

/** The list of things standing in the way, each with what it is, who owns it and what to do next (AT-029). */
export function BlockerList({ blockers, total, truncated }: { blockers: Blocker[]; total?: number; truncated?: boolean }) {
  if (blockers.length === 0) return null
  return (
    <ul className="list-plain" aria-label="Dependencies that block this">
      {blockers.map((b, i) => (
        <li key={`${b.entityId}-${b.kind}-${i}`} style={{ display: 'block' }}>
          <div className="row" style={{ marginBottom: 4 }}><b>{b.label}</b></div>
          <Blocked why={b.why} owner={b.owner} next={b.next} />
        </li>
      ))}
      {truncated && <li className="muted body-sm">Showing the first {blockers.length} of {total}.</li>}
    </ul>
  )
}

export function Problem({ f }: { f: ApiFail }) {
  const detail = [f.owner && `Owner: ${f.owner}`, f.next && `Next: ${f.next}`].filter(Boolean).join(' · ') || undefined
  const d = f.detail as { total?: number; truncated?: boolean } | undefined
  return (
    <div className="stack" style={{ gap: 12 }}>
      <Alert tone="danger" title={f.reason} detail={detail} />
      <BlockerList blockers={blockersOf(f)} total={d?.total} truncated={d?.truncated} />
    </div>
  )
}

/** Runs one API call with busy and error state; on success it toasts the server's message and refreshes the page data. */
export function useCall() {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<ApiFail>()

  async function run<T = unknown>(method: 'POST' | 'PATCH', path: string, body: unknown, after?: (r: Extract<ApiResult<T>, { ok: true }>) => void): Promise<boolean> {
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
