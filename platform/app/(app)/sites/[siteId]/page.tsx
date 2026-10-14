import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { getSiteTree } from '@/server/queries/property/tree'
import { Alert, Badge, GlassCard, OccupancyBar, PageHeader, Status } from '@/ui'
import type { BedStateDb } from '@/domain/enums'
import type { TreeBed, TreeRoom } from '@/server/queries/property/types'
import { fmtDate } from '@/domain/time'
import { AddBuildingButton, AddRoomButton, EditSiteButton } from '../_components/Forms'
import { TreeToolbar } from '../_components/TreeToolbar'
import { bedTileClass, GENDER_LABEL, SITE_KIND_LABEL, STATE_NAME, STATE_STATUS } from '../_components/state'

const link = { textDecoration: 'none', color: 'inherit' } as const

export default async function SitePage({ params, searchParams }: { params: { siteId: string }; searchParams: Record<string, string | string[] | undefined> }) {
  const cur = await requirePage('rooms_beds.view')
  const { actor } = cur.rc
  const one = (k: string) => { const v = searchParams[k]; return Array.isArray(v) ? v[0] : v }
  const tree = await getSiteTree(actor, params.siteId, {
    state: one('state') as BedStateDb | undefined, reserved: one('reserved') === '1', q: one('q'), includeArchived: one('archived') === '1',
  })
  if (!tree) notFound()
  const { site, counts } = tree
  const siteId = site.id
  const canRooms = can(actor, 'rooms_beds.manage', { siteId })
  const canBuilding = can(actor, 'sites_buildings.create_building', { siteId })
  const canSite = can(actor, 'sites_buildings.manage', { siteId })
  const filtering = !!(tree.filter.state || tree.filter.reserved || tree.filter.q)
  const buildingOptions = tree.buildings.filter(b => !b.archived).map(b => ({ id: b.id, name: b.name }))
  const blockedOrRepair = counts.blocked + counts.under_maintenance + counts.needs_cleaning + counts.inspection_required

  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Sites & rooms', site.name]} title={site.name}
        summary={`${site.code} · ${SITE_KIND_LABEL[site.kind]} · ${counts.total} beds · time zone ${site.timeZone}`}
        actions={<>
          {canSite && <EditSiteButton site={{ id: site.id, code: site.code, name: site.name, kind: site.kind, timeZone: site.timeZone }} />}
          {canBuilding && <AddBuildingButton siteId={siteId} />}
          {canRooms && <AddRoomButton siteId={siteId} siteCode={site.code} buildings={buildingOptions} />}
        </>} />
      <TreeToolbar counts={counts} filter={tree.filter} />
      <div className="grid two">
        <div className="stack">
          {tree.buildings.map(b => (
            <GlassCard key={b.id} strong
              title={<span className="row">{b.name}{b.archived && <Badge tone="neutral">Archived</Badge>}</span>}
              subtitle={`${b.code} · ${b.rooms.length} room${b.rooms.length === 1 ? '' : 's'} · ${b.counts.occupied}/${b.counts.total} occupied`}
              actions={<Link href={`/sites/${siteId}/buildings/${b.id}`} className="btn sm" style={link}>Manage</Link>}>
              <Rooms siteId={siteId} rooms={b.rooms} today={tree.today} />
            </GlassCard>
          ))}
          {tree.directRooms.length > 0 && (
            <GlassCard strong title={tree.buildings.length ? 'Rooms directly in the site' : site.name} subtitle="Site › Room › Bed (no building level)">
              <Rooms siteId={siteId} rooms={tree.directRooms} today={tree.today} />
            </GlassCard>
          )}
          {tree.buildings.length === 0 && tree.directRooms.length === 0 && (
            filtering
              ? <GlassCard title="Nothing matches" subtitle="No bed, room or building matches this filter. Clear the filters to see everything." />
              : <GlassCard title="Nothing here yet" subtitle={canRooms ? 'Add a room with its beds (and a building first if the site has several).' : 'Rooms and beds are added by an Accommodation Admin.'} />
          )}
        </div>
        <div className="stack" style={{ alignSelf: 'start' }}>
          <GlassCard title="Occupancy">
            <OccupancyBar occupied={counts.occupied} reserved={tree.availableReserved} available={counts.available - tree.availableReserved} blocked={blockedOrRepair} scope={SITE_KIND_LABEL[site.kind]} />
          </GlassCard>
          <GlassCard title="How to read this">
            <p className="muted body-sm">Each bed shows its <b>physical state</b>. Reservations are date-ranged and sit alongside it: a bed can be Available today and reserved from next week. Readiness gates check-in, not future reservations.</p>
          </GlassCard>
        </div>
      </div>
      {counts.total === 0 && !filtering && <Alert tone="info" title="This site has no beds yet" detail="Beds are added room by room." />}
    </>
  )
}

function Rooms({ siteId, rooms, today }: { siteId: string; rooms: TreeRoom[]; today: string }) {
  if (rooms.length === 0) return <p className="muted body-sm">No rooms yet.</p>
  return (
    <div className="stack">
      {rooms.map(r => (
        <div key={r.id} className="room-block">
          <h3 style={{ flexWrap: 'wrap' }}>
            {(r.floor || r.unit) && <span className="subtle" style={{ fontWeight: 400 }}>{[r.floor && `Floor ${r.floor}`, r.unit && `Unit ${r.unit}`].filter(Boolean).join(' · ')} ·</span>}
            <Link href={`/sites/${siteId}/rooms/${r.id}`} style={{ ...link, textDecoration: 'underline', textUnderlineOffset: 3 }}>{r.name}</Link>
            <Badge outline>{GENDER_LABEL[r.genderPolicy]}</Badge>
            {r.archived && <Badge tone="neutral">Archived</Badge>}
            <span className="spacer" />
            <span className="muted body-sm" style={{ fontWeight: 400 }}>{r.beds.length} bed{r.beds.length === 1 ? '' : 's'}</span>
          </h3>
          {r.beds.length === 0 ? <p className="muted body-sm">No beds{r.archived ? '' : ' in this room yet'}.</p> : (
            <div className="bed-grid">{r.beds.map(b => <BedTile key={b.id} siteId={siteId} bed={b} today={today} />)}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function BedTile({ siteId, bed, today }: { siteId: string; bed: TreeBed; today: string }) {
  const cls = bedTileClass(bed.state, bed.nextClaim !== null)
  const claim = bed.nextClaim
  const sub = bed.state === 'available'
    ? (claim ? `Reserved from ${fmtDate(claim.from)}` : '')
    : (bed.state === 'blocked' || bed.state === 'under_maintenance') ? (bed.stateReason ?? '') : ''
  const ended = bed.state === 'blocked' && bed.blockedUntil !== null && bed.blockedUntil < today
  return (
    <Link href={`/sites/${siteId}/beds/${bed.id}`} className={`bed ${cls}`} style={link} aria-label={`Bed ${bed.code}, ${STATE_NAME[bed.state]}${claim ? `, booked from ${claim.from}` : ''}`}>
      <span className="code">{bed.code}</span>
      <span style={{ alignSelf: 'flex-start' }}><Status s={STATE_STATUS[bed.state]} /></span>
      {(sub || ended) && <span className="sub">{sub}{ended ? `${sub ? ' · ' : ''}block period ended` : ''}</span>}
      {claim && bed.state !== 'available' && <span className="sub" style={{ color: 'var(--champagne)' }}>+ {bed.upcomingCount > 1 ? `${bed.upcomingCount} bookings, next ` : 'booked '}{fmtDate(claim.from)}</span>}
    </Link>
  )
}
