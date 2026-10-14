import { useState } from 'react'
import { Button, Icon } from '../ui'
import type { State } from '../domain/types'

type Step = { id: string; text: string; persona: string; page: string; params?: Record<string, string>; done: (s: State) => boolean }

/** A guided walk through every Phase 1 flow. Ticks come from the data itself, so "Reset data" clears them. */
export const GUIDE: Step[] = [
  { id: 'approve', text: 'Anita approves Kiran Patel’s request: the bed is chosen and reserved in one step', persona: 'p-aa', page: 'approvals', done: s => s.requests.find(r => r.staffId === 'E1030')?.status === 'Approved' },
  { id: 'checkin', text: 'Rohan checks in Ayesha Khan (and sees why Joseph’s bed blocks check-in)', persona: 'p-rec', page: 'dashboard', done: s => s.stays.some(x => x.staffId === 'E1012') },
  { id: 'offer', text: 'Omar accepts his bed offer before the 48-hour clock runs out', persona: 'p-res-offer', page: 'dashboard', done: s => s.offers.some(o => o.staffId === 'E1036' && o.status === 'Accepted') },
  { id: 'waitlist', text: 'Anita offers a bed to Neha on the waitlist; email delivery starts her clock', persona: 'p-aa', page: 'waitlist', done: s => s.offers.some(o => o.staffId === 'E1033') },
  { id: 'conflict', text: 'Two admins pick the same bed in the Conflict lab: the second is refused', persona: 'p-aa', page: 'allocations', params: { tab: 'lab' }, done: s => s.audit.filter(a => a.action === 'Request approved + reserved').length >= 2 },
  { id: 'transfer', text: 'Anita approves Meena’s transfer, Rohan executes it (try the simulated failure first)', persona: 'p-rec', page: 'transfers', done: s => s.transfers.some(t => t.kind === 'Transfer' && t.status === 'Executed') },
  { id: 'exit', text: 'Anita marks Dev Malhotra as Left: login revoked, bed still occupied', persona: 'p-aa', page: 'exits', done: s => s.staff.find(x => x.id === 'E1050')?.status === 'Left' },
  { id: 'turnover', text: 'Rohan checks Dev out, Lakshmi cleans the bed, Rohan inspects it: only then Available', persona: 'p-rec', page: 'housekeeping', done: s => s.cleaning.some(t => t.status === 'Passed') },
  { id: 'emergency', text: 'Jump +1 day twice: the emergency check-in escalates, never auto-approves', persona: 'p-aa', page: 'emergency', done: s => s.emergencies.some(e => e.escalation >= 1) },
  { id: 'visitor', text: 'Rohan registers a visitor, approves it; Sanjay lets them in at the gate', persona: 'p-rec', page: 'visitors', done: s => s.visitors.some(v => v.checkedOutAt || (v.id !== 'VS4' && v.status === 'Checked in')) },
  { id: 'contractor', text: 'Sanjay admits CoolAir; BrightSpark is stopped by expired documents', persona: 'p-mc', page: 'contractors', done: s => s.audit.some(a => a.action === 'Contractor access denied') || s.contractorVisits.some(v => v.status === 'Denied') },
  { id: 'sos', text: 'A resident sends an SOS; leave it unacknowledged and jump +6 min', persona: 'p-res-staying', page: 'incidents', done: s => s.incidents.some(i => (i.escalation ?? 0) >= 1) },
  { id: 'outage', text: 'Rohan declares an outage and logs events; Anita restores and reconciles them', persona: 'p-rec', page: 'outage', done: s => s.offlineEvents.some(e => e.status === 'Applied') },
  { id: 'grant', text: 'Vikram requests a capability grant, Meghna approves (maker-checker)', persona: 'p-sa', page: 'users', params: { tab: 'changes' }, done: s => s.changes.some(c => c.status === 'Applied') },
  { id: 'migrate', text: 'Anita prepares an occupancy import, Suresh signs it off', persona: 'p-aa', page: 'staff', done: s => s.migration?.status === 'Imported' },
]

export function DemoGuide({ s, go }: { s: State; go: (persona: string, page: string, params?: Record<string, string>) => void }) {
  const [open, setOpen] = useState(false)
  const done = GUIDE.filter(g => g.done(s)).length
  const next = GUIDE.findIndex(g => !g.done(s))
  if (!open) return <button className="btn primary guide-min" onClick={() => setOpen(true)}><Icon name="list" /> Demo guide {done}/{GUIDE.length}</button>
  return (
    <aside className="guide card strong" aria-label="Demo guide">
      <div className="row" style={{ padding: '12px 14px 4px' }}><b>Walk through Phase 1</b><span className="spacer" /><span className="muted body-sm">{done} of {GUIDE.length}</span><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Hide</Button></div>
      <div className="meter" style={{ margin: '4px 14px 8px' }}><i style={{ width: `${(done / GUIDE.length) * 100}%`, background: 'var(--success)' }} /></div>
      <ol className="guide-list">
        {GUIDE.map((g, i) => {
          const d = g.done(s)
          return (
            <li key={g.id} className={d ? 'done' : i === next ? 'next' : ''}>
              <span className="tick">{d ? '✓' : i + 1}</span>
              <span className="t">{g.text}</span>
              {!d && <Button size="sm" onClick={() => go(g.persona, g.page, g.params)}>Go</Button>}
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
