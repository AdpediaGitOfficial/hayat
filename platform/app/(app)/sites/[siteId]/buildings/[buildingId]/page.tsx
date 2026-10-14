import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { getBuildingDetail } from '@/server/queries/property/detail'
import { previewArchive } from '@/server/queries/property/archivePreview'
import { Badge, GlassCard, PageHeader } from '@/ui'
import { ArchivePanel } from '../../../_components/ArchivePanel'
import { AddRoomButton, EditBuildingForm } from '../../../_components/Forms'
import { GENDER_LABEL } from '../../../_components/state'

export default async function BuildingPage({ params }: { params: { siteId: string; buildingId: string } }) {
  const cur = await requirePage('rooms_beds.view')
  const { actor } = cur.rc
  const b = await getBuildingDetail(actor, params.buildingId)
  if (!b || b.site.id !== params.siteId) notFound()
  const siteId = b.site.id
  const canManage = can(actor, 'sites_buildings.manage', { siteId })
  const canRooms = can(actor, 'rooms_beds.manage', { siteId })
  const prev = canManage && !b.archived ? await previewArchive(actor, 'building', b.id) : undefined

  return (
    <>
      <PageHeader crumbs={[b.site.name, `Building ${b.name}`]} title={b.name}
        summary={<span className="row wrap">{b.archived && <Badge tone="neutral">Archived</Badge>}<span className="muted body-sm">{b.code} · {b.counts.total} beds · {b.counts.occupied} occupied · {b.counts.available} available</span></span>}
        actions={<>
          {canRooms && !b.archived && <AddRoomButton siteId={siteId} siteCode={b.site.code} buildings={[{ id: b.id, name: b.name }]} defaultBuildingId={b.id} />}
          <Link href={`/sites/${siteId}`} className="btn" style={{ textDecoration: 'none' }}>Back to site</Link>
        </>} />
      <div className="grid two">
        <div className="stack">
          <GlassCard strong flush title="Rooms" subtitle="Open a room to manage its beds" footer={<span>{b.rooms.length} active room{b.rooms.length === 1 ? '' : 's'}</span>}>
            <div className="tbl-wrap">
              <table className="tbl stack-m">
                <thead><tr><th>Room</th><th>Floor / unit</th><th>Gender</th><th className="r">Beds</th></tr></thead>
                <tbody>
                  {b.rooms.map(r => (
                    <tr key={r.id}>
                      <td data-h="Room"><Link href={`/sites/${siteId}/rooms/${r.id}`}>{r.name}</Link></td>
                      <td data-h="Floor / unit">{[r.floor && `Floor ${r.floor}`, r.unit && `Unit ${r.unit}`].filter(Boolean).join(' · ') || '—'}</td>
                      <td data-h="Gender">{GENDER_LABEL[r.genderPolicy]}</td>
                      <td data-h="Beds" className="r">{r.counts.occupied}/{r.counts.total} occupied</td>
                    </tr>
                  ))}
                  {b.rooms.length === 0 && <tr><td colSpan={4}><div className="tbl-empty">No active rooms in this building</div></td></tr>}
                </tbody>
              </table>
            </div>
          </GlassCard>
          <EditBuildingForm building={{ id: b.id, code: b.code, name: b.name }} canEdit={canManage && !b.archived} />
        </div>
        <div className="stack" style={{ alignSelf: 'start' }}>
          {!b.archived && <ArchivePanel kind="building" id={b.id} preview={prev?.ok ? prev.data : undefined} canArchive={canManage} parentHref={`/sites/${siteId}`} childWord="rooms and beds" />}
          {b.archived && <GlassCard title="Archived" subtitle="This building is kept for the history and the audit trail. Nothing was deleted." />}
        </div>
      </div>
    </>
  )
}
