'use client'
import { Alert } from '@/ui'
import type { ApiFail } from '@/ui/api'

/** A failed API call as the user should read it: what happened, who owns the next step, and what to do (D-93). */
export function Problem({ f }: { f: ApiFail }) {
  return <Alert tone="danger" title={f.reason} detail={[f.owner && `Owner: ${f.owner}`, f.next && `Next: ${f.next}`].filter(Boolean).join(' · ') || undefined} />
}
