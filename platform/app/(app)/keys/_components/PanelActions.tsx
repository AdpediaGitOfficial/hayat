'use client'
/** Buttons on the stay's keys panel: take a key back, hand a cabinet key to the resident. Thin clients over the keys API. */
import { useState } from 'react'
import { Button } from '@/ui'
import { IssueForm, ReturnForm, type ItemRef } from './Forms'

export function PanelReturn({ item, holder, holderLeft }: { item: ItemRef; holder: string; holderLeft?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="stack" style={{ gap: 8, width: '100%' }}>
      <Button size="sm" variant={open ? 'primary' : 'secondary'} onClick={() => setOpen(!open)}>{open ? 'Cancel' : 'Record return'}</Button>
      {open && <ReturnForm item={item} holder={holder} holderLeft={holderLeft} onDone={() => setOpen(false)} />}
    </div>
  )
}

export function PanelIssue({ item, staff, today }: { item: ItemRef; staff: { id: string; name: string }; today: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="stack" style={{ gap: 8, width: '100%' }}>
      <Button size="sm" variant={open ? 'primary' : 'secondary'} onClick={() => setOpen(!open)}>{open ? 'Cancel' : `Issue to ${staff.name.split(' ')[0]}`}</Button>
      {open && <IssueForm item={item} staff={staff} today={today} onDone={() => setOpen(false)} />}
    </div>
  )
}
