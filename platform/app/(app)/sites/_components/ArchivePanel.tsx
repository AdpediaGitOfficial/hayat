'use client'
/**
 * Archive with the dependencies in plain sight (AT-029, D-93): what stops it, who owns each item and what to do next are shown
 * BEFORE the click, from the same checkers the command uses. The command checks again under row locks, so a stale screen can
 * never archive something that has since been reserved; if that happens the refusal is shown here with the fresh list.
 */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Button, Check, Field, GlassCard, Textarea, useToast } from '@/ui'
import { api } from '@/ui/api'
import type { ArchivePreview } from '@/server/queries/property/archivePreview'
import { BlockerList, Problem, useCall } from './common'

const BASE = { bed: 'beds', room: 'rooms', building: 'buildings' } as const

export function ArchivePanel({ kind, id, preview: initial, canArchive, parentHref, childWord }: {
  kind: 'bed' | 'room' | 'building'
  id: string
  preview: ArchivePreview | undefined
  /** Does the actor's role hold the archive action for this kind (building: Super Admin only)? */
  canArchive: boolean
  /** Where to go once it is archived. */
  parentHref: string
  /** "beds" or "rooms and beds", for the cascade option. */
  childWord?: string
}) {
  const router = useRouter()
  const toast = useToast()
  const { run, busy, err } = useCall()
  const [preview, setPreview] = useState(initial)
  const [reason, setReason] = useState('')
  const [cascade, setCascade] = useState(false)
  const path = `/api/v1/property/${BASE[kind]}/${id}/archive`

  if (!canArchive) {
    return (
      <GlassCard title="Archive" subtitle={kind === 'building' ? 'Only a Super Admin can archive a building' : 'Your role cannot archive this'}>
        <p className="muted body-sm">Archive is the only way to retire something. Nothing is ever deleted.</p>
      </GlassCard>
    )
  }
  if (!preview) return null
  if (preview.alreadyArchived) return <Alert tone="info" title={`${preview.label} is archived`} detail="It is kept for the history and the audit trail. Nothing was deleted." />

  async function toggleCascade(on: boolean) {
    setCascade(on)
    const r = await api<ArchivePreview>('GET', `${path}${on ? '?cascade=1' : ''}`)
    if (r.ok) setPreview(r.data)
    else toast(r.reason, true)
  }

  async function archive() {
    await run('POST', path, { reason, ...(kind === 'bed' ? {} : { cascade }) }, () => router.push(parentHref))
  }

  const children = kind === 'bed' ? undefined : childWord
  return (
    <GlassCard title="Archive" subtitle="Archive is final and nothing is deleted: the record and its history stay, but it can no longer be used.">
      <div className="stack">
        {preview.blockers.length > 0 ? (
          <>
            <Alert tone="warning" title={`${preview.label} can't be archived yet`} detail={`${preview.summary}. Resolve each item, then archive.`} />
            <BlockerList blockers={preview.blockers} total={preview.total} truncated={preview.truncated} />
          </>
        ) : (
          <Alert tone="success" title="Nothing is in the way" detail="No resident, reservation, bed offer or open task depends on this." />
        )}
        {children && (
          <Check checked={cascade} onChange={toggleCascade}>Archive the active {children} below it together with it</Check>
        )}
        {err && <Problem f={err} />}
        <Field label="Reason for archiving" hint="Required. It goes into the audit log." error={err?.fields?.reason}>
          <Textarea value={reason} onChange={e => setReason(e.target.value)} />
        </Field>
        <div className="row">
          <Button variant="danger" icon="ban" onClick={archive} disabled={busy || !preview.archivable || reason.trim().length < 3}>Archive {kind}</Button>
          {!preview.archivable && <span className="muted body-sm">Archive is available once the items above are resolved.</span>}
        </div>
      </div>
    </GlassCard>
  )
}
