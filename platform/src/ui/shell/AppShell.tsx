'use client'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { Avatar, Button, Icon, ToastHost, useToast } from '@/ui'
import type { IconName } from '@/ui/icons'
import { post } from '@/ui/api'
import { ROLE_LABEL } from '@/domain/labels'
import type { Role } from '@/domain/enums'

export interface ShellNavItem { id: string; label: string; href: string; icon: IconName; group: string }
export interface ShellUser { name: string; role: Role; modes: Role[]; capabilityLabels: string[] }

export function AppShell({ user, nav, unread = 0, children }: { user: ShellUser; nav: ShellNavItem[]; unread?: number; children: ReactNode }) {
  return <ToastHost><Frame user={user} nav={nav} unread={unread}>{children}</Frame></ToastHost>
}

function Frame({ user, nav, unread, children }: { user: ShellUser; nav: ShellNavItem[]; unread: number; children: ReactNode }) {
  const router = useRouter()
  const path = usePathname() ?? '/'
  const toast = useToast()
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setMenu(false) }, [path])

  const active = (n: ShellNavItem) => n.href === '/' ? path === '/' : path === n.href || path.startsWith(n.href + '/')
  const groups = nav.reduce<Record<string, ShellNavItem[]>>((m, n) => { (m[n.group] ||= []).push(n); return m }, {})
  const here = nav.find(active)?.label ?? ''

  async function switchTo(role: Role) {
    if (role === user.role || busy) return
    setBusy(true)
    const r = await post('/api/v1/auth/switch-role', { role })
    setBusy(false)
    if (!r.ok) return toast(`${r.reason}${r.next ? ' — ' + r.next : ''}`, true)
    setMenu(false)
    router.push('/')
    router.refresh()
  }
  async function signOut() {
    await post('/api/v1/auth/logout')
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="gh-canvas" onClick={() => menu && setMenu(false)}>
      <a className="skip" href="#main">Skip to content</a>
      <div className="shell">
        <aside className="sidebar" aria-label="Main navigation">
          <div className="sb-switch">
            <span className="sb-mark">GH</span>
            <span style={{ flex: 1 }}><span className="sb-brand" style={{ display: 'block' }}>Grand Hyatt</span><span className="sb-product">Staff Accommodation</span></span>
          </div>
          <nav className="sb-nav">
            {Object.entries(groups).map(([g, items]) => (
              <div key={g || 'top'}>
                {g && <div className="sb-group">{g}</div>}
                {items.map(n => (
                  <button key={n.id} className={`nav-item ${active(n) ? 'active' : ''}`} onClick={() => router.push(n.href)} aria-current={active(n) ? 'page' : undefined}>
                    <Icon name={n.icon} />{n.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sb-user">
            <Avatar name={user.name} brand />
            <div className="who"><b>{user.name}</b><span>{ROLE_LABEL[user.role]}{user.capabilityLabels.length ? ` + ${user.capabilityLabels.length}` : ''}</span></div>
            <Button variant="ghost" size="sm" icon="exit" aria-label="Sign out" title="Sign out" onClick={signOut} />
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div className="crumb"><b>{here}</b></div>
            <span className="spacer" />
            <div style={{ position: 'relative' }}>
              <Button variant="ghost" icon="bell" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} onClick={() => router.push('/notifications')} />
              {unread > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: 'var(--brand-fill)', color: '#fff', fontSize: 10, lineHeight: '16px', textAlign: 'center' }}>{unread > 99 ? '99+' : unread}</span>}
            </div>
            <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
              <Button icon="user" onClick={() => setMenu(!menu)}>{ROLE_LABEL[user.role]}{user.modes.length > 1 && <Icon name="updown" />}</Button>
              {menu && (
                <div className="card strong popover" role="menu" aria-label="Acting as">
                  <div className="eyebrow" style={{ padding: '4px 8px 8px' }}>Acting as</div>
                  {user.modes.map(m => (
                    <button key={m} role="menuitemradio" aria-checked={m === user.role} className={`nav-item ${m === user.role ? 'active' : ''}`} onClick={() => switchTo(m)} disabled={busy}>
                      {ROLE_LABEL[m]}{m === user.role && <Icon name="check" />}
                    </button>
                  ))}
                  {user.modes.length === 1 && <div className="subtle body-sm" style={{ padding: '4px 8px' }}>You hold one role.</div>}
                  <div style={{ borderTop: '1px solid var(--line)', marginTop: 6, paddingTop: 6 }}>
                    <button className="nav-item" onClick={() => router.push('/change-password')}><Icon name="lock" />Change password</button>
                    <button className="nav-item" onClick={signOut}><Icon name="exit" />Sign out</button>
                  </div>
                </div>
              )}
            </div>
          </header>
          <main className="page" id="main">{children}</main>
        </div>
      </div>

      <nav className="tabbar" aria-label="Mobile navigation">
        {nav.slice(0, 5).map(n => <button key={n.id} className={active(n) ? 'active' : ''} onClick={() => router.push(n.href)}><Icon name={n.icon} size={20} />{n.label.split(' ')[0]}</button>)}
        <button onClick={signOut}><Icon name="exit" size={20} />Sign out</button>
      </nav>
    </div>
  )
}
