import Link from 'next/link'
import { requirePage } from '@/server/auth/page'
import { can } from '@/server/policy'
import { listSites } from '@/server/queries/property/sites'
import { Badge, GlassCard, Icon, PageHeader } from '@/ui'
import { AddSiteButton } from './_components/Forms'
import { SITE_KIND_LABEL } from './_components/state'

export const metadata = { title: 'Sites & rooms · Grand Hyatt Staff Accommodation' }

export default async function SitesPage() {
  const cur = await requirePage('sites_buildings.view')
  const { actor } = cur.rc
  const sites = await listSites(actor)
  const canCreate = can(actor, 'sites_buildings.create_site')

  return (
    <>
      <PageHeader eyebrow="Accommodation" title="Sites & rooms"
        summary="The bed is the unit of occupancy; room, building and site figures are roll-ups of bed states."
        actions={canCreate ? <AddSiteButton /> : undefined} />
      {sites.length === 0 ? (
        <GlassCard title={canCreate ? 'No sites yet' : 'No sites in your scope'}
          subtitle={canCreate ? 'Add the first site, then its buildings, rooms and beds.' : 'Only a Super Admin can change which sites you can see.'} />
      ) : (
        <div className="grid even">
          {sites.map(s => {
            const body = (
              <GlassCard strong title={<span className="row">{s.name}{s.archived && <Badge tone="neutral">Archived</Badge>}</span>}
                subtitle={`${s.code} · ${SITE_KIND_LABEL[s.kind]} · ${s.timeZone}`}
                actions={s.beds ? <Icon name="chevronRight" /> : undefined}>
                {s.beds ? (
                  <div className="stack" style={{ gap: 10 }}>
                    <div className="chips" aria-label="Beds by state">
                      <Badge tone="neutral" dot={false}>{s.beds.total} beds</Badge>
                      <Badge tone="info">{s.beds.available} available</Badge>
                      <Badge tone="brand">{s.beds.occupied} occupied</Badge>
                      {s.beds.needs_cleaning + s.beds.inspection_required > 0 && <Badge tone="warning">{s.beds.needs_cleaning + s.beds.inspection_required} not ready</Badge>}
                      {s.beds.blocked + s.beds.under_maintenance > 0 && <Badge tone="neutral">{s.beds.blocked + s.beds.under_maintenance} blocked or in repair</Badge>}
                    </div>
                    <div className="muted body-sm">{s.buildings} building{s.buildings === 1 ? '' : 's'} · {s.rooms} room{s.rooms === 1 ? '' : 's'}</div>
                  </div>
                ) : <p className="muted body-sm">Your role sees that this site exists, not what is inside it.</p>}
              </GlassCard>
            )
            return s.beds
              ? <Link key={s.id} href={`/sites/${s.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</Link>
              : <div key={s.id}>{body}</div>
          })}
        </div>
      )}
    </>
  )
}
