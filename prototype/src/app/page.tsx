import Link from 'next/link'
import { PERSONAS, ROLE_LABEL } from '../roles'

export default function Landing() {
  const groups: { title: string; ids: string[] }[] = [
    { title: 'Admin and approvers', ids: ['p-aa', 'p-pa', 'p-backup', 'p-sa', 'p-aa2'] },
    { title: 'Operations', ids: ['p-rec', 'p-hk', 'p-mc', 'p-tech', 'p-vend', 'p-sec'] },
    { title: 'Residents (each at a different point of the journey)', ids: ['p-res-none', 'p-res-applied', 'p-res-waitlist', 'p-res-offer', 'p-res-reserved', 'p-res-staying', 'p-res-out'] },
    { title: 'Oversight', ids: ['p-mgr', 'p-aud'] },
  ]
  return (
    <div className="gh-canvas">
      <div className="login" style={{ alignItems: 'start' }}>
        <div style={{ width: 'min(960px,100%)', paddingTop: 24 }}>
          <div className="card strong" style={{ padding: 28 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/grand-hyatt-logo.jpg" alt="Grand Hyatt" width={180} style={{ display: 'block', marginBottom: 16 }} />
            <div className="eyebrow">Staff Accommodation Platform · Phase 1</div>
            <h1 style={{ margin: '4px 0 8px' }}>Clickable prototype</h1>
            <p className="muted" style={{ maxWidth: 640 }}>Dummy data, in-memory state and a demo clock. There is no real sign-in, database or notification (D-100). Pick a role to see its home screen. Business rules run for real, so approvals, allocation conflicts, timers and escalations behave as specified.</p>
          </div>
          {groups.map(g => (
            <section key={g.title} style={{ marginTop: 20 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>{g.title}</div>
              <div className="grid three">
                {g.ids.map(id => {
                  const p = PERSONAS.find(x => x.id === id)!
                  return (
                    <Link key={id} href={`/${id}/dashboard`} className="card" style={{ padding: 14, textDecoration: 'none', color: 'inherit', display: 'block' }}>
                      <b style={{ fontWeight: 500 }}>{p.name}</b>
                      <div className="muted body-sm">{p.title}</div>
                      <div className="subtle body-sm" style={{ marginTop: 4 }}>{ROLE_LABEL[p.role]}{p.caps.length ? ` + ${p.caps.length} capability` : ''}</div>
                    </Link>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
