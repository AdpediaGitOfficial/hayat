import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { getRoomDetail } from '@/server/queries/property/detail'
import { previewArchive } from '@/server/queries/property/archivePreview'
import { Badge, GlassCard, PageHeader, Status } from '@/ui'
import { fmtDate } from '@/domain/time'
import { ArchivePanel } from '../../../_components/ArchivePanel'
import { AddBedForm, EditRoomForm } from '../../../_components/Forms'
import { bedTileClass, GENDER_LABEL, STATE_STATUS } from '../../../_components/state'

export default async function RoomPage({ params }: { params: { siteId: string; roomId: string } }) {
  const cur = await requirePage('rooms_beds.view')
  const { actor } = cur.rc
  const room = await getRoomDetail(actor, params.roomId)
  if (!room || room.site.id !== params.siteId) notFound()
  const siteId = room.site.id
  const canManage = can(actor, 'rooms_beds.manage', { siteId })
  const prev = canManage && !room.archived ? await previewArchive(actor, 'room', room.id) : undefined
  const crumbs = [room.site.name, room.building?.name, room.floor && `Floor ${room.floor}`, room.unit && `Unit ${room.unit}`, `Room ${room.name}`].filter(Boolean) as string[]
  const activeBeds = room.beds.filter(b => !b.archived)

  return (
    <>
      <PageHeader crumbs={crumbs} title={`Room ${room.name}`}
        summary={<span className="row wrap"><Badge outline>{GENDER_LABEL[room.genderPolicy]}</Badge>{room.archived && <Badge tone="neutral">Archived</Badge>}
          <span className="muted body-sm">{room.counts.total} bed{room.counts.total === 1 ? '' : 's'} · {room.counts.occupied} occupied · {room.counts.available} available</span></span>}
        actions={<Link href={`/sites/${siteId}`} className="btn" style={{ textDecoration: 'none' }}>Back to site</Link>} />
      <div className="grid two">
        <div className="stack">
          <GlassCard title="Beds" subtitle="Open a bed to block it, see its reservations or archive it">
            {room.beds.length === 0 ? <p className="muted">No beds yet.</p> : (
              <div className="bed-grid">
                {room.beds.map(b => (
                  <Link key={b.id} href={`/sites/${siteId}/beds/${b.id}`} className={`bed ${bedTileClass(b.state, b.nextClaim !== null)}`} style={{ textDecoration: 'none', color: 'inherit' }} aria-label={`Bed ${b.code}, ${b.state.replace(/_/g, ' ')}`}>
                    <span className="code">{b.code}</span>
                    <span style={{ alignSelf: 'flex-start' }}><Status s={STATE_STATUS[b.state]} /></span>
                    {b.nextClaim && b.state !== 'archived' && <span className="sub">{b.state === 'occupied' ? 'Next booking' : 'Reserved from'} {fmtDate(b.nextClaim.from)}</span>}
                  </Link>
                ))}
              </div>
            )}
          </GlassCard>
          <EditRoomForm room={{ id: room.id, name: room.name, floor: room.floor, unit: room.unit, genderPolicy: room.genderPolicy }} canEdit={canManage && !room.archived} />
        </div>
        <div className="stack" style={{ alignSelf: 'start' }}>
          {canManage && !room.archived && <AddBedForm roomId={room.id} suggestion={`${room.name}-${activeBeds.length + 1}`} />}
          {canManage && !room.archived && (
            <ArchivePanel kind="room" id={room.id} preview={prev?.ok ? prev.data : undefined} canArchive={canManage}
              parentHref={`/sites/${siteId}`} childWord="beds" />
          )}
          {room.archived && <GlassCard title="Archived" subtitle="This room is kept for the history and the audit trail. Nothing was deleted." />}
        </div>
      </div>
    </>
  )
}
