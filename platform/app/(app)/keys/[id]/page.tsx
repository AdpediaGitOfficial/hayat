import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getItemDetail } from '@/server/queries/keys/items'
import { Alert, Badge, Blocked, GlassCard, PageHeader } from '@/ui'
import { fmtDate, fmtDateLong, fmtDateTime } from '@/domain/time'
import { EVENT_LABEL, OverdueBadge, StatusChip } from '../_components/bits'
import { ItemActions } from '../_components/Forms'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Key or asset · Grand Hyatt Staff Accommodation' }

export default async function KeyPage({ params }: { params: { id: string } }) {
  const cur = await requirePage()
  const d = await getItemDetail(cur.rc.actor, params.id, cur.rc.clock.now())
  if (!d) notFound()
  const today = cur.rc.clock.now().toISOString().slice(0, 10)
  const ref = { id: d.id, code: d.code, label: `${d.itemTypeLabel} ${d.code}`, status: d.status }
  const mine = cur.rc.actor.staffId !== undefined && d.holder?.id === cur.rc.actor.staffId
  const acts = d.abilities.move || d.abilities.manage

  return (
    <>
      <PageHeader
        crumbs={['Accommodation', 'Keys & assets', d.code]} title={`${d.itemTypeLabel} ${d.code}`}
        summary={<span className="row wrap"><StatusChip status={d.status} /><OverdueBadge o={d.overdue} />{d.archived && <Badge tone="neutral" outline>Archived</Badge>}<span className="muted body-sm">{d.siteName}</span></span>}
        actions={<Link href="/keys" className="btn secondary" style={{ textDecoration: 'none' }}>Back to keys</Link>}
      />
      {d.overdue.overdue && d.holder && (
        <Blocked why={d.overdue.reason === 'left' ? `${d.holder.name} has left and still holds this` : d.overdue.reason === 'departed' ? `${d.holder.name} checked out and has not returned this` : `This was due back on ${d.dueBack ? fmtDate(d.dueBack) : ''}`}
          owner="Reception" next="Arrange the return, or record it as lost or damaged. Nothing is marked returned automatically" />
      )}
      <div className="grid two">
        <div className="stack">
          <GlassCard title="Item">
            <dl className="kv">
              <dt>Type</dt><dd>{d.itemTypeLabel} <span className="muted">({d.category})</span></dd>
              <dt>Code</dt><dd className="mono">{d.code}</dd>
              <dt>Site</dt><dd>{d.siteName}</dd>
              <dt>Belongs to</dt><dd>{d.forLabel ?? <span className="muted">Not tied to a bed or room</span>}</dd>
              {d.holder && <><dt>Held by</dt><dd>{d.holder.name} <span className="mono muted">{d.holder.employeeId}</span>{d.holder.left && <> <Badge tone="neutral">Has left</Badge></>}</dd></>}
              {d.issuedAt && <><dt>Issued</dt><dd>{fmtDateLong(d.issuedAt.slice(0, 10))}</dd></>}
              {d.status === 'issued' && <><dt>Due back</dt><dd>{d.dueBack ? fmtDateLong(d.dueBack) : 'With the stay (returned at checkout)'}</dd></>}
              {d.replacedBy && <><dt>Replaced by</dt><dd><Link href={`/keys/${d.replacedBy.id}`}>{d.replacedBy.code}</Link></dd></>}
              {d.replaces && <><dt>Replaces</dt><dd><Link href={`/keys/${d.replaces.id}`}>{d.replaces.code}</Link></dd></>}
              {d.note && <><dt>Note</dt><dd>{d.note}</dd></>}
            </dl>
          </GlassCard>

          <GlassCard title="History" subtitle="Every movement, newest first. Nothing is edited or deleted.">
            {d.events.length === 0 ? <p className="muted">Nothing has happened to this item yet.</p> : (
              <ul className="list-plain" aria-label="History">
                {d.events.map(e => (
                  <li key={e.id} style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <span style={{ flex: 1, minWidth: 200 }}>
                      <b>{EVENT_LABEL[e.kind] ?? e.kind}</b>{e.person ? <> · {e.person.name}</> : null}
                      {e.onBehalf && <> <Badge tone="info" outline>On behalf of the holder</Badge></>}
                      {e.note && <span className="muted body-sm" style={{ display: 'block' }}>{e.note}</span>}
                      <span className="muted body-sm" style={{ display: 'block' }}>{e.actor ? `${e.actor} · ` : ''}{fmtDateTime(Date.parse(e.at))}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </GlassCard>
        </div>

        <div className="stack" style={{ alignSelf: 'start' }}>
          {acts
            ? (
              <GlassCard title="Actions">
                {d.archived
                  ? <p className="muted body-sm">This item is archived. It is kept for the history.</p>
                  : <ItemActions item={ref} holder={d.holder ? { id: d.holder.id, name: d.holder.name } : undefined} holderLeft={d.holder?.left} today={today} canMove={d.abilities.move} canManage={d.abilities.manage} />}
              </GlassCard>
            )
            : (
              <GlassCard title={mine ? 'You hold this' : 'This item'}>
                <p className="body-sm">{mine ? 'To hand it back, take it to Reception. If it is lost or damaged, tell Reception at once; do not wait.' : 'You can see this item. Reception and the Accommodation Admin act on it.'}</p>
                {d.status === 'issued' && mine && d.dueBack && <Alert tone="info" title={`Due back ${fmtDate(d.dueBack)}`} />}
              </GlassCard>
            )}

          <GlassCard title="Evidence" subtitle="Photos and reports attached to this item.">
            {d.attachments.length === 0 ? <p className="muted body-sm">No files attached.</p> : (
              <ul className="list-plain" aria-label="Attached files">
                {d.attachments.map(a => (
                  <li key={a.id}><span style={{ flex: 1 }}><a href={`/api/v1/attachments/${a.id}`}>{a.filename}</a><span className="muted body-sm" style={{ display: 'block' }}>{(a.sizeBytes / 1024).toFixed(0)} KB · {fmtDate(a.createdAt.toISOString().slice(0, 10))}</span></span></li>
                ))}
              </ul>
            )}
          </GlassCard>
        </div>
      </div>
    </>
  )
}
