import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { getBedDetail } from '@/server/queries/property/detail'
import { previewArchive } from '@/server/queries/property/archivePreview'
import { Badge, Blocked, GlassCard, PageHeader, Status } from '@/ui'
import { fmtDate, fmtDateLong } from '@/domain/time'
import { ArchivePanel } from '../../../_components/ArchivePanel'
import { BedActions } from '../../../_components/BedActions'
import { CLAIM_LABEL, fmtClaimRange, GENDER_LABEL, STATE_NAME, STATE_STATUS, stateExplanation } from '../../../_components/state'

export default async function BedPage({ params }: { params: { siteId: string; bedId: string } }) {
  const cur = await requirePage('rooms_beds.view')
  const { actor } = cur.rc
  const bed = await getBedDetail(actor, params.bedId)
  if (!bed || bed.site.id !== params.siteId) notFound()
  const siteId = bed.site.id
  const canBlock = can(actor, 'rooms_beds.block', { siteId })
  const canManage = can(actor, 'rooms_beds.manage', { siteId })
  const prev = canManage && !bed.archived ? await previewArchive(actor, 'bed', bed.id) : undefined
  const explain = stateExplanation(bed.state, { reason: bed.block?.reason ?? bed.stateReason, until: bed.block?.until ?? null, today: bed.today })
  const path = [bed.site.name, bed.building?.name, bed.room.floor && `Floor ${bed.room.floor}`, bed.room.unit && `Unit ${bed.room.unit}`, `Room ${bed.room.name}`, bed.code].filter(Boolean) as string[]

  return (
    <>
      <PageHeader crumbs={path} title={`Bed ${bed.code}`}
        summary={<span className="row wrap"><Status s={STATE_STATUS[bed.state]} /><Badge outline>{GENDER_LABEL[bed.room.genderPolicy]} room</Badge>
          <span className="muted body-sm">{STATE_NAME[bed.state]} since {fmtDateLong(bed.stateSince.slice(0, 10))}</span></span>}
        actions={<><Link href={`/sites/${siteId}/rooms/${bed.room.id}`} className="btn" style={{ textDecoration: 'none' }}>Open room</Link><Link href={`/sites/${siteId}`} className="btn" style={{ textDecoration: 'none' }}>Back to site</Link></>} />
      {explain && bed.state !== 'available' && <Blocked {...explain} />}
      <div className="grid two">
        <div className="stack">
          <GlassCard title="Reservations and stays" subtitle="Dated claims sit alongside the physical state: a bed can be Available today and reserved from next week">
            {bed.claims.length === 0 ? <p className="muted">Nothing is booked on this bed.</p> : (
              <ul className="list-plain">
                {bed.claims.map(c => (
                  <li key={c.claimId} style={{ flexWrap: 'wrap' }}>
                    <span style={{ flex: 1, minWidth: 180 }}>
                      <b>{CLAIM_LABEL[c.kind]}</b>
                      {c.holder && <span> · {c.holder.name} <span className="muted">({c.holder.employeeId})</span></span>}
                      <span className="muted body-sm" style={{ display: 'block' }}>{fmtClaimRange(c.from, c.to)}</span>
                    </span>
                    {c.from <= bed.today && <Badge tone="brand">Current</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>
          <GlassCard title="Block history" subtitle="Every block and when it was lifted">
            {bed.history.length === 0 ? <p className="muted">This bed has never been blocked.</p> : (
              <ul className="list-plain">
                {bed.history.map((h, i) => (
                  <li key={i} style={{ flexWrap: 'wrap' }}>
                    <span style={{ flex: 1, minWidth: 180 }}>{h.reason}<span className="muted body-sm" style={{ display: 'block' }}>
                      Blocked {fmtDate(h.blockedAt.slice(0, 10))}{h.until ? ` · until ${fmtDate(h.until)} (last blocked day)` : ' · until further notice'}</span></span>
                    {h.releasedAt ? <Badge tone="success">Lifted {fmtDate(h.releasedAt.slice(0, 10))}</Badge> : <Badge tone="neutral">In force</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>
        </div>
        <div className="stack" style={{ alignSelf: 'start' }}>
          <BedActions bedId={bed.id} code={bed.code} state={bed.state} today={bed.today} canBlock={canBlock} />
          {canManage && !bed.archived && (
            <ArchivePanel kind="bed" id={bed.id} preview={prev?.ok ? prev.data : undefined} canArchive={canManage} parentHref={`/sites/${siteId}/rooms/${bed.room.id}`} />
          )}
        </div>
      </div>
    </>
  )
}
