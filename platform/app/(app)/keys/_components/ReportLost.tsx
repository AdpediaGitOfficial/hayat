'use client'
/**
 * "Report lost" for a resident, on /my and on the item page. PROPOSED (P-05), pending client sign-off: the server component only renders
 * this when `keys.resident_may_report_lost` is on, and the API refuses with a clear reason when it is off.
 */
import { useState } from 'react'
import { Button, Modal } from '@/ui'
import { ReportLostForm, type ItemRef } from './Forms'

export function ReportLostButton({ item }: { item: ItemRef }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)} aria-label={`Report ${item.code} as lost`}>Report lost</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Report ${item.label} as lost`}>
        <ReportLostForm item={item} onDone={() => setOpen(false)} />
      </Modal>
    </>
  )
}
