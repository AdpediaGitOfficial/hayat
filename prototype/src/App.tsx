'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AppCtx } from './ctx'
import { A, resetState, useAppState } from './domain/store'
import { PERSONAS, ROLE_LABEL, CAP_LABEL, navFor } from './roles'
import { Avatar, Badge, Button, Icon, ToastHost, GlassCard } from './ui'
import { jump, nowMs, useNow, fmtDateTime, DAY, HOUR } from './domain/time'
import { approvalInbox, myInbox, notificationsFor, visibleSites } from './domain/select'
import { Dashboard } from './screens/Dashboard'
import { Inventory } from './screens/Inventory'
import { Approvals } from './screens/Approvals'
import { Allocations } from './screens/Allocations'
import { Waitlist } from './screens/Waitlist'
import { Transfers } from './screens/Transfers'
import { Exits, Clearances } from './screens/Exits'
import { Housekeeping } from './screens/Housekeeping'
import { Emergency } from './screens/Emergency'
import { Staff } from './screens/Staff'
import { RequestBed } from './screens/RequestBed'
import { Keys, Maintenance, Incidents, Reports, AuditLog, Settings } from './screens/Misc'

export default function App() {
  const s = useAppState()
  const now = useNow()
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pid = 'p-aa', pg = 'dashboard'] = (pathname ?? '').replace(/^\//, '').split('/')
  const route = { pid, page: pg, params: Object.fromEntries(sp ? sp.entries() : []) as Record<string, string> }
  const [scope, setScope] = useState('all')
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [menu, setMenu] = useState<null | 'persona' | 'bell' | 'site'>(null)

  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => { const t = setInterval(() => A.tick(), 2000); A.tick(); return () => clearInterval(t) }, [])

  const persona = PERSONAS.find(p => p.id === route.pid) ?? PERSONAS[0]
  const nav = useMemo(() => navFor(persona), [persona])
  const go = (page: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams(params).toString()
    router.push(`/${persona.id}/${page}${q ? '?' + q : ''}`)
    setMenu(null)
    window.scrollTo({ top: 0 })
  }
  const switchPersona = (id: string) => { router.push(`/${id}/dashboard`); setMenu(null); setScope('all') }
  const page = nav.some(n => n.id === route.page) || route.page === 'dashboard' ? route.page : 'dashboard'
  const sites = visibleSites(s, persona)
  const pending = myInbox(s, persona, now).length
  const notifs = notificationsFor(s, persona)
  const counts: Record<string, number> = {
    approvals: pending,
    clearances: s.clearances.filter(c => c.status === 'Open').length,
    waitlist: s.offers.filter(o => o.status === 'Pending' && !o.deliveredAt).length,
    housekeeping: persona.role === 'Res' ? s.cleaning.filter(t => t.status === 'Open' && t.assignedTo === persona.staffId).length : s.cleaning.filter(t => t.status !== 'Passed').length,
    emergency: s.emergencies.filter(e => e.status === 'Pending').length,
  }
  const ctx = { persona, s, now, page, params: route.params, go, scope, setScope }
  const groups = nav.reduce<Record<string, typeof nav>>((m, n) => { (m[n.group] ||= []).push(n); return m }, {})
  const Page = PAGES[page] ?? Dashboard
  const crumbSite = persona.role === 'Res' ? 'My accommodation' : scope === 'all' ? (sites.length === 1 ? sites[0].name : 'All sites') : sites.find(x => x.id === scope)?.name
  const pageLabel = nav.find(n => n.id === page)?.label ?? 'Dashboard'

  return (
    <ToastHost>
      <AppCtx.Provider value={ctx}>
        <div className="gh-canvas" onClick={() => menu && setMenu(null)}>
          <div className="shell">
            <aside className="sidebar" aria-label="Main navigation">
              <button className="sb-switch" style={{ background: 'transparent', color: 'inherit', width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={e => { e.stopPropagation(); setMenu(menu === 'persona' ? null : 'persona') }} aria-label="Switch role">
                <span className="sb-mark">GH</span>
                <span style={{ flex: 1 }}><span className="sb-brand" style={{ display: 'block' }}>Grand Hyatt</span><span className="sb-product">Staff Accommodation</span></span>
                <Icon name="updown" />
              </button>
              <nav className="sb-nav">
                {Object.entries(groups).map(([g, items]) => (
                  <div key={g || 'top'}>
                    {g && <div className="sb-group">{g}</div>}
                    {items.map(n => (
                      <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => go(n.id)} aria-current={page === n.id ? 'page' : undefined}>
                        <Icon name={n.icon} />{n.label}
                        {counts[n.id] > 0 && <span className="count">{counts[n.id]}</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </nav>
              <div className="sb-user">
                <Avatar name={persona.name} brand />
                <div className="who"><b>{persona.name}</b><span>{persona.caps.length ? `${ROLE_LABEL[persona.role]} + ${persona.caps.length}` : ROLE_LABEL[persona.role]}</span></div>
                <Button variant="ghost" size="sm" icon="more" aria-label="Switch role" onClick={() => setMenu('persona')} />
              </div>
            </aside>

            <div className="main">
              <header className="topbar">
                <div className="crumb"><span>{crumbSite}</span><Icon name="chevronRight" size={12} /><b>{pageLabel}</b></div>
                <label className="search"><Icon name="search" /><input placeholder="Search people, beds, keys…" aria-label="Search" onKeyDown={e => { if (e.key === 'Enter') go(persona.role === 'Res' ? 'dashboard' : 'staff', { q: (e.target as HTMLInputElement).value }) }} /><span className="kbd">⌘K</span></label>
                {persona.role !== 'Res' && sites.length > 1 && (
                  <div style={{ position: 'relative' }}>
                    <Button icon="pin" onClick={() => setMenu(menu === 'site' ? null : 'site')}>{scope === 'all' ? 'All sites' : sites.find(x => x.id === scope)?.name}<Icon name="updown" /></Button>
                    {menu === 'site' && <Popover onClick={e => e.stopPropagation()}>
                      {[{ id: 'all', name: 'All sites' }, ...sites].map(x => <button key={x.id} className="nav-item" style={{ color: 'var(--ink)' }} onClick={() => { setScope(x.id); setMenu(null) }}>{x.name}</button>)}
                    </Popover>}
                  </div>
                )}
                <Button variant="ghost" icon={theme === 'light' ? 'moon' : 'sun'} aria-label="Toggle theme" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} />
                <div style={{ position: 'relative' }}>
                  <Button variant="ghost" icon="bell" aria-label="Notifications" onClick={() => setMenu(menu === 'bell' ? null : 'bell')} />
                  {notifs.length > 0 && <span style={{ position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: '50%', background: 'var(--brand-fill)' }} />}
                  {menu === 'bell' && <Popover wide onClick={e => e.stopPropagation()}>
                    <div className="eyebrow" style={{ padding: '4px 8px 8px' }}>Notifications · in-app + email only</div>
                    {notifs.length === 0 && <div className="tbl-empty">You're all caught up</div>}
                    {notifs.slice(0, 8).map(n => <div key={n.id} style={{ padding: '8px', borderTop: '1px solid var(--line)', fontSize: 13 }}>{n.text}<div className="subtle" style={{ fontSize: 11.5 }}>{fmtDateTime(n.at)}{n.email && ' · also emailed'}</div></div>)}
                  </Popover>}
                </div>
              </header>
              {menu === 'persona' && <PersonaMenu current={persona.id} onPick={switchPersona} onClose={() => setMenu(null)} />}
              <main className="page" id="main"><Page key={persona.id + page} /></main>
            </div>
          </div>

          <nav className="tabbar" aria-label="Mobile navigation">
            {nav.slice(0, 5).map(n => <button key={n.id} className={page === n.id ? 'active' : ''} onClick={() => go(n.id)}><Icon name={n.icon} size={20} />{n.label.split(' ')[0]}</button>)}
            <button onClick={() => setMenu('persona')}><Icon name="user" size={20} />Role</button>
          </nav>
          <DemoBar now={now} />
        </div>
      </AppCtx.Provider>
    </ToastHost>
  )
}

const PAGES: Record<string, () => JSX.Element> = {
  dashboard: Dashboard, inventory: Inventory, approvals: Approvals, allocations: Allocations, waitlist: Waitlist, transfers: Transfers,
  exits: Exits, clearances: Clearances, housekeeping: Housekeeping, emergency: Emergency, staff: Staff, request: RequestBed,
  keys: Keys, maintenance: Maintenance, incidents: Incidents, reports: Reports, audit: AuditLog, settings: Settings,
}

function Popover({ children, wide, onClick }: { children: React.ReactNode; wide?: boolean; onClick?: (e: React.MouseEvent) => void }) {
  return <div onClick={onClick} className="card strong" style={{ position: 'absolute', right: 0, top: 44, width: wide ? 340 : 220, padding: 8, zIndex: 50, boxShadow: 'var(--shadow-raised)' }}>{children}</div>
}

function PersonaMenu({ current, onPick, onClose }: { current: string; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }) }, [])
  return (
    <div ref={ref} onClick={e => e.stopPropagation()}>
      <GlassCard strong title="Switch role" subtitle="Prototype only: no real sign-in (D-100). Each persona sits at a different point in the journey." actions={<Button variant="ghost" icon="x" aria-label="Close" onClick={onClose} />}>
        <div className="grid three">
          {PERSONAS.map(p => (
            <button key={p.id} onClick={() => onPick(p.id)} className="card" style={{ padding: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center', borderColor: p.id === current ? 'var(--brand-fill)' : undefined }}>
              <Avatar name={p.name} brand={p.id === current} />
              <span style={{ minWidth: 0 }}>
                <b style={{ display: 'block', fontWeight: 500 }}>{p.name}</b>
                <span className="muted body-sm" style={{ display: 'block' }}>{p.title}</span>
                {p.caps.length > 0 && <span className="chips" style={{ marginTop: 4 }}>{p.caps.map(c => <Badge key={c} outline>{CAP_LABEL[c]}</Badge>)}</span>}
              </span>
            </button>
          ))}
        </div>
      </GlassCard>
    </div>
  )
}

function DemoBar({ now }: { now: number }) {
  return (
    <div className="demo-bar" role="region" aria-label="Demo controls">
      <Icon name="clock" /><span className="clock">{fmtDateTime(now)}</span>
      <span className="subtle">Demo clock</span>
      <Button size="sm" onClick={() => jump(HOUR)}>+1h</Button>
      <Button size="sm" onClick={() => jump(6 * HOUR)}>+6h</Button>
      <Button size="sm" onClick={() => jump(DAY)}>+1 day</Button>
      <Button size="sm" onClick={() => jump(3 * DAY)}>+3 days</Button>
      <Button size="sm" variant="ghost" icon="undo" onClick={() => { resetState(); }}>Reset data</Button>
    </div>
  )
}
