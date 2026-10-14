import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { getCase } from '@/server/queries/exit/cases'
import { isUuid } from '@/server/commands/property/shared'
import { Alert, Badge, Blocked, GlassCard, PageHeader } from '@/ui'
import { CaseChip, DueChip, ItemChip } from '../_components/chips'
import { CloseCase } from '../_components/CloseCase'
import { ItemActions } from '../_components/ItemActions'
import { utc } from '../_components/format'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Clearance case · Grand Hyatt Staff Accommodation' }

const EVENT_LABEL: Record<string, string> = {
  opened: 'Marked as Left, case opened', item_added: 'Item added', item_done: 'Marked done', item_reopened: 'Reopened', item_outstanding: 'Recorded as outstanding',
  item_waived: 'Waived by the Policy Approver', item_synced: 'Returned in the keys register', closed: 'Case closed',
}
const BED_STATE: Record<string, string> = { available: 'Available', occupied: 'Occupied', needs_cleaning: 'Needs cleaning', inspection_required: 'Inspection required', blocked: 'Blocked', under_maintenance: 'Under maintenance', archived: 'Archived' }

export default async function ClearanceCasePage({ params }: { params: { id: string } }) {
  const cur = await requirePage('exit_clearance.view')
  if (!isUuid(params.id)) notFound()
  const k = await getCase(getDb(), cur.rc.actor, params.id, cur.rc.clock.now())
  if (!k) notFound()
  const isOpen = k.status !== 'cleared'
  const left = k.person.employmentStatus === 'left'

  return (
    <>
      <PageHeader crumbs={['Accommodation', 'Exits & clearance', k.person.fullName]} title={k.person.fullName}
        summary={<span className="row wrap"><CaseChip status={k.status} />{isOpen && <DueChip dueDate={k.dueDate} overdue={k.overdue} daysOverdue={k.daysOverdue} />}<span className="muted body-sm">{k.person.employeeId}{k.siteName ? ` · ${k.siteName}` : ''}</span></span>}
        actions={<Link href="/exits" className="btn secondary" style={{ textDecoration: 'none' }}>All cases</Link>} />

      {k.stay?.stillInBed && (
        <Alert tone="info" title="Stays occupied until checkout"
          detail={<>They are still in bed {k.stay.bedCode} ({k.stay.siteName}{k.stay.roomName ? `, ${k.stay.roomName}` : ''}). Marking someone as Left never releases the bed: Reception checks them out when they leave.{' '}
            <Link href={`/stays/${k.stay.id}`}>Open the stay</Link></>} />
      )}
      {k.stay && !k.stay.stillInBed && (
        <Alert tone="success" title={`Checked out of bed ${k.stay.bedCode}`} detail={`The stay is ${k.stay.status === 'closed' ? 'closed' : 'checked out'}. The bed is ${BED_STATE[k.stay.bedState] ?? k.stay.bedState}: clearance and a ready bed are tracked separately.`} />
      )}
      {k.overdue && isOpen && <Blocked why={`Clearance was due on ${k.dueDate} and is ${k.daysOverdue} business day${k.daysOverdue === 1 ? '' : 's'} overdue`} owner="Accommodation Admin, then the Policy Approver" next="Follow up the owners of the open items. Nothing closes by itself" />}
      {k.notYetOnCase.length > 0 && <Alert tone="warning" title="Held now, not yet on this case" detail={`${k.notYetOnCase.map(h => h.label).join(', ')}. They join the case the next time it is worked or closed.`} />}

      <div className="grid two">
        <div className="stack">
          <GlassCard title="Clearance checklist" subtitle="Done on the former employee's behalf. Keys and assets follow the keys register." strong flush>
            <ul className="list-plain" style={{ padding: '0 20px 12px' }} aria-label="Clearance items" data-testid="clearance-items">
              {k.items.map(i => (
                <li key={i.id} data-item={i.id} data-status={i.status} style={{ display: 'block' }}>
                  <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <b>{i.label}</b>
                      <div className="muted body-sm">
                        {i.mandatory ? 'Mandatory' : 'Optional'} · owner: {i.ownerLabel}
                        {i.handover && ` · ${i.handover.category === 'key' ? 'key' : 'asset'} ${i.handover.code}, ${i.handover.status.replace('_', ' ')} in the register`}
                      </div>
                    </div>
                    <div className="row wrap"><ItemChip status={i.status} />{i.lostOrDamaged && <Badge tone="danger">Lost or damaged</Badge>}</div>
                  </div>
                  {i.status === 'done' && (
                    <div className="body-sm" style={{ marginTop: 6 }}>
                      Done {i.doneAt ? utc(i.doneAt) : ''}{i.doneByName ? ` by ${i.doneByName}` : ''}{i.onBehalfOfName ? ` on behalf of ${i.onBehalfOfName}` : ''}{i.note ? `: ${i.note}` : ''}
                    </div>
                  )}
                  {i.status === 'outstanding' && i.note && <div className="body-sm" style={{ marginTop: 6 }}>Outstanding: {i.note}</div>}
                  {i.waiver && (
                    <div className="body-sm" style={{ marginTop: 6 }}>
                      Waived {i.waiver.at ? utc(i.waiver.at) : ''}{i.waiver.byName ? ` by ${i.waiver.byName}` : ''}. Reason: {i.waiver.reason}. Evidence: {i.waiver.evidence}
                    </div>
                  )}
                  {i.lostOrDamaged && i.status === 'outstanding' && <div style={{ marginTop: 6 }}><Blocked why="A lost or damaged key is never marked returned (D-73)" owner={i.ownerLabel} next={i.next ?? undefined} /></div>}
                  {i.next && !i.lostOrDamaged && isOpen && <div className="muted body-sm" style={{ marginTop: 4 }}>Next: {i.next}</div>}
                  {i.attachments.length > 0 && (
                    <ul className="list-plain" aria-label={`Evidence for ${i.label}`} style={{ marginTop: 6 }}>
                      {i.attachments.map(a => <li key={a.id} style={{ padding: '4px 0' }}><a href={a.href}>{a.filename}</a><span className="muted body-sm"> · {Math.max(1, Math.round(a.sizeBytes / 1024))} KB · {utc(a.createdAt)}</span></li>)}
                    </ul>
                  )}
                  {isOpen && <div style={{ marginTop: 8 }}><ItemActions item={i} personName={k.person.fullName} /></div>}
                </li>
              ))}
            </ul>
          </GlassCard>

          <GlassCard title="History" subtitle="Who did what, when, and on whose behalf" strong flush={k.events.length === 0}>
            <ol className="list-plain" aria-label="Case history" style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="case-history">
              {k.events.map(e => (
                <li key={e.id} style={{ display: 'block' }}>
                  <b>{EVENT_LABEL[e.kind] ?? e.kind}</b>{e.itemLabel ? `: ${e.itemLabel}` : ''}
                  <div className="muted body-sm">
                    {utc(e.at)} · {e.actorName ?? 'keys register'}{e.onBehalfOfName && e.kind !== 'opened' ? ` · on behalf of ${e.onBehalfOfName}` : ''}{e.note ? ` · ${e.note}` : ''}
                  </div>
                </li>
              ))}
            </ol>
          </GlassCard>
        </div>

        <div className="stack" style={{ alignSelf: 'start' }}>
          {isOpen
            ? (
              <GlassCard title="Close the case" subtitle="Needs every mandatory item done or waived" strong>
                <CloseCase caseId={k.id} blockers={k.closeBlockers} canClose={k.me.canClose} why={k.me.why} owner={k.me.owner} next={k.me.next} />
              </GlassCard>
            )
            : <Alert tone="success" title="Cleared" detail={`${k.clearedAt ? utc(k.clearedAt) : ''}${k.clearedByName ? ` by ${k.clearedByName}` : ''}. Checkout and bed readiness are tracked separately.`} />}

          <GlassCard title="The case" strong>
            <dl className="kv">
              <dt>Person</dt><dd>{k.person.fullName} <span className="mono muted">{k.person.employeeId}</span></dd>
              <dt>Employment</dt><dd><Badge tone={left ? 'neutral' : 'success'}>{left ? 'Left' : 'Active again'}</Badge> effective {k.effectiveDate}</dd>
              <dt>Login</dt><dd>{k.person.accountStatus === null ? 'No login account' : k.person.accountStatus === 'revoked' ? 'Ended' : k.person.accountStatus}</dd>
              <dt>Reason</dt><dd>{k.reason}</dd>
              <dt>Opened</dt><dd>{utc(k.openedAt)}{k.openedByName ? ` by ${k.openedByName}` : ''}</dd>
              <dt>Due</dt><dd>{k.dueDate}</dd>
              {k.stay && <><dt>Stay</dt><dd><Link href={`/stays/${k.stay.id}`}>{k.stay.status.replace('_', ' ')}</Link> · bed {k.stay.bedCode} · {BED_STATE[k.stay.bedState] ?? k.stay.bedState}</dd></>}
            </dl>
          </GlassCard>
        </div>
      </div>
    </>
  )
}
