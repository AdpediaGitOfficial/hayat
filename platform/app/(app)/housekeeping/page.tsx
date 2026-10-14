import { notFound } from 'next/navigation'
import { requirePage } from '@/server/auth/page'
import { getDb } from '@/server/db/client'
import { can } from '@/server/policy'
import { readinessBoard } from '@/server/queries/readiness/board'
import { myRooms } from '@/server/queries/readiness/mine'
import { inspectionQueue } from '@/server/queries/readiness/inspections'
import { Alert, PageHeader } from '@/ui'
import { Board } from './_components/Board'
import { Inspections } from './_components/Inspections'
import { MyRooms } from './_components/MyRooms'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Housekeeping · Grand Hyatt Staff Accommodation' }

/**
 * One page, by what the viewer may do (all checked again by the API behind every button):
 *  - a housekeeper: My rooms (phone first), only the rooms assigned to them;
 *  - a Final Inspection holder: the inspection queue;
 *  - Reception and the Super Admin: the readiness board with assignment; the Manager and the Auditor: the summary.
 */
export default async function HousekeepingPage() {
  const cur = await requirePage()
  const { actor } = cur.rc
  const now = cur.rc.clock.now()
  const db = getDb()
  const mayClean = can(actor, 'housekeeping_readiness.clean')
  const mayInspect = can(actor, 'housekeeping_readiness.final_inspection')
  const mayView = can(actor, 'housekeeping_readiness.view')
  if (!mayClean && !mayInspect && !mayView) notFound()

  const [board, mine, queue] = await Promise.all([
    mayView ? readinessBoard(db, actor, now) : undefined,
    mayClean ? myRooms(db, actor) : undefined,
    mayInspect ? inspectionQueue(db, actor) : undefined,
  ])
  const canAssign = can(actor, 'housekeeping_readiness.assign')
  const housekeeperFirst = mayClean && !!mine

  return (
    <>
      <PageHeader eyebrow="Accommodation" title="Housekeeping"
        summary="Cleaning, final inspection and bed readiness. A bed is only available after it is cleaned and a Final Inspection holder has passed it. Timers remind; they never release a bed." />

      <div className="stack">
        {housekeeperFirst && mine && <MyRooms rooms={mine.rooms} checklist={mine.checklist} />}
        {queue && <Inspections items={queue} />}
        {board && <Board board={board} canAssign={canAssign} />}
        {!mine && !queue && !board && <Alert tone="info" title="Nothing here for your role yet" detail="Reception assigns rooms to housekeepers; holders of the Final Inspection capability see the inspection queue." />}
      </div>
    </>
  )
}
